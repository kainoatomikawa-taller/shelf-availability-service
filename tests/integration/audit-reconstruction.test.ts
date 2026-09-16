import { describe, expect, it } from 'vitest';
import {
  CURRENT_AUDIT_EXPORT_SCHEMA_VERSION,
  canonicalJson,
  sha256,
  timeWindow,
  type AuditExportScope,
  type DetectionSource,
  type FacingStateAuditRecord,
  type Instant,
  type PageCursor,
  type ReportScope,
  type ShelfState,
  type StoreId,
  type TimeWindow,
} from '../../src/index.js';
import { hour } from '../support/fixtures.js';
import { wireFor, type StockClaim } from '../support/producer-wire.js';
import {
  ACME_STORE,
  ACME_STORE_TWO,
  OAT_MILK,
  facingRef,
  twoRetailerPilot,
} from '../support/pilot-fixtures.js';
import type { Pilot, RetailerHarness } from '../support/pilot-harness.js';

/**
 * Reproducibility: can the retained event log rebuild the number we published?
 *
 * This is the commitment the audit export exists to keep, and it is checked here
 * end to end rather than at the type level: **an auditor holding nothing but the
 * retained log can recompute the reported availability index, for any measurement
 * period, and get the figure the retailer was shown.**
 *
 * It is worth proving now, while the engagement's commercial terms are still a
 * fixed pilot fee and nothing anybody is paid depends on the index. An index that
 * only its author can compute is a number a retailer has to take on trust, and
 * the moment it becomes the basis of an outcome-linked term, "trust us" stops
 * being an acceptable answer and the cost of discovering it was never
 * reconstructible lands in the middle of a commercial dispute. Demonstrating
 * reconstruction *before* that point is the cheap half of this; discovering it
 * afterwards is the expensive half.
 *
 * Three independent claims, and they fail differently:
 *
 *  1. **The export is sufficient.** `reconstructIndex` below reads nothing but
 *     the exported records and is written from the record's documented meaning
 *     rather than by calling the domain — so a field the service needs but does
 *     not export makes it disagree.
 *  2. **The log is sufficient.** A second, empty deployment fed the producers'
 *     original bytes arrives at the same histories, the same index and the same
 *     content hash — so anything the service learned and did not retain makes it
 *     disagree.
 *  3. **The answer is stable.** The same scope exported twice is the same bytes,
 *     so an auditor re-running an export months later gets the artifact they were
 *     shown.
 */

const DAY_WINDOW = timeWindow(hour(0), hour(24));

/**
 * A day of shelf traffic across two stores, written as producer events.
 *
 * Deliberately awkward in the ways a real day is: several sources, facings that
 * change state more than once, one facing that never changes at all (so its whole
 * contribution rests on carry-in state), and a gap that is still open when the
 * period closes.
 */
interface ScheduledEvent {
  readonly source: DetectionSource;
  readonly store: StoreId;
  readonly position: number;
  readonly at: Instant;
  readonly claim: StockClaim;
}

const SCHEDULE: readonly ScheduledEvent[] = [
  // Store one, facing one: empty mid-morning, refilled before lunch.
  { source: 'arpalus_detection', store: ACME_STORE, position: 1, at: hour(8), claim: 'out_of_stock' },
  { source: 'caper_frame', store: ACME_STORE, position: 1, at: hour(11), claim: 'in_stock' },
  // Store one, facing two: out early, back by nine, and out again at eight in the
  // evening — still open when the day closes.
  { source: 'shopper_scan', store: ACME_STORE, position: 2, at: hour(6), claim: 'out_of_stock' },
  { source: 'arpalus_detection', store: ACME_STORE, position: 2, at: hour(9), claim: 'in_stock' },
  { source: 'pos_movement', store: ACME_STORE, position: 2, at: hour(20), claim: 'out_of_stock' },
  // Store two, facing one: nothing at all happened. Its entire contribution to
  // the index is the state it carried into the period.
  // Store two, facing two: a short afternoon gap.
  { source: 'caper_frame', store: ACME_STORE_TWO, position: 2, at: hour(13), claim: 'out_of_stock' },
  { source: 'shopper_scan', store: ACME_STORE_TWO, position: 2, at: hour(14), claim: 'in_stock' },
];

