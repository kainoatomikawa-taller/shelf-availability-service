import { describe, expect, it } from 'vitest';
import {
  HOUR,
  applyTaskCommand,
  detectGaps,
  dispatchTasks,
  employeeId,
  gapId,
  openOutcome,
  passId,
  rankGapsForWindow,
  resolveColorLaneMap,
  runVerificationLoop,
  salesVelocity,
  stateAt,
  taskId,
  timeWindow,
  unwrap,
  withBackInStock,
  withTask,
  withTransition,
  type DetectedGap,
  type DispatchTasksResult,
  type Facing,
  type FacingStateEvent,
  type Instant,
  type LoopOutcomeRecord,
  type ReportScope,
  type Task,
  type TaskTransition,
  type VerificationPass,
} from '../../src/index.js';
import { DAIRY_FRESH, hour } from '../support/fixtures.js';
import { wireFor, type WireContext } from '../support/producer-wire.js';
import {
  ACME_STORE,
  OAT_MILK,
  facingIn,
  facingRef,
  twoRetailerPilot,
} from '../support/pilot-fixtures.js';
import type { RetailerHarness } from '../support/pilot-harness.js';

/**
 * The closed loop, end to end, on real wiring.
 *
 * One facing is walked the whole way round: a camera sees the shelf empty, the
 * detection lands on the retailer's topic, the facing transitions, a gap is
 * detected and ranked, a typed task is raised and lit at the shelf edge, an
 * employee works it, two later passes confirm the fix, the task closes and the
 * lane goes dark — and the availability record for the day shows exactly the
 * three hours the shelf was actually empty.
 *
 * Nothing in the chain is handed the answer. Every step consumes only what the
 * previous step produced: the gap is read off the stored facing, the task from
 * the ranked gap, the verification verdict from the facing's own state at the
 * instant each pass was taken, and the index from the retained history. That is
 * the property worth having a single long test for — each link is unit-tested
 * already, and what is not is whether the chain joins up.
 */

const WINDOW = timeWindow(hour(0), hour(24));

const WENT_EMPTY: Instant = hour(8);
/** The sweep that *noticed*, half an hour after the shelf actually went empty. */
const DETECTED: Instant = hour(8, 30);
const DISPATCHED: Instant = hour(9);
const ASSIGNED: Instant = hour(9);
const ACKNOWLEDGED: Instant = hour(9);
const RESOLVED: Instant = hour(10);
const FIRST_PASS: Instant = hour(11);
const SECOND_PASS: Instant = hour(12);
const EVALUATED: Instant = hour(13);

const FACING = facingIn(ACME_STORE, 1);
const RESTOCKER = employeeId('emp-77');

const contextFor = (harness: RetailerHarness, observedAt: Instant, eventRef: string): WireContext => ({
  retailerCode: harness.retailerId,
  storeCode: ACME_STORE,
  facingRefs: [facingRef(ACME_STORE, 1)],
  sku: OAT_MILK,
  observedAt,
  eventRef,
});

const scopeFor = (harness: RetailerHarness): ReportScope => ({
  retailerId: harness.retailerId,
  storeIds: [ACME_STORE],
  productIds: null,
  window: WINDOW,
  granularity: 'period',
  breakdownBy: [],
});

interface RaisedTask {
  readonly trigger: FacingStateEvent;
  readonly gap: DetectedGap;
  readonly dispatched: DispatchTasksResult;
}

/**
 * Empties the shelf through the real ingestion path and raises the work for it.
 *
 * Detection, gap, ranking and dispatch, in that order, each fed only by the step
 * before it — which is what makes the assertions downstream about the loop rather
 * than about the fixture.
 */
