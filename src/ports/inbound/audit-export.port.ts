import type { Brand } from '../../domain/common/brand.js';
import type {
  EventId,
  FacingId,
  ProductId,
  RetailerId,
  SignalId,
  StoreId,
} from '../../domain/common/ids.js';
import type { RetailerPartitioned } from '../../domain/common/partition.js';
import type { Instant, Millis, TimeWindow } from '../../domain/common/time.js';
import type { AuditLogEntry } from '../../domain/audit/audit-log.js';
import type { FacingLocation } from '../../domain/facing/facing.js';
import type { ShelfState } from '../../domain/facing/shelf-state.js';
import type { Confidence, SignalSource } from '../../domain/facing/signals.js';
import type { Page, PageRequest } from '../common/paging.js';
import type { SchemaContract } from '../common/schema-contract.js';

/**
 * Audit artifact export — the attestable read boundary.
 *
 * Types only: no behaviour lives here.
 *
 * The contract this port exists to keep: **an auditor holding an export can
 * recompute the reported availability index and get the same number.** That
 * demands three things of every record, and the shapes below are built around
 * them — the state each facing carried into the period, every timestamped
 * transition inside it, and the evidence that caused each transition. Anything
 * less is a summary the retailer has to take on trust.
 */

export type AuditArtifactId = Brand<string, 'AuditArtifactId'>;

export type AuditExportSchemaVersion = '1.0';

export const CURRENT_AUDIT_EXPORT_SCHEMA_VERSION: AuditExportSchemaVersion = '1.0';

export const AUDIT_EXPORT_SCHEMA_CONTRACT: SchemaContract = {
  schemaName: 'osa.audit-export',
  current: CURRENT_AUDIT_EXPORT_SCHEMA_VERSION,
  supported: [CURRENT_AUDIT_EXPORT_SCHEMA_VERSION],
  sunsets: [],
  encoding: {
    transport: 'json',
    timestamps: 'iso-8601-utc',
    identifiers: 'opaque-utf8-string',
    ratios: 'decimal-0-to-1',
    durations: 'integer-milliseconds',
  },
  unknownFields: 'ignore',
};

export interface AuditExportScope extends RetailerPartitioned {
  /** Partition key. Audit trails are retailer-scoped end to end. */
  readonly retailerId: RetailerId;
  /** The reported period, half-open `[from, to)`. */
  readonly period: TimeWindow;
  /** Per SKU. `null` covers every product. */
  readonly productIds: readonly ProductId[] | null;
  /** `null` covers every store in the partition. */
  readonly storeIds: readonly StoreId[] | null;
}

/**
 * One timestamped facing-state transition, with the evidence behind it.
 *
 * The producer is carried alongside the domain cause because "which camera said
 * this, on which build" is the first question asked when a retailer disputes a
 * gap, and it is unanswerable after the fact if it was not retained.
 */
export interface AuditedTransition {
  readonly eventId: EventId;
  /** Monotonic per facing; disambiguates transitions sharing an instant. */
  readonly sequence: number;
  readonly at: Instant;
  readonly from: ShelfState;
  readonly to: ShelfState;
  readonly source: SignalSource;
  readonly signalId: SignalId;
  readonly confidence: Confidence;
  /** Producer instance and build, when retained for this event. */
  readonly producerInstanceId: string | null;
  readonly producerSoftwareVersion: string | null;
}

/**
 * Everything needed to reconstruct one facing's contribution to the index.
 *
 * `stateAtPeriodStart` plus `transitions` is the complete step function over the
 * period; `reportedInStockMillis` and friends are what the service itself
 * computed from it, so a verifier can recompute and compare rather than having to
 * trust the totals.
 */
export interface FacingStateAuditRecord extends RetailerPartitioned {
  readonly retailerId: RetailerId;
  readonly storeId: StoreId;
  readonly facingId: FacingId;
  readonly productId: ProductId;
  readonly location: FacingLocation;
  readonly period: TimeWindow;
  /** Carry-in state. Without it the first segment of the period is unaccountable. */
  readonly stateAtPeriodStart: ShelfState;
  /** Every transition inside the period, ascending by `at`. */
  readonly transitions: readonly AuditedTransition[];
  readonly reportedInStockMillis: Millis;
  readonly reportedOutOfStockMillis: Millis;
  readonly reportedUnknownMillis: Millis;
  readonly reportedMeasuredMillis: Millis;
  /** The index this facing contributed, as reported. */
  readonly reportedIndex: number | null;
}

/** Tamper evidence over an exported artifact. */
export interface AuditIntegrity {
  readonly algorithm: 'sha-256';
  /** Hash of the artifact body in its declared format, hex encoded. */
  readonly contentHash: string;
  /** Detached signature over `contentHash`, when the retailer's plan includes signing. */
  readonly signature: string | null;
  readonly signedBy: string | null;
}

