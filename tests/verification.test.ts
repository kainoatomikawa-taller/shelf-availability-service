import { describe, expect, it } from 'vitest';
import {
  CrossRetailerAccessError,
  DAY,
  STANDARD_VERIFICATION_RULE,
  evaluateVerification,
  instant,
  millis,
  passId,
  plus,
  taskId,
  type Instant,
  type VerificationPass,
} from '../src/index.js';
import { ACME, RIVAL, TASK, hour, pass } from './support/fixtures.js';

const RESOLVED_AT = hour(8);
const after = (h: number, extraMillis = 0): Instant =>
  instant(plus(RESOLVED_AT, millis(h * 60 * 60 * 1000)) + extraMillis);

const evaluate = (passes: readonly VerificationPass[], rule = STANDARD_VERIFICATION_RULE) =>
  evaluateVerification({
    retailerId: ACME,
    taskId: TASK,
    resolvedAt: RESOLVED_AT,
    passes,
    rule,
  });

describe('verification rule — two consecutive clean passes within 24h', () => {
  it('ships with the two-passes-in-24h policy as its default', () => {
    expect(STANDARD_VERIFICATION_RULE.requiredConsecutiveCleanPasses).toBe(2);
    expect(STANDARD_VERIFICATION_RULE.withinMillis).toBe(DAY);
  });

  it('stays pending when no pass has been recorded yet', () => {
    const outcome = evaluate([]);

    expect(outcome.status).toBe('pending');
    expect(outcome.status === 'pending' && outcome.reason).toBe('no_passes');
  });

  it('stays pending after a single clean pass', () => {
    const outcome = evaluate([pass('p1', after(1))]);

    expect(outcome.status).toBe('pending');
    expect(outcome.status === 'pending' && outcome.reason).toBe('awaiting_further_clean_passes');
    expect(outcome.status === 'pending' && outcome.cleanStreak).toHaveLength(1);
  });

  it('verifies on two consecutive clean passes inside the window', () => {
    const outcome = evaluate([pass('p1', after(1)), pass('p2', after(7))]);

    expect(outcome.status).toBe('verified');
    if (outcome.status !== 'verified') return;
    expect(outcome.passes.map((p) => p.passId)).toEqual([passId('p1'), passId('p2')]);
    expect(outcome.verifiedAt).toBe(after(7));
    expect(outcome.spanMillis).toBe(6 * 60 * 60 * 1000);
  });

  it('treats a gap of exactly 24h as inside the window', () => {
    const outcome = evaluate([pass('p1', after(1)), pass('p2', after(25))]);

    expect(outcome.status).toBe('verified');
    expect(outcome.status === 'verified' && outcome.spanMillis).toBe(DAY);
  });

  it('does not verify when the second pass is one millisecond past 24h', () => {
    const outcome = evaluate([pass('p1', after(1)), pass('p2', after(25, 1))]);

    expect(outcome.status).toBe('pending');
    // The stale first pass is dropped; the second anchors a fresh streak.
    expect(outcome.status === 'pending' && outcome.cleanStreak.map((p) => p.passId)).toEqual([
      passId('p2'),
    ]);
  });

  it('lets a third pass complete the rule after the pair drifted out of the window', () => {
    const outcome = evaluate([pass('p1', after(1)), pass('p2', after(30)), pass('p3', after(36))]);

    expect(outcome.status).toBe('verified');
    expect(outcome.status === 'verified' && outcome.passes.map((p) => p.passId)).toEqual([
      passId('p2'),
      passId('p3'),
    ]);
  });

  it('breaks the streak when a dirty pass lands between two clean ones', () => {
    const outcome = evaluate([
      pass('p1', after(1)),
      pass('p2', after(2), 'dirty'),
      pass('p3', after(3)),
    ]);

    expect(outcome.status).toBe('regressed');
    expect(outcome.status === 'regressed' && outcome.failingPass.passId).toBe(passId('p2'));
    // The clean pass after the failure is kept: it is the start of the next attempt.
    expect(outcome.status === 'regressed' && outcome.cleanStreak.map((p) => p.passId)).toEqual([
      passId('p3'),
    ]);
  });

  it('reports a regression when the only pass after resolution is dirty', () => {
    const outcome = evaluate([pass('p1', after(2), 'dirty')]);

    expect(outcome.status).toBe('regressed');
    expect(outcome.status === 'regressed' && outcome.cleanStreak).toEqual([]);
  });

  it('still verifies when two clean passes follow an earlier dirty one', () => {
    const outcome = evaluate([
      pass('p1', after(1), 'dirty'),
      pass('p2', after(2)),
      pass('p3', after(4)),
    ]);

    expect(outcome.status).toBe('verified');
    expect(outcome.status === 'verified' && outcome.passes.map((p) => p.passId)).toEqual([
      passId('p2'),
      passId('p3'),
    ]);
  });

  it('is not undone by a dirty pass arriving after the rule was already satisfied', () => {
    const outcome = evaluate([
      pass('p1', after(1)),
      pass('p2', after(2)),
      pass('p3', after(20), 'dirty'),
    ]);

    // A later void is a new out-of-stock event, not a failure of this verification.
    expect(outcome.status).toBe('verified');
    expect(outcome.status === 'verified' && outcome.verifiedAt).toBe(after(2));
  });
});