const raiseTaskFor = async (harness: RetailerHarness): Promise<RaisedTask> => {
  const consumed = await harness.publish(
    'arpalus_detection',
    wireFor('arpalus_detection', contextFor(harness, WENT_EMPTY, 'scan-empty'), 'out_of_stock'),
  );
  expect(consumed.dispositions[0]?.outcome.status).toBe('ingested');

  const empty = await harness.facing(FACING);
  expect(empty?.state).toBe('out_of_stock');
  expect(empty?.history.events).toHaveLength(1);
  const trigger = empty!.history.events[0]!;

  const gaps = detectGaps({
    facing: empty!,
    classification: DAIRY_FRESH,
    at: DETECTED,
    nextGapId: (facing, kind) => gapId(`${facing.facingId}:${kind}`),
  });
  expect(gaps.map((gap) => gap.detail.kind)).toEqual(['availability_gap']);

  const ranked = rankGapsForWindow({
    retailerId: harness.retailerId,
    window: WINDOW,
    gaps,
    facings: [
      {
        retailerId: harness.retailerId,
        storeId: ACME_STORE,
        facingId: FACING,
        classification: DAIRY_FRESH,
      },
    ],
    passes: [0, 1, 2, 3].map((index) => ({
      retailerId: harness.retailerId,
      storeId: ACME_STORE,
      facingId: FACING,
      at: hour(index * 4),
      source: 'arpalus_detection' as const,
    })),
    salesVelocities: new Map([[FACING, salesVelocity(24)]]),
  });
  expect(ranked.committed).toHaveLength(1);
  expect(ranked.committed[0]?.serviceLevel.inScope).toBe(true);

  const dispatched = await dispatchTasks(
    { esl: harness.esl(ACME_STORE) },
    {
      retailerId: harness.retailerId,
      lanes: unwrap(resolveColorLaneMap(harness.retailerId)),
      gaps: ranked.committed,
      nextTaskId: (gap) => taskId(`task-${gap.gapId}`),
      triggeringEventId: () => trigger.eventId,
      at: DISPATCHED,
    },
  );

  return { trigger, gap: ranked.committed[0]!.gap, dispatched };
};

/** An employee takes the task, works it, and reports it done. */
const workTask = (task: Task): { readonly transitions: readonly TaskTransition[] } => {
  const assigned = unwrap(
    applyTaskCommand(task, { kind: 'assign', at: ASSIGNED, assigneeId: RESTOCKER }),
  );
  const acknowledged = unwrap(
    applyTaskCommand(assigned.task, { kind: 'acknowledge', at: ACKNOWLEDGED }),
  );
  const started = unwrap(applyTaskCommand(acknowledged.task, { kind: 'start', at: ACKNOWLEDGED }));
  const resolved = unwrap(
    applyTaskCommand(started.task, { kind: 'resolve', at: RESOLVED, note: 'refilled from back' }),
  );
  expect(resolved.to).toBe('awaiting_verification');

  return { transitions: [assigned, acknowledged, started, resolved] };
};

const lastTask = (worked: { readonly transitions: readonly TaskTransition[] }): Task =>
  worked.transitions[worked.transitions.length - 1]!.task;

/**
 * A verification pass, with its verdict read off the facing rather than asserted.
 *
 * A pass is "clean" when the facing was observed in stock; taking that from
 * `stateAt` over the ingested history means the loop closes on the evidence the
 * detections actually produced. Writing `outcome: 'clean'` by hand would make the
 * verification half of this test prove nothing about the detection half.
 */
const passFrom = (facing: Facing, task: Task, at: Instant, id: string): VerificationPass => ({
  passId: passId(id),
  retailerId: facing.retailerId,
  storeId: facing.storeId,
  facingId: facing.facingId,
  taskId: task.taskId,
  at,
  outcome: stateAt(facing.history, at) === 'in_stock' ? 'clean' : 'dirty',
  source: 'caper_frame',
});

/** Folds the real lifecycle transitions into the record the reports read. */
const outcomeRecordFor = (
  gap: DetectedGap,
  task: Task,
  transitions: readonly TaskTransition[],
): LoopOutcomeRecord =>
  transitions.reduce(
    (record, transition) => withTransition(record, transition),
    withTask(openOutcome(gap), task),
  );

