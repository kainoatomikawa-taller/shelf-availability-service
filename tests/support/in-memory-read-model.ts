import {
  DAY,
  millis,
  type AuditLogEntry,
  type FacingId,
  type FacingSelector,
  type Instant,
  type Millis,
  type ReportingFacing,
  type ReportingReadModel,
  type RetailerId,
  type SignalId,
  type SignalProvenance,
  type StoreId,
  type TimeWindow,
} from '../../src/index.js';
import type { LoopOutcomeRecord } from '../../src/index.js';

/**
 * A retained read model held in process.
 *
 * Faithful on the two things that matter: it partitions by retailer, and it
 * narrows by the selector rather than handing back everything and letting the
 * adapter filter. A double that ignored the selector would let a scoping bug in
 * the adapter pass, which is the one bug a read-side test exists to catch.
 */
export class InMemoryReadModel implements ReportingReadModel {
  readonly facingRows: ReportingFacing[] = [];
  readonly outcomes: LoopOutcomeRecord[] = [];
  readonly audit: AuditLogEntry[] = [];
  readonly provenance = new Map<SignalId, SignalProvenance>();
  outages: readonly TimeWindow[] = [];
  incomplete: readonly FacingId[] = [];
  labour: number | null = null;
  retainedFrom: Instant;
  eventRetention: Millis = millis(365 * DAY);
  artifactRetention: Millis = millis(7 * 365 * DAY);

  constructor(retainedFrom: Instant) {
    this.retainedFrom = retainedFrom;
  }

  withFacings(...rows: readonly ReportingFacing[]): this {
    this.facingRows.push(...rows);
    return this;
  }

  withOutcomes(...records: readonly LoopOutcomeRecord[]): this {
    this.outcomes.push(...records);
    return this;
  }

  async facings(selector: FacingSelector): Promise<readonly ReportingFacing[]> {
    return this.facingRows.filter(
      (row) =>
        row.retailerId === selector.retailerId &&
        (selector.storeIds === null || selector.storeIds.includes(row.facing.storeId)) &&
        (selector.productIds === null || selector.productIds.includes(row.facing.productId)),
    );
  }

  async outcomeRecords(
    retailerId: RetailerId,
    _window: TimeWindow,
  ): Promise<readonly LoopOutcomeRecord[]> {
    return this.outcomes.filter((record) => record.retailerId === retailerId);
  }

  async auditEntries(
    retailerId: RetailerId,
    window: TimeWindow,
  ): Promise<readonly AuditLogEntry[]> {
    return this.audit.filter(
      (entry) =>
        entry.retailerId === retailerId && entry.at >= window.from && entry.at < window.to,
    );
  }

  async labourHours(
    _retailerId: RetailerId,
    _storeIds: readonly StoreId[] | null,
    _window: TimeWindow,
  ): Promise<number | null> {
    return this.labour;
  }

  async signalProvenance(
    _retailerId: RetailerId,
    signalIds: readonly SignalId[],
  ): Promise<ReadonlyMap<SignalId, SignalProvenance>> {
    const found = new Map<SignalId, SignalProvenance>();
    for (const id of signalIds) {
      const entry = this.provenance.get(id);
      if (entry !== undefined) found.set(id, entry);
    }
    return found;
  }

  async unobservedIntervals(): Promise<readonly TimeWindow[]> {
    return this.outages;
  }

  async incompleteFacings(): Promise<readonly FacingId[]> {
    return this.incomplete;
  }

  async retention(_retailerId: RetailerId): Promise<{
    readonly eventRetention: Millis;
    readonly artifactRetention: Millis;
    readonly retainedFrom: Instant;
  }> {
    return {
      eventRetention: this.eventRetention,
      artifactRetention: this.artifactRetention,
      retainedFrom: this.retainedFrom,
    };
  }
}