describe('verification rule — which passes count', () => {
  it('ignores passes recorded before the work was reported done', () => {
    const outcome = evaluate([
      pass('before-1', hour(2)),
      pass('before-2', hour(6)),
      pass('after-1', after(1)),
    ]);

    expect(outcome.status).toBe('pending');
    expect(outcome.status === 'pending' && outcome.cleanStreak.map((p) => p.passId)).toEqual([
      passId('after-1'),
    ]);
  });

  it('ignores a pass recorded at the exact resolution instant', () => {
    const outcome = evaluate([pass('at-resolution', RESOLVED_AT), pass('p2', after(1))]);

    expect(outcome.status).toBe('pending');
  });

  it('deduplicates redelivered passes instead of counting them twice', () => {
    const redelivered = pass('p1', after(1));
    const outcome = evaluate([redelivered, { ...redelivered }]);

    expect(outcome.status).toBe('pending');
    expect(outcome.status === 'pending' && outcome.cleanStreak).toHaveLength(1);
  });

  it('does not accept two distinct passes sharing one instant as consecutive looks', () => {
    const outcome = evaluate([pass('p1', after(3)), pass('p2', after(3))]);

    expect(outcome.status).toBe('pending');
    expect(outcome.status === 'pending' && outcome.cleanStreak).toHaveLength(1);
  });

  it('ignores passes belonging to another task at the same facing', () => {
    const outcome = evaluate([
      pass('p1', after(1)),
      pass('other', after(2), 'clean', { taskId: taskId('task-other') }),
    ]);

    expect(outcome.status).toBe('pending');
  });

  it('orders passes by observation time regardless of the order they arrived in', () => {
    const outcome = evaluate([pass('late', after(7)), pass('early', after(1))]);

    expect(outcome.status).toBe('verified');
    expect(outcome.status === 'verified' && outcome.passes.map((p) => p.passId)).toEqual([
      passId('early'),
      passId('late'),
    ]);
  });

  it('rejects a pass from another retailer rather than letting it verify the task', () => {
    expect(() => evaluate([pass('p1', after(1)), pass('foreign', after(2), 'clean', { retailerId: RIVAL })])).toThrow(
      CrossRetailerAccessError,
    );
  });
});

describe('verification rule — retailer-tightened policy', () => {
  it('honours a stricter three-passes-in-12h rule', () => {
    const strict = { requiredConsecutiveCleanPasses: 3, withinMillis: millis(12 * 60 * 60 * 1000) };

    expect(evaluate([pass('p1', after(1)), pass('p2', after(2))], strict).status).toBe('pending');
    expect(
      evaluate([pass('p1', after(1)), pass('p2', after(2)), pass('p3', after(3))], strict).status,
    ).toBe('verified');
  });

  it('applies the tightened window between each pair in the streak', () => {
    const strict = { requiredConsecutiveCleanPasses: 2, withinMillis: millis(2 * 60 * 60 * 1000) };

    expect(evaluate([pass('p1', after(1)), pass('p2', after(4))], strict).status).toBe('pending');
  });
});