const publishSchedule = async (harness: RetailerHarness): Promise<void> => {
  for (const [index, entry] of SCHEDULE.entries()) {
    const consumed = await harness.publish(
      entry.source,
      wireFor(
        entry.source,
        {
          retailerCode: harness.retailerId,
          storeCode: entry.store,
          facingRefs: [facingRef(entry.store, entry.position)],
          sku: OAT_MILK,
          observedAt: entry.at,
          eventRef: `evt-${index}`,
        },
        entry.claim,
      ),
    );
    expect(consumed.deadLettered).toBe(0);
  }
};

const scopeFor = (harness: RetailerHarness, window: TimeWindow): ReportScope => ({
  retailerId: harness.retailerId,
  storeIds: null,
  productIds: null,
  window,
  granularity: 'period',
  breakdownBy: [],
});

const auditScopeFor = (harness: RetailerHarness, period: TimeWindow): AuditExportScope => ({
  retailerId: harness.retailerId,
  period,
  productIds: null,
  storeIds: null,
});

/** Every exported record for a scope, walked through the port's own paging. */
const exportedRecords = async (
  harness: RetailerHarness,
  period: TimeWindow,
): Promise<readonly FacingStateAuditRecord[]> => {
  const all: FacingStateAuditRecord[] = [];
  let cursor: PageCursor | null = null;

  do {
    const page = await harness.reporting.exportFacingStateLog({
      scope: auditScopeFor(harness, period),
      // Deliberately smaller than the estate, so the reconstruction is assembled
      // the way an auditor would actually have to assemble it.
      page: { limit: 2, cursor },
    });
    all.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);

  return all;
};

/**
 * The auditor's own arithmetic.
 *
 * Written from what `FacingStateAuditRecord` documents itself to mean — a
 * carry-in state at the period's open, plus timestamped transitions inside it —
 * and calling nothing from the domain. That is the whole point: a reconstruction
 * that delegated to `computeFacingAvailability` would prove only that the
 * function is deterministic, not that the export carries enough to run it.
 *
 * Unknown time is excluded from both sides of the ratio, which is the one
 * definitional choice an auditor has to be told rather than derive; everything
 * else follows from the records.
 */
function reconstructIndex(
  records: readonly FacingStateAuditRecord[],
  period: TimeWindow,
): { readonly index: number | null; readonly inStock: number; readonly measured: number } {
  let inStock = 0;
  let outOfStock = 0;

  for (const record of records) {
    const accrued: Record<ShelfState, number> = { in_stock: 0, out_of_stock: 0, unknown: 0 };
    let cursor: number = period.from;
    let state: ShelfState = record.stateAtPeriodStart;

    const ordered = [...record.transitions].sort(
      (a, b) => a.at - b.at || a.sequence - b.sequence,
    );

    for (const transition of ordered) {
      if (transition.at <= cursor) {
        state = transition.to;
        continue;
      }
      if (transition.at >= period.to) break;
      accrued[state] += transition.at - cursor;
      cursor = transition.at;
      state = transition.to;
    }
    accrued[state] += period.to - cursor;

    inStock += accrued.in_stock;
    outOfStock += accrued.out_of_stock;
  }

  const measured = inStock + outOfStock;
  return { index: measured === 0 ? null : inStock / measured, inStock, measured };
}

/** Measurement periods an auditor might actually ask for. */
const PERIODS: readonly { readonly label: string; readonly window: TimeWindow }[] = [
  { label: 'the whole trading day', window: DAY_WINDOW },
  { label: 'the morning only', window: timeWindow(hour(0), hour(12)) },
  { label: 'the afternoon only', window: timeWindow(hour(12), hour(24)) },
  { label: 'a window opening mid-gap', window: timeWindow(hour(9), hour(15)) },
  { label: 'a window closing mid-gap', window: timeWindow(hour(7), hour(10)) },
  { label: 'a single hour with no events in it', window: timeWindow(hour(2), hour(3)) },
  { label: 'a window that starts and ends inside one gap', window: timeWindow(hour(9), hour(10)) },
  { label: 'an hour that ends with the day', window: timeWindow(hour(23), hour(24)) },
];

