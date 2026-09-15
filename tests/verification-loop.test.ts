import { describe, expect, it } from 'vitest';
import {
  DAY,
  HOUR,
  applyTaskCommand,
  createTask,
  decideVerification,
  eventId,
  instant,
  millis,
  passId,
  plus,
  resolveColorLaneMap,
  runVerificationLoop,
  unwrap,
  verificationDeadline,
  type Instant,
  type Task,
  type TaskType,
  type VerificationPass,
  type VerificationRule,
} from '../src/index.js';
import {
  ACME,
  EMPLOYEE,
  FACING,
  PRODUCT,
  STORE,
  TASK,
  fleetCapabilities,
  hour,
  pass,
} from './support/fixtures.js';
import { InMemoryEslFleet } from './support/in-memory-ports.js';

const LANES = unwrap(resolveColorLaneMap(ACME));
const RESOLVED_AT = hour(8);

/** A task driven to `awaiting_verification` — where the loop picks it up. */
const resolvedTask = (type: TaskType = 'restock_out_of_stock', priority: Task['priority'] = 'normal'): Task => {
  const created = createTask({
    retailerId: ACME,
    storeId: STORE,
    taskId: TASK,
    facingId: FACING,
    productId: PRODUCT,
    type,
    priority,
    lanes: LANES,
    triggeringEventId: eventId('evt-oos-1'),
    createdAt: hour(6),
  });

  return [
    { kind: 'assign', at: hour(6), assigneeId: EMPLOYEE },
    { kind: 'acknowledge', at: hour(7) },
    { kind: 'start', at: hour(7) },
    { kind: 'resolve', at: RESOLVED_AT },
  ].reduce<Task>(
    (task, command) => unwrap(applyTaskCommand(task, command as Parameters<typeof applyTaskCommand>[1])).task,
    created,
  );
};

const after = (hours: number, extraMillis = 0): Instant =>
  instant(plus(RESOLVED_AT, millis(hours * HOUR)) + extraMillis);

const decide = (
  passes: readonly VerificationPass[],
  at: Instant,
  task: Task = resolvedTask(),
  rule?: VerificationRule,
) =>
  decideVerification({
    retailerId: ACME,
    task,
    passes,
    at,
    ...(rule === undefined ? {} : { rule }),
  });

describe('closing the loop on two clean passes', () => {
  it('verifies the task at the instant the second clean pass landed', () => {
    const passes = [pass('p1', after(2)), pass('p2', after(6))];
    const decision = decide(passes, after(7));

    expect(decision.kind).toBe('verified');
    if (decision.kind !== 'verified') return;

    expect(decision.task.state.status).toBe('verified');
    // Closed when the shelf recovered, not when the evaluator noticed: a
    // scheduler running an hour late must not inflate the verification lag.
    expect(decision.verifiedAt).toBe(after(6));
    expect(decision.resolutionToVerification).toBe(millis(6 * HOUR));
    expect(decision.task.state.status === 'verified' && decision.task.state.verifiedBy).toEqual({
      firstPassId: passId('p1'),
      secondPassId: passId('p2'),
    });
  });

  it('keeps waiting while only one clean pass is in', () => {
    const decision = decide([pass('p1', after(2))], after(3));

    expect(decision.kind).toBe('waiting');
    if (decision.kind !== 'waiting') return;

    expect(decision.reason).toBe('awaiting_further_clean_passes');
    expect(decision.cleanStreak.map((entry) => entry.passId)).toEqual([passId('p1')]);
    expect(decision.deadline).toBe(verificationDeadline(RESOLVED_AT, {
      requiredConsecutiveCleanPasses: 2,
      withinMillis: DAY,
    }));
    expect(decision.remaining).toBe(millis(21 * HOUR));
  });

  it('cannot see passes that have not happened yet', () => {
    // The second pass exists in the caller's list but lands after the evaluation
    // instant. An evaluation is a statement about a moment.
    const decision = decide([pass('p1', after(2)), pass('p2', after(9))], after(3));

    expect(decision.kind).toBe('waiting');
  });

  it('closes even when the evaluator arrives after the window lapsed', () => {
    // Evidence beats the deadline: the deadline exists to escalate absent
    // evidence, not to discard evidence that is present.
    const decision = decide([pass('p1', after(2)), pass('p2', after(6))], after(40));

    expect(decision.kind).toBe('verified');
  });

  it('leaves label and audit work alone — the shelf cannot confirm a relabel', () => {
    const relabel = resolvedTask('price_label_correction');
    const decision = decide([], after(30), relabel);

    expect(relabel.state.status).toBe('verified');
    expect(decision.kind).toBe('not_applicable');
    expect(decision.kind === 'not_applicable' && decision.reason).toBe('verification_not_required');
  });
});

