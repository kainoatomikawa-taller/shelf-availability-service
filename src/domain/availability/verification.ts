import type { FacingId, PassId, RetailerId, StoreId, TaskId } from '../common/ids.js';
import { assertSameRetailer, type RetailerPartitioned } from '../common/partition.js';
import { DAY, elapsed, type Instant, type Millis } from '../common/time.js';
import type { SignalSource } from '../facing/signals.js';

/**
 * A single look at the facing after the work was reported done.
 *
 * A pass is "clean" when the facing was observed in stock and matching plan, and
 * "dirty" otherwise. Passes come from whichever source swept the bay — a Caper
 * cart, an Arpalus run, or a shopper pick — which is why the source is recorded
 * but never weighted: the rule counts passes, not opinions.
 */
export interface VerificationPass extends RetailerPartitioned {
  readonly passId: PassId;
  /** Partition key. Passes from another retailer can never verify this task. */
  readonly retailerId: RetailerId;
  readonly storeId: StoreId;
  readonly facingId: FacingId;
  readonly taskId: TaskId;
  readonly at: Instant;
  readonly outcome: 'clean' | 'dirty';
  readonly source: SignalSource;
}

/**
 * The closed-loop verification rule.
 *
 * Defaults encode the policy the service ships with: **two consecutive clean
 * passes within 24 hours**. Held as data so a retailer can tighten it (three
 * passes, twelve hours) without forking the evaluator.
 */
export interface VerificationRule {
  readonly requiredConsecutiveCleanPasses: number;
  readonly withinMillis: Millis;
}

export const STANDARD_VERIFICATION_RULE: VerificationRule = {
  requiredConsecutiveCleanPasses: 2,
  withinMillis: DAY,
};

export type VerificationOutcome =
  | {
      readonly status: 'verified';
      /** The passes that satisfied the rule, oldest first. */
      readonly passes: readonly VerificationPass[];
      readonly verifiedAt: Instant;
      readonly spanMillis: Millis;
    }
  | {
      readonly status: 'pending';
      readonly reason: 'no_passes' | 'awaiting_further_clean_passes';
      /** Clean passes accumulated so far in the live streak. */
      readonly cleanStreak: readonly VerificationPass[];
    }
  | {
      /** A dirty pass landed after resolution: the fix did not hold. */
      readonly status: 'regressed';
      readonly failingPass: VerificationPass;
      readonly cleanStreak: readonly VerificationPass[];
    };

export interface EvaluateVerificationInput {
  readonly retailerId: RetailerId;
  readonly taskId: TaskId;
  /** When the employee reported the work done. Passes before this prove nothing. */
  readonly resolvedAt: Instant;
  readonly passes: readonly VerificationPass[];
  readonly rule?: VerificationRule;
}

const sortPasses = (passes: readonly VerificationPass[]): VerificationPass[] =>
  [...passes].sort((a, b) => (a.at === b.at ? a.passId.localeCompare(b.passId) : a.at - b.at));

/**
 * Evaluates the two-consecutive-clean-passes-within-24h rule.
 *
 * Pure: the caller supplies the passes and the resolution instant, so the same
 * function serves live evaluation, replay and back-testing.
 *
 * Decisions worth naming, because they are the ones auditors ask about:
 *  - Passes at or before `resolvedAt` are ignored entirely — the loop closes on
 *    evidence gathered *after* the fix.
 *  - "Consecutive" means no dirty pass in between. A dirty pass clears the streak,
 *    and unless a later streak completes the rule the result is `regressed` — the
 *    caller reopens rather than waiting out a fix that already failed once.
 *  - The span is measured first-to-last clean pass and must satisfy `<= 24h`.
 *    A pair that drifts past the window does not fail: the older pass is dropped
 *    and the newer one anchors a new streak.
 *  - Two passes sharing an instant are not independent looks at the shelf, so the
 *    later one re-anchors instead of completing the streak. Duplicate `passId`s
 *    are deduplicated first, since redelivery is normal at the ingestion edge.
 */
export function evaluateVerification(input: EvaluateVerificationInput): VerificationOutcome {
  const rule = input.rule ?? STANDARD_VERIFICATION_RULE;

  const deduped = new Map<PassId, VerificationPass>();
  for (const pass of input.passes) {
    assertSameRetailer(input.retailerId, pass, 'evaluateVerification');
    if (pass.taskId !== input.taskId) continue;
    if (pass.at <= input.resolvedAt) continue;
    if (!deduped.has(pass.passId)) deduped.set(pass.passId, pass);
  }

  const candidates = sortPasses([...deduped.values()]);
  if (candidates.length === 0) {
    return { status: 'pending', reason: 'no_passes', cleanStreak: [] };
  }

  let streak: VerificationPass[] = [];
  let lastDirty: VerificationPass | null = null;

  for (const pass of candidates) {
    if (pass.outcome === 'dirty') {
      lastDirty = pass;
      streak = [];
      continue;
    }

    const previous = streak.at(-1);
    if (previous !== undefined) {
      const gap = elapsed(previous.at, pass.at);
      // Same instant, or drifted outside the window: this pass anchors a new streak.
      streak = gap > 0 && gap <= rule.withinMillis ? [...streak, pass] : [pass];
    } else {
      streak = [pass];
    }

    const anchor = streak[0];
    if (anchor !== undefined && streak.length >= rule.requiredConsecutiveCleanPasses) {
      return {
        status: 'verified',
        passes: streak,
        verifiedAt: pass.at,
        spanMillis: elapsed(anchor.at, pass.at),
      };
    }
  }

  // A dirty pass after resolution is decisive even if clean passes followed it:
  // the fix demonstrably did not hold, so the task reopens and verification
  // restarts from the next resolution rather than from a partially stale streak.
  if (lastDirty !== null) {
    return { status: 'regressed', failingPass: lastDirty, cleanStreak: streak };
  }

  return { status: 'pending', reason: 'awaiting_further_clean_passes', cleanStreak: streak };
}