const startedPilot = async (): Promise<{ pilot: Pilot; acme: RetailerHarness }> => {
  const pilot = twoRetailerPilot();
  const acme = pilot.retailers[0]!;
  await publishSchedule(acme);
  return { pilot, acme };
};

describe('audit reconstruction — the retained log rebuilds the reported index', () => {
  it('reports an index that is not trivially one or zero', async () => {
    const { acme } = await startedPilot();
    const report = await acme.reporting.availabilityIndex(scopeFor(acme, DAY_WINDOW));

    expect(report.overall.facingCount).toBe(4);
    expect(report.overall.coverage).toBe(1);
    expect(report.overall.index).not.toBeNull();
    expect(report.overall.index).toBeGreaterThan(0);
    expect(report.overall.index).toBeLessThan(1);
  });

  for (const period of PERIODS) {
    it(`recomputes the reported index from the export alone — ${period.label}`, async () => {
      const { acme } = await startedPilot();

      const report = await acme.reporting.availabilityIndex(scopeFor(acme, period.window));
      const records = await exportedRecords(acme, period.window);
      const rebuilt = reconstructIndex(records, period.window);

      // Every facing in scope is in the export, whatever it did in the period —
      // including the one that did nothing.
      expect(records).toHaveLength(4);

      if (report.overall.index === null) {
        expect(rebuilt.index).toBeNull();
      } else {
        expect(rebuilt.index).not.toBeNull();
        expect(rebuilt.index!).toBeCloseTo(report.overall.index, 12);
      }
      expect(rebuilt.inStock).toBe(report.overall.inStockFacingMillis);
      expect(rebuilt.measured).toBe(report.overall.measuredFacingMillis);
    });
  }

  it('agrees per facing, not only in the total', async () => {
    const { acme } = await startedPilot();

    const records = await exportedRecords(acme, DAY_WINDOW);
    for (const record of records) {
      const rebuilt = reconstructIndex([record], DAY_WINDOW);
      expect(rebuilt.inStock).toBe(record.reportedInStockMillis);
      expect(rebuilt.measured).toBe(record.reportedMeasuredMillis);
      if (record.reportedIndex === null) expect(rebuilt.index).toBeNull();
      else expect(rebuilt.index!).toBeCloseTo(record.reportedIndex, 12);
    }
  });

  it('needs the carry-in state: without it the answer changes', async () => {
    const { acme } = await startedPilot();
    const period = timeWindow(hour(9), hour(15));

    const records = await exportedRecords(acme, period);
    const honest = reconstructIndex(records, period);
    // The same records with the one field an export could plausibly have been
    // built without. The period opens with two facings mid-gap; forgetting how
    // they entered it makes the first hours unaccountable.
    const amnesiac = reconstructIndex(
      records.map((record) => ({ ...record, stateAtPeriodStart: 'unknown' as ShelfState })),
      period,
    );

    expect(honest.index).not.toBeNull();
    expect(amnesiac.index).not.toBe(honest.index);
    expect(amnesiac.measured).toBeLessThan(honest.measured);
  });

  it('declares the gaps it knows about rather than exporting around them', async () => {
    const { acme } = await startedPilot();
    const artifact = await acme.reporting.sealArtifact({
      scope: auditScopeFor(acme, DAY_WINDOW),
      format: 'application/json',
      includeActionTrail: false,
    });

    expect(artifact.completeness.facingCount).toBe(4);
    expect(artifact.completeness.transitionCount).toBe(SCHEDULE.length);
    expect(artifact.completeness.sourcesRepresented).toEqual([
      'arpalus_detection',
      'caper_frame',
      'pos_movement',
      'shopper_scan',
    ]);
    // Nothing was lost, and the artifact says so rather than leaving an auditor
    // to wonder whether a quiet hour was an outage or a full shelf.
    expect(artifact.completeness.unobservedIntervals).toEqual([]);
    expect(artifact.completeness.incompleteFacings).toEqual([]);
  });
});