describe('integration — one gap, detected to verified to reported', () => {
  it('drives a detected gap through task, verification and availability record', async () => {
    const pilot = twoRetailerPilot();
    const acme = pilot.retailers[0]!;

    // ---- 1–3. Detection, gap, worklist, task lit at the shelf --------------
    const { trigger, gap, dispatched } = await raiseTaskFor(acme);
    const created = dispatched.dispatches[0]!.task;

    expect(trigger.at).toBe(WENT_EMPTY);
    // The gap is dated from when we noticed, and carries when the shelf actually
    // went empty — two different facts, and the loop's latency needs both.
    expect(gap.detectedAt).toBe(DETECTED);
    expect(gap.detail).toMatchObject({ since: WENT_EMPTY });
    expect(created.type).toBe('restock_out_of_stock');
    expect(created.lane).toBe('red');
    expect(created.priority).toBe('critical');
    // The loop stays traceable: the task names the transition that caused it.
    expect(created.triggeringEventId).toBe(trigger.eventId);
    expect(dispatched.dispatches[0]?.result).toMatchObject({
      status: 'expressed',
      mode: 'pick_to_light',
    });
    expect(acme.gateway(ACME_STORE).dispatched).toHaveLength(1);

    // ---- 4. Somebody works it ---------------------------------------------
    const worked = workTask(created);
    const resolvedTask = lastTask(worked);

    // ---- 5. The shelf says so, twice --------------------------------------
    // Two Caper frames after the fix. They are ordinary detections — the same
    // stream that found the gap is the stream that closes it.
    for (const [index, at] of [FIRST_PASS, SECOND_PASS].entries()) {
      await acme.publish(
        'caper_frame',
        wireFor('caper_frame', contextFor(acme, at, `frame-${index}`), 'in_stock'),
      );
    }

    const refilled = await acme.facing(FACING);
    expect(refilled?.state).toBe('in_stock');
    // Back in stock is one transition, not two: the second frame agreed with the
    // first, and history records changes.
    expect(refilled?.history.events).toHaveLength(2);
    expect(refilled?.history.events[1]).toMatchObject({
      from: 'out_of_stock',
      to: 'in_stock',
      at: FIRST_PASS,
    });

    const passes = [
      passFrom(refilled!, resolvedTask, FIRST_PASS, 'pass-1'),
      passFrom(refilled!, resolvedTask, SECOND_PASS, 'pass-2'),
    ];
    expect(passes.map((pass) => pass.outcome)).toEqual(['clean', 'clean']);

    // ---- 6. The loop closes and the lane goes dark ------------------------
    const outcome = await runVerificationLoop(
      { esl: acme.esl(ACME_STORE) },
      { retailerId: acme.retailerId, task: resolvedTask, passes, at: EVALUATED },
    );

    expect(outcome.decision.kind).toBe('verified');
    if (outcome.decision.kind !== 'verified') return;
    // Closed at the instant the second clean pass landed, not when the evaluator
    // happened to run: a scheduler running late must not inflate the lag.
    expect(outcome.decision.verifiedAt).toBe(SECOND_PASS);
    expect(outcome.decision.resolutionToVerification).toBe(2 * HOUR);
    expect(outcome.decision.task.state.status).toBe('verified');
    expect(outcome.cleared).toEqual({ status: 'cleared', clearedAt: EVALUATED });
    expect(acme.gateway(ACME_STORE).released).toHaveLength(1);

    // ---- 7. What the retailer is shown ------------------------------------
    acme.readModel.outcomes.push(
      withBackInStock(
        outcomeRecordFor(gap, created, [...worked.transitions, outcome.decision.transition]),
        FIRST_PASS,
      ),
    );

    const availability = await acme.reporting.availabilityRecords({
      scope: scopeFor(acme),
      sort: 'index_asc',
      minGapCount: null,
      page: { limit: 10, cursor: null },
    });

    const row = availability.items.find((entry) => entry.facingId === FACING);
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      stateAtWindowStart: 'in_stock',
      stateAtWindowEnd: 'in_stock',
      // Empty from 08:00 to 11:00 and nothing else, measured all day.
      outOfStockMillis: 3 * HOUR,
      inStockMillis: 21 * HOUR,
      unknownMillis: 0,
      measuredMillis: 24 * HOUR,
      coverage: 1,
      gapCount: 1,
    });
    expect(row?.index).toBeCloseTo(21 / 24, 12);
    expect([...(row?.contributingSources ?? [])].sort()).toEqual([
      'arpalus_detection',
      'caper_frame',
    ]);

    // ---- 8. The loop's own latency ----------------------------------------
    const latency = await acme.reporting.detectionToResolution(scopeFor(acme));
    expect(latency.overall).toMatchObject({
      detectionToTask: { sampleSize: 1, p50: HOUR / 2 },
      taskToAssignment: { sampleSize: 1, p50: 0 },
      acknowledgementToResolution: { sampleSize: 1, p50: HOUR },
      resolutionToVerification: { sampleSize: 1, p50: 2 * HOUR },
      detectionToVerification: { sampleSize: 1, p50: 3.5 * HOUR },
      detectionToBackInStock: { sampleSize: 1, p50: 2.5 * HOUR },
    });

    const resolvedRate = await acme.reporting.resolvedGapRate(scopeFor(acme));
    expect(resolvedRate.overall).toMatchObject({
      detectedGaps: 1,
      taskedGaps: 1,
      resolvedGaps: 1,
      verifiedGaps: 1,
      selfResolvedGaps: 0,
      unresolvedGaps: 0,
      awaitingVerification: 0,
      resolvedGapRate: 1,
    });
  });

  it('re-escalates and re-lights the shelf when the fix did not hold', async () => {
    const pilot = twoRetailerPilot();
    const acme = pilot.retailers[0]!;

    const { dispatched } = await raiseTaskFor(acme);
    const worked = workTask(dispatched.dispatches[0]!.task);
    const resolvedTask = lastTask(worked);

    // The bay is still bare when the cart rolls past again — the restock did not
    // happen, or did not last.
    await acme.publish(
      'caper_frame',
      wireFor('caper_frame', contextFor(acme, FIRST_PASS, 'frame-dirty'), 'out_of_stock'),
    );
    const stillEmpty = await acme.facing(FACING);
    expect(stillEmpty?.state).toBe('out_of_stock');
    // No second transition: the shelf never recovered, so there is nothing to
    // record. The dirty pass is the evidence, not a state change.
    expect(stillEmpty?.history.events).toHaveLength(1);

    const outcome = await runVerificationLoop(
      { esl: acme.esl(ACME_STORE) },
      {
        retailerId: acme.retailerId,
        task: resolvedTask,
        passes: [passFrom(stillEmpty!, resolvedTask, FIRST_PASS, 'pass-dirty')],
        at: EVALUATED,
      },
    );

    expect(outcome.decision.kind).toBe('re_escalated');
    if (outcome.decision.kind !== 're_escalated') return;
    expect(outcome.decision.trigger).toBe('condition_persisted');
    expect(outcome.decision.failedVerifications).toBe(1);
    // Put back in front of somebody and still lit — not quietly closed, and not
    // left dark.
    expect(outcome.cleared).toBeNull();
    expect(outcome.redispatched?.result.status).toBe('expressed');

    // The task was already `critical`, so re-escalation asks the tag for exactly
    // what it is already showing. The fleet adapter renews the lease rather than
    // sending a second identical command — a gateway hammered with duplicates is
    // how a fleet starts refusing the commands that do matter.
    const original = dispatched.dispatches[0]?.result;
    const relit = outcome.redispatched?.result;
    expect(acme.gateway(ACME_STORE).dispatched).toHaveLength(1);
    expect(original?.status === 'expressed' && relit?.status === 'expressed').toBe(true);
    if (original?.status !== 'expressed' || relit?.status !== 'expressed') return;
    expect(relit.expressionId).toBe(original.expressionId);
    expect(relit.leaseExpiresAt).toBeGreaterThan(original.leaseExpiresAt);
  });

  it('runs the same loop independently in every retailer of the pilot', async () => {
    const pilot = twoRetailerPilot();

    for (const harness of pilot.retailers) {
      const store = harness.spec.stores[0]!.storeId;
      const facing = facingIn(store, 1);

      await harness.publish(
        'shopper_scan',
        wireFor(
          'shopper_scan',
          {
            retailerCode: harness.retailerId,
            storeCode: store,
            facingRefs: [facingRef(store, 1)],
            sku: OAT_MILK,
            observedAt: WENT_EMPTY,
            eventRef: `scan-${harness.retailerId}`,
          },
          'out_of_stock',
        ),
      );

      const stored = await harness.facing(facing);
      expect(stored?.state).toBe('out_of_stock');
      expect(stored?.retailerId).toBe(harness.retailerId);
    }

    // Each retailer's loop moved its own shelf and nothing else: the facing
    // counts per partition are exactly what each one was seeded with.
    for (const harness of pilot.retailers) {
      const stored = harness.repository.all(harness.retailerId);
      expect(stored.every((facing) => facing.retailerId === harness.retailerId)).toBe(true);
      expect(stored).toHaveLength(
        harness.spec.stores.reduce((total, store) => total + store.facings.length, 0),
      );
    }
  });
});