/**
 * Declared limits of the export.
 *
 * An export that quietly omits what it could not retrieve is worse than no
 * export: the auditor recomputes a different number and cannot tell whether the
 * service or the export is wrong. Known gaps are stated instead.
 */
export interface AuditCompleteness {
  readonly facingCount: number;
  readonly transitionCount: number;
  readonly sourcesRepresented: readonly SignalSource[];
  /**
   * Sub-periods with no retained evidence for any facing in scope — an ingestion
   * outage, say. Time here is `unknown` in the index, not in-stock.
   */
  readonly unobservedIntervals: readonly TimeWindow[];
  /** Facings in scope whose history could not be retrieved in full. */
  readonly incompleteFacings: readonly FacingId[];
}

export interface AuditRetentionPolicy extends RetailerPartitioned {
  readonly retailerId: RetailerId;
  /** How long facing-state events are retained and remain exportable. */
  readonly eventRetention: Millis;
  /** How long sealed artifacts remain retrievable. */
  readonly artifactRetention: Millis;
  /** Earliest instant still exportable. Scopes reaching further back are truncated. */
  readonly retainedFrom: Instant;
}

/** Serialisation of a sealed artifact body. */
export type AuditArtifactFormat = 'application/json' | 'application/x-ndjson' | 'text/csv';

export interface AuditArtifactRetrieval {
  readonly format: AuditArtifactFormat;
  readonly byteSize: number;
  /** Opaque handle the adapter resolves to a stream or signed download. */
  readonly handle: string;
  readonly availableUntil: Instant;
}

/**
 * A sealed, retrievable export.
 *
 * The manifest is returned inline; the body is fetched through `retrieval`,
 * because a period-length export across a full estate is far too large to hold in
 * a response. The body, once fetched, is exactly the records
 * `exportFacingStateLog` yields for the same scope — one artifact, two access
 * patterns, no second source of truth.
 */
export interface AuditExportArtifact extends RetailerPartitioned {
  readonly artifactId: AuditArtifactId;
  readonly retailerId: RetailerId;
  readonly schemaVersion: AuditExportSchemaVersion;
  readonly scope: AuditExportScope;
  readonly generatedAt: Instant;
  /**
   * The index as reported for this scope — the figure the artifact exists to
   * substantiate.
   */
  readonly reportedIndex: {
    readonly index: number | null;
    readonly coverage: number;
    readonly inStockFacingMillis: Millis;
    readonly measuredFacingMillis: Millis;
    readonly facingCount: number;
  };
  readonly completeness: AuditCompleteness;
  readonly integrity: AuditIntegrity;
  readonly retrieval: AuditArtifactRetrieval;
  readonly retainedUntil: Instant;
}

export interface AuditExportRequest {
  readonly scope: AuditExportScope;
  readonly format: AuditArtifactFormat;
  /** Include the action trail alongside the facing-state log. */
  readonly includeActionTrail: boolean;
}

export interface FacingStateLogQuery {
  readonly scope: AuditExportScope;
  readonly page: PageRequest;
}

export interface AuditTrailQuery {
  readonly scope: AuditExportScope;
  readonly page: PageRequest;
}

/**
 * Inbound port for audit artifact export.
 *
 * Implementations must be deterministic for a closed period: the same scope
 * exported twice yields the same records and the same `contentHash`. An auditor
 * re-running an export months later has to get the artifact they were shown.
 */
export interface AuditExportPort {
  /**
   * The time-stamped facing-state event log for the scope, per SKU and period,
   * paged. This is the direct, inspectable form of the export.
   */
  exportFacingStateLog(query: FacingStateLogQuery): Promise<Page<FacingStateAuditRecord>>;

  /**
   * The action trail — who dispatched, resolved and verified what — using the
   * domain's own audit entries.
   */
  exportAuditTrail(query: AuditTrailQuery): Promise<Page<AuditLogEntry>>;

  /**
   * Seals the scope into a retained, hash-addressed artifact and returns its
   * manifest.
   */
  sealArtifact(request: AuditExportRequest): Promise<AuditExportArtifact>;

  /** Re-reads a previously sealed artifact's manifest, for re-verification. */
  getArtifact(
    retailerId: RetailerId,
    artifactId: AuditArtifactId,
  ): Promise<AuditExportArtifact | null>;

  /** What is still exportable, so a caller can tell "no data" from "aged out". */
  describeRetentionPolicy(retailerId: RetailerId): Promise<AuditRetentionPolicy>;

  /** The versioning contract for the export schema. */
  describeSchemaContract(): Promise<SchemaContract>;
}