describe('audit reconstruction — from the sealed artifact body alone', () => {
  it('rebuilds the manifest’s own reported index from the bytes it hashed', async () => {
    const { acme } = await startedPilot();

    const artifact = await acme.reporting.sealArtifact({
      scope: auditScopeFor(acme, DAY_WINDOW),
      format: 'application/json',
      includeActionTrail: false,
    });

    const body = acme.artifacts.body(acme.retailerId, artifact.artifactId);
    expect(body).not.toBeNull();
    // The hash covers exactly the bytes that were stored: an auditor verifies
    // before they compute, and a body that does not hash to the manifest is not
    // evidence of anything.
    expect(sha256(body!)).toBe(artifact.integrity.contentHash);

    const parsed = JSON.parse(body!) as FacingStateAuditRecord[];
    const rebuilt = reconstructIndex(parsed, artifact.scope.period);

    expect(rebuilt.index).not.toBeNull();
    expect(rebuilt.index!).toBeCloseTo(artifact.reportedIndex.index!, 12);
    expect(rebuilt.inStock).toBe(artifact.reportedIndex.inStockFacingMillis);
    expect(rebuilt.measured).toBe(artifact.reportedIndex.measuredFacingMillis);

    // And the figure the artifact substantiates is the figure the report showed.
    const report = await acme.reporting.availabilityIndex(scopeFor(acme, DAY_WINDOW));
    expect(artifact.reportedIndex.index!).toBeCloseTo(report.overall.index!, 12);
    expect(artifact.schemaVersion).toBe(CURRENT_AUDIT_EXPORT_SCHEMA_VERSION);
  });

  it('seals the same closed period to the same bytes, twice', async () => {
    const { pilot, acme } = await startedPilot();
    const request = {
      scope: auditScopeFor(acme, DAY_WINDOW),
      format: 'application/json' as const,
      includeActionTrail: false,
    };

    const first = await acme.reporting.sealArtifact(request);
    // An auditor re-running the export later gets a later `generatedAt` and the
    // same evidence; only the second of those is allowed to matter.
    pilot.clock.set(hour(23));
    const second = await acme.reporting.sealArtifact(request);

    expect(second.integrity.contentHash).toBe(first.integrity.contentHash);
    // Content-addressed, so re-sealing an unchanged period returns the same
    // artifact rather than a second one an auditor has to reconcile.
    expect(second.artifactId).toBe(first.artifactId);
    expect(second.generatedAt).not.toBe(first.generatedAt);
  });
});

