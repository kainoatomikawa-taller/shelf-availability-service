import type { RetailerId } from '../domain/common/ids.js';
import { DAY, instant, millis, type Instant, type Millis } from '../domain/common/time.js';
import type { RetailerPartitioned } from '../domain/common/partition.js';
import type { AuditRetentionPolicy } from '../ports/inbound/audit-export.port.js';

/**
 * How long each kind of retained data lives.
 *
 * Retention is stated per *data class* rather than per table, because the reason
 * a thing is kept is what decides how long it is kept, and two tables can share a
 * reason. A raw vendor payload sitting in a dead-letter queue is kept so its
 * producer's owner can reproduce a failure; a sealed audit artifact is kept
 * because a retailer may have to show it to a third party a year later. Those are
 * different obligations with different exposure, and collapsing them into one
 * number gets one of them wrong in whichever direction the number was chosen.
 *
 * The horizons below are a mapped type over `DataClass`, so adding a class is a
 * compile error until someone decides how long it lives — the alternative being a
 * new table that silently inherits "keep forever", which is the default that
 * every retention incident starts from.
 */

export type DataClass =
  /** Detection events as ingested, with the producer instance and build behind them. */
  | 'detection_event'
  /** The per-facing, time-ordered state log the availability index is integrated from. */
  | 'facing_history'
  /** Idempotency keys, which is what makes a broker replay a no-op. */
  | 'ingestion_ledger'
  /** Tasks and their lifecycle transitions. */
  | 'task_record'
  /** One row per gap, carrying the loop's own outcome timings. */
  | 'outcome_record'
  /** Precomputed availability rollups behind the read side. */
  | 'read_model_rollup'
  /** Who did what to which task, and when. */
  | 'audit_trail'
  /** Sealed, content-addressed audit exports. */
  | 'audit_artifact'
  /** Records that could not become detection events, kept verbatim as evidence. */
  | 'dead_letter';

export const DATA_CLASSES = [
  'detection_event',
  'facing_history',
  'ingestion_ledger',
  'task_record',
  'outcome_record',
  'read_model_rollup',
  'audit_trail',
  'audit_artifact',
  'dead_letter',
] as const satisfies readonly DataClass[];

export type RetentionHorizons = { readonly [C in DataClass]: Millis };

export class RetentionConfigError extends Error {
  readonly code = 'RETENTION_CONFIG' as const;

  constructor(message: string) {
    super(message);
    this.name = 'RetentionConfigError';
  }
}

const days = (count: number): Millis => millis(count * DAY);

/**
 * The default horizons for a pilot.
 *
 * Chosen against a 9–15 month pilot window, and the shape is deliberate: the
 * things that carry a vendor's raw payload expire first, the derived state a
 * report is computed from outlives the whole window so no month of the pilot
 * becomes unreportable, and a sealed artifact outlives the pilot itself because
 * that is what it exists for.
 */
export const STANDARD_RETENTION_HORIZONS: RetentionHorizons = {
  // Long enough to reprocess a bad interpretation policy and to answer a
  // producer's "what did you receive from us"; short enough that the most
  // sensitive thing retained is also the thing retained briefest.
  detection_event: days(90),
  // Covers a 15-month pilot plus a quarter, so the index can be recomputed over
  // any window of the pilot rather than only recent ones.
  facing_history: days(550),
  // Must outlive the broker's own topic retention, or a replayed partition would
  // be re-ingested as new events. Checked against the bus in `assertBusRetentionFits`.
  ingestion_ledger: days(30),
  task_record: days(550),
  outcome_record: days(400),
  read_model_rollup: days(400),
  audit_trail: days(550),
  // Outlives the pilot: an artifact is the thing a retailer shows a third party
  // after the engagement has ended.
  audit_artifact: days(1_100),
  // The shortest horizon in the table, on purpose. A dead letter is a verbatim
  // vendor payload, so it is the least sanitised thing this service stores.
  dead_letter: days(14),
};

export interface RetentionPolicy extends RetailerPartitioned {
  readonly retailerId: RetailerId;
  readonly horizons: RetentionHorizons;
  /**
   * Suspends expiry entirely.
   *
   * One flag rather than a per-class override: a legal hold is not a retention
   * decision but the absence of one, and expressing it as "some classes expire
   * and some do not" is how the class under dispute turns out to be one of the
   * ones that expired.
   */
  readonly legalHold: boolean;
}

