import type { RetailerId } from '../domain/common/ids.js';
import { unwrap } from '../domain/common/result.js';
import { elapsed, plus, type Instant, type Millis } from '../domain/common/time.js';
import {
  evaluateVerification,
  STANDARD_VERIFICATION_RULE,
  type VerificationPass,
  type VerificationRule,
} from '../domain/availability/verification.js';
import { applyTaskCommand, escalateTask, type Task, type TaskTransition } from '../domain/task/task.js';
import type { ReopenReason } from '../domain/task/task-state.js';
import type { EslClearResult } from '../ports/outbound/esl-actuation.port.js';
import {
  expressTasks,
  type EslDependencies,
  type TaskDispatch,
  type TaskDispatchPolicy,
} from './create-tasks.use-case.js';

/**
 * The verification half of the closed loop.
 *
 * A task is not closed when an employee says it is done; it is closed when the
 * shelf says so twice. This use case is the part that watches for that evidence,
 * closes the task when it arrives, and puts the work back in front of somebody
 * when it does not.
 *
 * `decideVerification` is pure — task, passes and an instant in, a decision out —
 * so the same function serves the live loop, a replay of yesterday, and a
 * back-test of a tighter rule. `runVerificationLoop` is the thin async shell that
 * carries the decision to the shelf edge: clearing the lane on a close, lighting
 * it again on a re-escalation.
 */

/**
 * The deadline the loop escalates against: `resolvedAt + rule.withinMillis`.
 *
 * Note this is *not* the same 24 hours the rule measures between the two clean
 * passes. The rule asks how far apart the evidence may be; this asks how long the
 * service is willing to wait for it. They are the same length on purpose — a fix
 * whose confirming passes cannot both land within a day of the employee reporting
 * it done is, operationally, a fix nobody can stand behind — but they answer
 * different questions and a retailer tightening one does not silently move the
 * other.
 */
export const verificationDeadline = (resolvedAt: Instant, rule: VerificationRule): Instant =>
  plus(resolvedAt, rule.withinMillis);

export type ReEscalationTrigger =
  /** A dirty pass landed after the fix: the condition is still there. */
  | 'condition_persisted'
  /** The deadline passed without the clean passes that close the loop. */
  | 'verification_window_lapsed';

export type VerificationDecision =
  | {
      readonly kind: 'not_applicable';
      readonly task: Task;
      readonly reason: 'verification_not_required' | 'not_awaiting_verification';
    }
  | {
      readonly kind: 'verified';
      readonly task: Task;
      readonly transition: TaskTransition;
      /** The passes that closed it, oldest first. */
      readonly passes: readonly VerificationPass[];
      readonly verifiedAt: Instant;
      /** Resolution to the second clean pass — the verification lag metric. */
      readonly resolutionToVerification: Millis;
      /** First to last clean pass. */
      readonly spanMillis: Millis;
    }
  | {
      readonly kind: 're_escalated';
      readonly task: Task;
      readonly transition: TaskTransition;
      readonly trigger: ReEscalationTrigger;
      readonly reason: ReopenReason;
      /** The dirty pass that decided it, when there was one. */
      readonly failingPass: VerificationPass | null;
      readonly deadline: Instant;
      readonly failedVerifications: number;
    }
  | {
      readonly kind: 'waiting';
      readonly task: Task;
      readonly reason: 'no_passes' | 'awaiting_further_clean_passes';
      readonly cleanStreak: readonly VerificationPass[];
      readonly deadline: Instant;
      /** Time left before the window lapses. Zero means the next tick escalates. */
      readonly remaining: Millis;
    };

export interface DecideVerificationInput {
  /** Partition key. Passes from another retailer can never verify this task. */
  readonly retailerId: RetailerId;
  readonly task: Task;
  readonly passes: readonly VerificationPass[];
  /** When the loop is being evaluated. */
  readonly at: Instant;
  readonly rule?: VerificationRule;
}

/**
 * Decides what the loop should do with one task, given the passes so far.
 *
 * Decisions worth naming, because they are the ones a retailer disputing a closed
 * task will ask about:
 *  - Passes after `at` are ignored. An evaluation is a statement about a moment,
 *    and a loop that could see the future would close tasks on evidence that had
 *    not arrived when it claimed to.
 *  - A task verifies at the instant its second clean pass landed, not at the
 *    instant the evaluator noticed. The loop closed when the shelf recovered; a
 *    scheduler running late must not inflate the verification lag it reports.
 *  - Evidence beats the deadline. If the clean passes are there, the task closes
 *    even if the evaluator arrives after the window lapsed — the deadline exists
 *    to escalate *absent* evidence, not to discard evidence that is present.
 *  - Task types that do not touch physical stock never reach this rule at all;
 *    they close on resolution, and asking the shelf to confirm a relabelled tag
 *    would hold work open on evidence the shelf cannot produce.
 */
