import type { AuditLogEntry } from '../../domain/audit/audit-log.js';
import type { FacingId, ProductId, RetailerId, SignalId, StoreId } from '../../domain/common/ids.js';
import type { RetailerPartitioned } from '../../domain/common/partition.js';
import type { Instant, Millis, TimeWindow } from '../../domain/common/time.js';
import type { Facing } from '../../domain/facing/facing.js';
import type { MerchandisingClassification } from '../../domain/merchandising/classification.js';
import type { LoopOutcomeRecord } from '../../application/outcome-metrics.js';

/**
 * What the read side needs retained, and nothing more.
 *
 * The seam is deliberately narrow and deliberately *not* a query language. Every
 * method here answers one question the reporting and audit-export ports actually
 * ask, in the domain's own vocabulary, which keeps the rollups, the percentiles,
 * the cohorting and the index arithmetic in code that can be read and tested
 * rather than in SQL that has to be trusted. A Postgres implementation of this
 * interface fetches rows; it does not decide what a number means.
 *
 * Everything is scoped by retailer at the signature, so there is no shape here
 * that can express a question spanning two of them.
 */

/** A facing with the classification the reports are cut by. */
export interface ReportingFacing extends RetailerPartitioned {
  readonly retailerId: RetailerId;
  readonly facing: Facing;
  readonly classification: MerchandisingClassification;
}

/** Narrowing applied before anything is folded. */
export interface FacingSelector {
  readonly retailerId: RetailerId;
  /** `null` covers every store in the partition. */
  readonly storeIds: readonly StoreId[] | null;
  /** `null` covers every SKU. */
  readonly productIds: readonly ProductId[] | null;
  readonly window: TimeWindow;
}

/** Which producer instance and build stood behind one signal, when it was retained. */
export interface SignalProvenance {
  readonly instanceId: string | null;
  readonly softwareVersion: string | null;
}

export interface ReportingReadModel {
  /**
   * Facings in scope, each with the history the window is integrated over.
   *
   * The whole facing, not a pre-aggregated row: the index, the per-facing
   * records and the audit export are three views of the same step function, and
   * three separately-summarised sources for them is how the number in a report
   * stops matching the number in the artifact that is supposed to substantiate it.
   */
  facings(selector: FacingSelector): Promise<readonly ReportingFacing[]>;

  /** Loop outcome records the loop wrote, cohorted downstream by detection instant. */
  outcomeRecords(retailerId: RetailerId, window: TimeWindow): Promise<readonly LoopOutcomeRecord[]>;

  /** The retailer's action trail for the period. */
  auditEntries(retailerId: RetailerId, window: TimeWindow): Promise<readonly AuditLogEntry[]>;

  /**
   * Labour hours the retailer's workforce feed reported, or `null` when that
   * feed is not connected. The service never estimates this.
   */
  labourHours(
    retailerId: RetailerId,
    storeIds: readonly StoreId[] | null,
    window: TimeWindow,
  ): Promise<number | null>;

  /**
   * Producer instance and build behind each signal, for the audit export.
   *
   * "Which camera said this, on which build" is the first question asked when a
   * retailer disputes a gap, and it is unanswerable after the fact if it was not
   * retained — so it is asked for explicitly rather than assumed absent. Signals
   * whose provenance aged out are simply missing from the map.
   */
  signalProvenance(
    retailerId: RetailerId,
    signalIds: readonly SignalId[],
  ): Promise<ReadonlyMap<SignalId, SignalProvenance>>;

  /**
   * Sub-periods with no retained evidence for any facing in scope.
   *
   * Declared rather than inferred. An export that quietly omits an ingestion
   * outage lets an auditor recompute a different number with no way to tell
   * whether the service or the export is wrong.
   */
  unobservedIntervals(
    retailerId: RetailerId,
    storeIds: readonly StoreId[] | null,
    window: TimeWindow,
  ): Promise<readonly TimeWindow[]>;

  /** Facings in scope whose history could not be retrieved in full. */
  incompleteFacings(
    retailerId: RetailerId,
    storeIds: readonly StoreId[] | null,
    window: TimeWindow,
  ): Promise<readonly FacingId[]>;

  /** What is still exportable, so "no data" can be told from "aged out". */
  retention(retailerId: RetailerId): Promise<{
    readonly eventRetention: Millis;
    readonly artifactRetention: Millis;
    readonly retainedFrom: Instant;
  }>;
}