export const standardRetention = (retailerId: RetailerId): RetentionPolicy => ({
  retailerId,
  horizons: STANDARD_RETENTION_HORIZONS,
  legalHold: false,
});

export const horizonOf = (policy: RetentionPolicy, dataClass: DataClass): Millis =>
  policy.horizons[dataClass];

/**
 * The earliest instant still retained for one data class.
 *
 * Floored at `onboardedAt`, because a horizon longer than the relationship does
 * not conjure data: reporting a retained-from instant before the retailer existed
 * would have the audit export claim a period it was never measuring as merely
 * empty.
 */
export const retainedFrom = (
  policy: RetentionPolicy,
  dataClass: DataClass,
  onboardedAt: Instant,
  now: Instant,
): Instant => {
  if (policy.legalHold) return onboardedAt;
  const horizon = now - policy.horizons[dataClass];
  return instant(Math.max(onboardedAt, horizon));
};

/**
 * Pairs read "the first must be retained at least as long as the second".
 *
 * Each one exists because the reverse produces a specific, silent wrongness
 * rather than merely being untidy.
 */
const RETENTION_LADDER: readonly (readonly [DataClass, DataClass, string])[] = [
  [
    'facing_history',
    'detection_event',
    'the state log is what reports are integrated from; expiring it first would leave raw events nobody can turn back into a number',
  ],
  [
    'audit_artifact',
    'facing_history',
    'a sealed artifact is self-substantiating and is the record that outlives the pilot',
  ],
  [
    'audit_trail',
    'facing_history',
    'who acted on a shelf must be answerable for at least as long as what happened to it',
  ],
  [
    'facing_history',
    'read_model_rollup',
    'nothing may be reported that can no longer be recomputed from retained history',
  ],
  [
    'task_record',
    'outcome_record',
    'an outcome row cohorts a task; the task must outlive the metric computed from it',
  ],
  [
    'detection_event',
    'dead_letter',
    'a verbatim vendor payload must not outlive the events it failed to become',
  ],
];

export function assertRetentionIsCoherent(policy: RetentionPolicy): RetentionPolicy {
  for (const dataClass of DATA_CLASSES) {
    const horizon = policy.horizons[dataClass];
    if (!(horizon > 0)) {
      throw new RetentionConfigError(
        `Retention for "${dataClass}" in retailer "${policy.retailerId}" must be positive, got ${horizon}ms`,
      );
    }
  }

  for (const [longer, shorter, why] of RETENTION_LADDER) {
    if (policy.horizons[longer] < policy.horizons[shorter]) {
      throw new RetentionConfigError(
        `Retention for retailer "${policy.retailerId}" keeps "${shorter}" (${policy.horizons[shorter]}ms) longer than "${longer}" (${policy.horizons[longer]}ms): ${why}`,
      );
    }
  }

  return policy;
}

/**
 * The retention policy as the audit-export port states it.
 *
 * `eventRetention` maps to `facing_history`, not to `detection_event`: an audit
 * export is assembled from the facing state log, so the honest answer to "how far
 * back can you export" is how long that log is kept. Answering with the detection
 * horizon would under-report exportability by more than a year.
 */
export const auditRetentionOf = (
  policy: RetentionPolicy,
  onboardedAt: Instant,
  now: Instant,
): AuditRetentionPolicy => ({
  retailerId: policy.retailerId,
  eventRetention: policy.horizons.facing_history,
  artifactRetention: policy.horizons.audit_artifact,
  retainedFrom: retainedFrom(policy, 'facing_history', onboardedAt, now),
});

/**
 * The horizon ingestion refuses observations before.
 *
 * This is the value behind the port's `observation_outside_retention` rejection:
 * accepting an observation older than what will be retained would write an event
 * the next expiry sweep deletes, and report a shelf state nothing substantiates.
 */
export const ingestionHorizon = (
  policy: RetentionPolicy,
  onboardedAt: Instant,
  now: Instant,
): Instant => retainedFrom(policy, 'detection_event', onboardedAt, now);
