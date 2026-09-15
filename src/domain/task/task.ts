import { InvalidTaskTransitionError } from '../common/errors.js';
import { assertNever } from '../common/exhaustive.js';
import type {
  EmployeeId,
  EventId,
  FacingId,
  PassId,
  ProductId,
  RetailerId,
  StoreId,
  TaskId,
} from '../common/ids.js';
import { assertSameRetailer, type RetailerPartitioned } from '../common/partition.js';
import { err, ok, type Result } from '../common/result.js';
import type { Instant } from '../common/time.js';
import { laneFor, type LedColor, type RetailerColorLanes } from './color-lane.js';
import {
  canTransition,
  type CancelReason,
  type ReopenReason,
  type TaskState,
  type TaskStatus,
} from './task-state.js';
import { requiresShelfVerification, type TaskPriority, type TaskType } from './task-type.js';

/**
 * A unit of corrective work at one facing.
 *
 * The task is bound to the facing event that triggered it, so the closed loop is
 * traceable end to end: signal -> transition event -> task -> passes -> verified.
 */
export interface Task extends RetailerPartitioned {
  /** Partition key. Tasks are never dispatched or queried across retailers. */
  readonly retailerId: RetailerId;
  readonly storeId: StoreId;
  readonly taskId: TaskId;
  readonly facingId: FacingId;
  readonly productId: ProductId;
  readonly type: TaskType;
  readonly priority: TaskPriority;
  /** LED lane resolved from the retailer's mapping when the task was raised. */
  readonly lane: LedColor;
  readonly state: TaskState;
  /** The out-of-stock transition that triggered this task, when there was one. */
  readonly triggeringEventId: EventId | null;
  readonly requiresVerification: boolean;
  /**
   * How many times this task has been resolved and bounced back. Lives on the
   * task rather than on the `reopened` state so it survives the next assign →
   * resolve cycle, which is what makes repeat-offender facings visible.
   */
  readonly failedVerifications: number;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
}

export interface CreateTaskInput {
  readonly retailerId: RetailerId;
  readonly storeId: StoreId;
  readonly taskId: TaskId;
  readonly facingId: FacingId;
  readonly productId: ProductId;
  readonly type: TaskType;
  readonly priority: TaskPriority;
  readonly lanes: RetailerColorLanes;
  readonly triggeringEventId?: EventId | null;
  readonly createdAt: Instant;
}

export function createTask(input: CreateTaskInput): Task {
  assertSameRetailer(input.retailerId, input.lanes, 'createTask');

  return {
    retailerId: input.retailerId,
    storeId: input.storeId,
    taskId: input.taskId,
    facingId: input.facingId,
    productId: input.productId,
    type: input.type,
    priority: input.priority,
    lane: laneFor(input.lanes, input.type),
    state: { status: 'created', createdAt: input.createdAt },
    triggeringEventId: input.triggeringEventId ?? null,
    requiresVerification: requiresShelfVerification(input.type),
    failedVerifications: 0,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

/** Everything that can legally be asked of a task. */
export type TaskCommand =
  | { readonly kind: 'assign'; readonly at: Instant; readonly assigneeId: EmployeeId }
  | { readonly kind: 'acknowledge'; readonly at: Instant }
  | { readonly kind: 'start'; readonly at: Instant }
  | { readonly kind: 'resolve'; readonly at: Instant; readonly note?: string }
  | {
      readonly kind: 'confirm_verification';
      readonly at: Instant;
      readonly firstPassId: PassId;
      readonly secondPassId: PassId;
    }
  | { readonly kind: 'reopen'; readonly at: Instant; readonly reason: ReopenReason }
  | { readonly kind: 'cancel'; readonly at: Instant; readonly reason: CancelReason }
  | { readonly kind: 'expire'; readonly at: Instant };

export interface TaskTransition {
  readonly task: Task;
  readonly from: TaskStatus;
  readonly to: TaskStatus;
  readonly at: Instant;
}

/**
 * Applies a command, returning either the resulting transition or the reason it
 * is illegal. Pure and total: every (state, command) pair has a defined answer,
 * and the caller decides whether a rejection is a 409 or a swallowed retry.
 */
export function applyTaskCommand(
  task: Task,
  command: TaskCommand,
): Result<TaskTransition, InvalidTaskTransitionError> {
  const from = task.state.status;
  const reject = (): Result<never, InvalidTaskTransitionError> =>
    err(new InvalidTaskTransitionError(from, command.kind));

  const advance = (
    state: TaskState,
    patch: Partial<Omit<Task, 'state'>> = {},
  ): Result<TaskTransition, InvalidTaskTransitionError> => {
    if (!canTransition(from, state.status)) return reject();
    const next: Task = {
      ...task,
      ...patch,
      state,
      updatedAt: command.at > task.updatedAt ? command.at : task.updatedAt,
    };
    return ok({ task: next, from, to: state.status, at: command.at });
  };

  switch (command.kind) {
    case 'assign':
      return advance({
        status: 'assigned',
        assignedAt: command.at,
        assigneeId: command.assigneeId,
      });

    case 'acknowledge':
      if (task.state.status !== 'assigned') return reject();
      return advance({
        status: 'acknowledged',
        acknowledgedAt: command.at,
        assigneeId: task.state.assigneeId,
      });

    case 'start':
      if (task.state.status !== 'acknowledged') return reject();
      return advance({
        status: 'in_progress',
        startedAt: command.at,
        assigneeId: task.state.assigneeId,
      });

    case 'resolve': {
      if (task.state.status !== 'in_progress') return reject();
      const { assigneeId } = task.state;
      // Physical-stock work must survive two clean passes; label and audit work
      // is self-evidencing and closes on resolution.
      return task.requiresVerification
        ? advance({
            status: 'awaiting_verification',
            resolvedAt: command.at,
            assigneeId,
            resolutionNote: command.note ?? null,
          })
        : advance({ status: 'verified', verifiedAt: command.at, verifiedBy: null });
    }

    case 'confirm_verification':
      if (task.state.status !== 'awaiting_verification') return reject();
      return advance({
        status: 'verified',
        verifiedAt: command.at,
        verifiedBy: { firstPassId: command.firstPassId, secondPassId: command.secondPassId },
      });

    case 'reopen': {
      const failedVerifications = task.failedVerifications + 1;
      return advance(
        {
          status: 'reopened',
          reopenedAt: command.at,
          reason: command.reason,
          failedAttempts: failedVerifications,
        },
        { failedVerifications },
      );
    }

    case 'cancel':
      return advance({ status: 'cancelled', cancelledAt: command.at, reason: command.reason });

    case 'expire':
      return advance({ status: 'expired', expiredAt: command.at });

    default:
      return assertNever(command, 'applyTaskCommand');
  }
}