describe('re-escalating work that did not hold', () => {
  it('re-escalates when the condition persists after the fix', () => {
    const decision = decide([pass('p1', after(2)), pass('d1', after(4), 'dirty')], after(5));

    expect(decision.kind).toBe('re_escalated');
    if (decision.kind !== 're_escalated') return;

    expect(decision.trigger).toBe('condition_persisted');
    expect(decision.reason).toBe('verification_regressed');
    expect(decision.failingPass?.passId).toBe(passId('d1'));
    expect(decision.task.state.status).toBe('reopened');
    expect(decision.failedVerifications).toBe(1);
    // Work that bounced comes back one rung more urgent than it went out.
    expect(decision.task.priority).toBe('high');
  });

  it('re-escalates when the clean passes never arrive inside the window', () => {
    const decision = decide([pass('p1', after(2))], after(24, 1));

    expect(decision.kind).toBe('re_escalated');
    if (decision.kind !== 're_escalated') return;

    expect(decision.trigger).toBe('verification_window_lapsed');
    expect(decision.reason).toBe('verification_window_lapsed');
    expect(decision.failingPass).toBeNull();
  });

  it('holds the deadline inclusively, matching the rule’s own boundary', () => {
    expect(decide([pass('p1', after(2))], after(24)).kind).toBe('waiting');
    expect(decide([pass('p1', after(2))], after(24, 1)).kind).toBe('re_escalated');
  });

  it('accumulates urgency across successive failures, saturating at critical', () => {
    let task = resolvedTask('restock_out_of_stock', 'normal');

    for (const expected of ['high', 'critical', 'critical'] as const) {
      const decision = decide([pass(`d-${expected}`, after(4), 'dirty')], after(5), task);
      expect(decision.kind).toBe('re_escalated');
      if (decision.kind !== 're_escalated') return;

      expect(decision.task.priority).toBe(expected);
      // Back round the loop: assigned, worked, reported done again.
      task = [
        { kind: 'assign', at: after(6), assigneeId: EMPLOYEE },
        { kind: 'acknowledge', at: after(6) },
        { kind: 'start', at: after(6) },
        { kind: 'resolve', at: RESOLVED_AT },
      ].reduce<Task>(
        (current, command) =>
          unwrap(applyTaskCommand(current, command as Parameters<typeof applyTaskCommand>[1])).task,
        decision.task,
      );
    }
  });

  it('does not apply to a task nobody has reported done yet', () => {
    const created = createTask({
      retailerId: ACME,
      storeId: STORE,
      taskId: TASK,
      facingId: FACING,
      productId: PRODUCT,
      type: 'restock_out_of_stock',
      priority: 'high',
      lanes: LANES,
      createdAt: hour(6),
    });

    expect(decide([], after(30), created).kind).toBe('not_applicable');
  });
});

describe('carrying the decision to the shelf', () => {
  const runLoop = (passes: readonly VerificationPass[], at: Instant, fleet: InMemoryEslFleet) =>
    runVerificationLoop(
      { esl: fleet },
      { retailerId: ACME, task: resolvedTask(), passes, at },
    );

  it('releases the lane when the task closes', async () => {
    const fleet = new InMemoryEslFleet(fleetCapabilities());
    fleet.expressions.set(`${TASK}|${FACING}`, 'pick_to_light');

    const outcome = await runLoop([pass('p1', after(2)), pass('p2', after(6))], after(7), fleet);

    expect(outcome.decision.kind).toBe('verified');
    expect(outcome.cleared).toEqual({ status: 'cleared', clearedAt: after(7) });
    expect(fleet.expressions.size).toBe(0);
    expect(outcome.redispatched).toBeNull();
  });

  it('clears idempotently even when the fleet never managed to light it', async () => {
    const fleet = new InMemoryEslFleet(fleetCapabilities());

    const outcome = await runLoop([pass('p1', after(2)), pass('p2', after(6))], after(7), fleet);

    expect(outcome.cleared).toEqual({ status: 'not_expressed' });
    expect(fleet.clears).toHaveLength(1);
  });

  it('lights the shelf again, more urgently, on a re-escalation', async () => {
    const fleet = new InMemoryEslFleet(fleetCapabilities());

    const outcome = await runLoop([pass('d1', after(4), 'dirty')], after(5), fleet);

    expect(outcome.decision.kind).toBe('re_escalated');
    expect(outcome.redispatched?.result.status).toBe('expressed');
    expect(fleet.commands[0]?.priority).toBe('high');
    expect(fleet.commands[0]?.flashPattern).toBe('slow');
  });

  it('touches the shelf at all only when the decision changed something', async () => {
    const fleet = new InMemoryEslFleet(fleetCapabilities());

    const outcome = await runLoop([pass('p1', after(2))], after(3), fleet);

    expect(outcome.decision.kind).toBe('waiting');
    expect(fleet.commands).toEqual([]);
    expect(fleet.clears).toEqual([]);
  });
});