describe('audit reconstruction — replaying the producers’ own bytes', () => {
  it('rebuilds the same histories, index and hash in an empty deployment', async () => {
    const { acme } = await startedPilot();

    // A second pilot, wired identically and completely empty: same tenants, same
    // topics, its own store, ledger and consumer.
    const replica = twoRetailerPilot();
    const replicaAcme = replica.retailers[0]!;
    await acme.replayInto(replicaAcme);

    expect(replicaAcme.deadLetters.letters).toEqual([]);

    // Histories first: the index agreeing while the histories differ would be a
    // coincidence worth knowing about.
    const original = acme.repository.all(acme.retailerId);
    const rebuilt = replicaAcme.repository.all(replicaAcme.retailerId);
    expect(rebuilt).toHaveLength(original.length);

    for (const facing of original) {
      const twin = rebuilt.find((entry) => entry.facingId === facing.facingId);
      expect(twin).toBeDefined();
      expect(twin?.state).toBe(facing.state);
      expect(twin?.history.events.map((event) => [event.at, event.from, event.to])).toEqual(
        facing.history.events.map((event) => [event.at, event.from, event.to]),
      );
    }

    // Then the number, over every period an auditor might ask about.
    for (const period of PERIODS) {
      const reported = await acme.reporting.availabilityIndex(scopeFor(acme, period.window));
      const replayed = await replicaAcme.reporting.availabilityIndex(
        scopeFor(replicaAcme, period.window),
      );
      expect(replayed.overall.index).toBe(reported.overall.index);
      expect(replayed.overall.measuredFacingMillis).toBe(reported.overall.measuredFacingMillis);
    }

    // And the artifact, byte for byte: nothing the service learned along the way
    // and failed to retain can be hiding in the difference.
    const request = {
      format: 'application/json' as const,
      includeActionTrail: false,
    };
    const sealed = await acme.reporting.sealArtifact({
      ...request,
      scope: auditScopeFor(acme, DAY_WINDOW),
    });
    const resealed = await replicaAcme.reporting.sealArtifact({
      ...request,
      scope: auditScopeFor(replicaAcme, DAY_WINDOW),
    });

    expect(resealed.integrity.contentHash).toBe(sealed.integrity.contentHash);
  });

  it('is not fooled by a replay that drops one record', async () => {
    const { acme } = await startedPilot();

    const replica = twoRetailerPilot();
    const replicaAcme = replica.retailers[0]!;

    // Every record but the refill at 11:00 — the kind of loss a partial retention
    // policy or a botched migration produces.
    const dropped = SCHEDULE.findIndex(
      (entry) => entry.at === hour(11) && entry.claim === 'in_stock',
    );
    expect(dropped).toBeGreaterThanOrEqual(0);
    await acme.replayInto(replicaAcme, (_, index) => index !== dropped);

    const sealed = await acme.reporting.sealArtifact({
      scope: auditScopeFor(acme, DAY_WINDOW),
      format: 'application/json',
      includeActionTrail: false,
    });
    const partial = await replicaAcme.reporting.sealArtifact({
      scope: auditScopeFor(replicaAcme, DAY_WINDOW),
      format: 'application/json',
      includeActionTrail: false,
    });

    // The test above would pass against a reconstruction that ignored the log
    // entirely; this is what says it does not.
    expect(partial.integrity.contentHash).not.toBe(sealed.integrity.contentHash);
    expect(partial.reportedIndex.index).not.toBe(sealed.reportedIndex.index);
  });
});

describe('audit reconstruction — the export is canonical', () => {
  it('hashes a re-ordered record the same, so field order is never tamper evidence', async () => {
    const { acme } = await startedPilot();
    const records = await exportedRecords(acme, DAY_WINDOW);
    const first = records[0]!;

    const shuffled = Object.fromEntries(
      Object.entries(first as unknown as Record<string, unknown>).reverse(),
    );

    expect(sha256(canonicalJson(shuffled))).toBe(sha256(canonicalJson(first)));
  });

  it('keeps every facing’s transitions time-ordered and sequenced', async () => {
    const { acme } = await startedPilot();
    const records = await exportedRecords(acme, DAY_WINDOW);

    for (const record of records) {
      const ats = record.transitions.map((transition) => transition.at);
      expect([...ats].sort((a, b) => a - b)).toEqual(ats);

      const sequences = record.transitions.map((transition) => transition.sequence);
      expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);

      // Each transition leaves the state the previous one arrived at, so the step
      // function an auditor reconstructs has no discontinuity in it.
      let state: ShelfState = record.stateAtPeriodStart;
      for (const transition of record.transitions) {
        if (transition.at >= record.period.from) expect(transition.from).toBe(state);
        state = transition.to;
      }
    }
  });

  it('names which producer instance and build stood behind each transition', async () => {
    const { acme } = await startedPilot();
    const records = await exportedRecords(acme, DAY_WINDOW);

    const transitions = records.flatMap((record) => record.transitions);
    expect(transitions).toHaveLength(SCHEDULE.length);
    for (const transition of transitions) {
      expect(transition.producerInstanceId).toBeTruthy();
      expect(transition.producerSoftwareVersion).toBeTruthy();
    }
  });
});
