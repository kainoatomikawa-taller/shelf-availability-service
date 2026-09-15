import { createHash } from 'node:crypto';
import type { RetailerId } from '../../domain/common/ids.js';
import { toISO } from '../../domain/common/time.js';
import type {
  AuditArtifactFormat,
  AuditArtifactId,
  AuditExportArtifact,
  FacingStateAuditRecord,
} from '../../ports/inbound/audit-export.port.js';

/**
 * Sealing an export into something an auditor can be handed.
 *
 * The contract the whole module serves: **the same scope exported twice yields
 * the same bytes and the same hash.** An auditor re-running an export months
 * later has to get the artifact they were shown, which rules out anything
 * incidental leaking into the body — map iteration order, the instant the export
 * ran, the order rows came back from a store. Everything below is sorted and
 * canonicalised for that reason and no other.
 */

/**
 * JSON with keys in a fixed order, recursively.
 *
 * `JSON.stringify` preserves insertion order, which means two runs that built
 * the same record with its fields assigned in a different order produce different
 * bytes and therefore a different hash — a spurious tamper signal. Sorting keys
 * removes the question.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

/**
 * Sorts records into the one order an export is ever written in.
 *
 * Store, then facing: a human reading a CSV export walks the building, and an
 * auditor diffing two exports of the same period needs the rows to line up.
 */
export const sortAuditRecords = (
  records: readonly FacingStateAuditRecord[],
): readonly FacingStateAuditRecord[] =>
  [...records].sort(
    (a, b) => a.storeId.localeCompare(b.storeId) || a.facingId.localeCompare(b.facingId),
  );

const CSV_COLUMNS = [
  'retailerId',
  'storeId',
  'facingId',
  'productId',
  'aisle',
  'bay',
  'shelf',
  'position',
  'periodFrom',
  'periodTo',
  'stateAtPeriodStart',
  'transitionCount',
  'inStockMillis',
  'outOfStockMillis',
  'unknownMillis',
  'measuredMillis',
  'index',
] as const;

/** RFC 4180 quoting: identifiers are opaque strings and may contain anything. */
const csvCell = (value: string | number | null): string => {
  const text = value === null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

/**
 * Renders the sealed body.
 *
 * CSV is the one lossy format and is honest about it: a facing's transitions
 * cannot be a cell, so the CSV carries the per-facing totals and their count, and
 * an auditor who needs to recompute rather than reconcile asks for JSON or
 * NDJSON. Offering CSV at all is a concession to the spreadsheet every retail
 * finance team actually audits in.
 */
export function renderArtifactBody(
  records: readonly FacingStateAuditRecord[],
  format: AuditArtifactFormat,
): string {
  const sorted = sortAuditRecords(records);

  switch (format) {
    case 'application/json':
      return canonicalJson(sorted);

    case 'application/x-ndjson':
      return sorted.map((record) => canonicalJson(record)).join('\n');

    case 'text/csv':
      return [
        CSV_COLUMNS.join(','),
        ...sorted.map((record) =>
          [
            record.retailerId,
            record.storeId,
            record.facingId,
            record.productId,
            record.location.aisle,
            record.location.bay,
            record.location.shelf,
            record.location.position,
            toISO(record.period.from),
            toISO(record.period.to),
            record.stateAtPeriodStart,
            record.transitions.length,
            record.reportedInStockMillis,
            record.reportedOutOfStockMillis,
            record.reportedUnknownMillis,
            record.reportedMeasuredMillis,
            record.reportedIndex,
          ]
            .map(csvCell)
            .join(','),
        ),
      ].join('\n');
  }
}

/** Hex sha-256 over the rendered body, matching `AuditIntegrity.algorithm`. */
export const sha256 = (body: string): string =>
  createHash('sha256').update(body, 'utf8').digest('hex');

/**
 * Signs the content hash, when the retailer's plan includes signing.
 *
 * A seam rather than an implementation: signing keys belong to whatever holds the
 * retailer's secrets, and a domain package is emphatically not that.
 */
export interface AuditSigner {
  readonly signedBy: string;
  sign(contentHash: string): Promise<string>;
}

/**
 * Where sealed bodies live between being written and being fetched.
 *
 * Two operations, because the manifest and the body are two access patterns over
 * one artifact: `sealArtifact` returns the manifest inline and the body is
 * fetched through a handle, since a period-length export across a full estate is
 * far too large for a response.
 */
export interface AuditArtifactStore {
  put(
    retailerId: RetailerId,
    artifactId: AuditArtifactId,
    body: string,
    format: AuditArtifactFormat,
  ): Promise<{ readonly handle: string; readonly byteSize: number }>;

  putManifest(manifest: AuditExportArtifact): Promise<void>;

  getManifest(
    retailerId: RetailerId,
    artifactId: AuditArtifactId,
  ): Promise<AuditExportArtifact | null>;
}

/**
 * Artifacts held in process. Faithful enough to be worth testing against —
 * partitioned by retailer, bodies kept verbatim — and emphatically not a store.
 */
export class InMemoryAuditArtifactStore implements AuditArtifactStore {
  private readonly bodies = new Map<string, string>();
  private readonly manifests = new Map<string, AuditExportArtifact>();

  private key(retailerId: RetailerId, artifactId: AuditArtifactId): string {
    return `${retailerId}|${artifactId}`;
  }

  async put(
    retailerId: RetailerId,
    artifactId: AuditArtifactId,
    body: string,
  ): Promise<{ readonly handle: string; readonly byteSize: number }> {
    const key = this.key(retailerId, artifactId);
    this.bodies.set(key, body);
    return { handle: `memory://${key}`, byteSize: Buffer.byteLength(body, 'utf8') };
  }

  async putManifest(manifest: AuditExportArtifact): Promise<void> {
    this.manifests.set(this.key(manifest.retailerId, manifest.artifactId), manifest);
  }

  async getManifest(
    retailerId: RetailerId,
    artifactId: AuditArtifactId,
  ): Promise<AuditExportArtifact | null> {
    return this.manifests.get(this.key(retailerId, artifactId)) ?? null;
  }

  /** The sealed body, for tests that verify the hash covers what was written. */
  body(retailerId: RetailerId, artifactId: AuditArtifactId): string | null {
    return this.bodies.get(this.key(retailerId, artifactId)) ?? null;
  }
}