export function decideVerification(input: DecideVerificationInput): VerificationDecision {
  const { task, at } = input;
  const rule = input.rule ?? STANDARD_VERIFICATION_RULE;

  if (task.state.status !== 'awaiting_verification') {
    return {
      kind: 'not_applicable',
      task,
      reason: task.requiresVerification ? 'not_awaiting_verification' : 'verification_not_required',
    };
  }

  const { resolvedAt } = task.state;
  const deadline = verificationDeadline(resolvedAt, rule);
  const outcome = evaluateVerification({
    retailerId: input.retailerId,
    taskId: task.taskId,
    resolvedAt,
    passes: input.passes.filter((pass) => pass.at <= at),
    rule,
  });

  if (outcome.status === 'verified') {
    const first = outcome.passes[0] as VerificationPass;
    const second = outcome.passes[outcome.passes.length - 1] as VerificationPass;
    const transition = unwrap(
      applyTaskCommand(task, {
        kind: 'confirm_verification',
        at: outcome.verifiedAt,
        firstPassId: first.passId,
        secondPassId: second.passId,
      }),
    );

    return {
      kind: 'verified',
      task: transition.task,
      transition,
      passes: outcome.passes,
      verifiedAt: outcome.verifiedAt,
      resolutionToVerification: elapsed(resolvedAt, outcome.verifiedAt),
      spanMillis: outcome.spanMillis,
    };
  }

  const escalate = (
    trigger: ReEscalationTrigger,
    reason: ReopenReason,
    failingPass: VerificationPass | null,
  ): VerificationDecision => {
    const transition = unwrap(escalateTask(task, at, reason));
    return {
      kind: 're_escalated',
      task: transition.task,
      transition,
      trigger,
      reason,
      failingPass,
      deadline,
      failedVerifications: transition.task.failedVerifications,
    };
  };

  if (outcome.status === 'regressed') {
    return escalate('condition_persisted', 'verification_regressed', outcome.failingPass);
  }

  // The boundary is inclusive, matching the rule's own: a pass landing exactly on
  // the deadline still counts, so the window has only lapsed once `at` is past it.
  if (at > deadline) {
    return escalate('verification_window_lapsed', 'verification_window_lapsed', null);
  }

  return {
    kind: 'waiting',
    task,
    reason: outcome.reason,
    cleanStreak: outcome.cleanStreak,
    deadline,
    remaining: elapsed(at, deadline),
  };
}

export interface RunVerificationLoopRequest extends DecideVerificationInput {
  readonly policy?: TaskDispatchPolicy;
}

export interface VerificationLoopOutcome {
  readonly decision: VerificationDecision;
  /** Set when the task closed and its lane was released. */
  readonly cleared: EslClearResult | null;
  /** Set when the task was re-escalated and lit again, one rung more urgent. */
  readonly redispatched: TaskDispatch | null;
}

/**
 * Runs one tick of the loop for one task and carries the decision to the shelf.
 *
 * Clearing is attempted for every close, including one the fleet never managed to
 * express: `clear` is contracted to be idempotent and to answer `not_expressed`
 * rather than fail, and the alternative — tracking whether we believe a tag is lit
 * and skipping the call — is exactly how a shelf ends up lit for finished work
 * after a restart.
 */
export async function runVerificationLoop(
  deps: EslDependencies,
  request: RunVerificationLoopRequest,
): Promise<VerificationLoopOutcome> {
  const decision = decideVerification(request);

  if (decision.kind === 'verified') {
    const cleared = await deps.esl.clear({
      retailerId: request.retailerId,
      storeId: decision.task.storeId,
      taskId: decision.task.taskId,
      facingId: decision.task.facingId,
      reason: 'verified',
      requestedAt: request.at,
    });
    return { decision, cleared, redispatched: null };
  }

  if (decision.kind === 're_escalated') {
    const [redispatched] = await expressTasks(deps, {
      retailerId: request.retailerId,
      tasks: [decision.task],
      at: request.at,
      ...(request.policy === undefined ? {} : { policy: request.policy }),
    });
    return { decision, cleared: null, redispatched: redispatched ?? null };
  }

  return { decision, cleared: null, redispatched: null };
}
