import { LaneMappingError } from '../domain/common/errors.js';
import type { EventId, RetailerId, StoreId, TaskId } from '../domain/common/ids.js';
import { assertSameRetailer } from '../domain/common/partition.js';
import { plus, type Instant } from '../domain/common/time.js';
import { gapKindOf, taskTypeForGap, type DetectedGap } from '../domain/gap/gap.js';
import type { RankedGap } from '../domain/gap/ranking.js';
import { isReservedLane, RESERVED_LANES, type RetailerColorLanes } from '../domain/task/color-lane.js';
import { createTask, type Task } from '../domain/task/task.js';
import type { TaskPriority, TaskType } from '../domain/task/task-type.js';
import {
  STANDARD_DEGRADATION_LADDER,
  type EslActuationPort,
  type EslActuationResult,
  type EslBadgeContent,
  type EslFleetCapabilities,
  type EslExpressionMode,
  type EslFlashPattern,
  type ExpressTaskCommand,
} from '../ports/outbound/esl-actuation.port.js';

/**
 * Turning a ranked worklist into typed tasks and expressing them at the shelf.
 *
 * The two halves are deliberately separable. `planTasks` is pure — ranked gaps in,
 * tasks out — so what work gets raised can be replayed and back-tested without a
 * fleet anywhere near it. `dispatchTasks` is the part that talks to hardware, and
 * everything it decides (which rung of the degradation ladder, what lease, what
 * happens when a tag is dark) is reported back rather than swallowed, because a
 * task nobody can see at the shelf is a task that has to reach the employee some
 * other way.
 */

/**
 * The tunable half of dispatch.
 *
 * Rank bands are configuration for the same reason department weights are: the
 * platform does not own the retailer's staffing. A store running three people on
 * a Sunday night and one running thirty at 9am do not agree on how far down a
 * worklist "drop everything" reaches. What the platform owns is the shape — a
 * band per priority, applied to a list the domain already ordered.
 */
export interface TaskDispatchPolicy {
  /** Ranks 1..n are dispatched `critical`. */
  readonly criticalThroughRank: number;
  /** Ranks above `criticalThroughRank` through n are dispatched `high`. */
  readonly highThroughRank: number;
  /** Ranks above `highThroughRank` through n are `normal`; everything below is `low`. */
  readonly normalThroughRank: number;
  /** Flash pattern asked for per priority, subject to what the fleet supports. */
  readonly flashByPriority: Readonly<Record<TaskPriority, EslFlashPattern | null>>;
  /** Headline for fleets with a text area. Truncated by the adapter, not here. */
  readonly badgeHeadline: Readonly<Record<TaskType, string>>;
}

export const STANDARD_TASK_DISPATCH_POLICY: TaskDispatchPolicy = {
  criticalThroughRank: 3,
  highThroughRank: 10,
  normalThroughRank: 25,
  flashByPriority: {
    critical: 'fast',
    high: 'slow',
    normal: null,
    low: null,
  },
  badgeHeadline: {
    restock_out_of_stock: 'RESTOCK',
    replenish_low_stock: 'TOP UP',
    misplaced_product: 'WRONG SKU',
    planogram_correction: 'FIX PLAN',
    price_label_correction: 'PRICE',
    tag_maintenance: 'TAG',
    spoilage_removal: 'REMOVE',
    audit_count: 'COUNT',
  },
};

/** Priority band for a position in the worklist. */
export const priorityForRank = (
  rank: number,
  policy: TaskDispatchPolicy = STANDARD_TASK_DISPATCH_POLICY,
): TaskPriority => {
  if (rank <= policy.criticalThroughRank) return 'critical';
  if (rank <= policy.highThroughRank) return 'high';
  if (rank <= policy.normalThroughRank) return 'normal';
  return 'low';
};

export interface PlanTasksRequest {
  /** Partition key. One retailer per worklist — there is no pooled dispatch. */
  readonly retailerId: RetailerId;
  /** The lane mapping in force, already validated against the reserved lanes. */
  readonly lanes: RetailerColorLanes;
  /** The worklist to raise, best first — normally `RankGapsResult.committed`. */
  readonly gaps: readonly RankedGap[];
  readonly nextTaskId: (gap: DetectedGap) => TaskId;
  /** The out-of-stock transition behind the gap, when the caller can name it. */
  readonly triggeringEventId?: (gap: DetectedGap) => EventId | null;
  readonly at: Instant;
  readonly policy?: TaskDispatchPolicy;
}

/**
 * Creates one typed task per ranked gap, in worklist order.
 *
 * The task type follows from the gap kind rather than from anything the caller
 * chooses, so a new gap kind cannot reach the shelf as untyped work, and the lane
 * follows from the task type through the retailer's mapping. A lane that resolves
 * onto a reserved colour is rejected here as well as at configuration time: the
 * mapping is data and can arrive from storage, and one light meaning two things on
 * the same shelf is not a failure worth discovering on the floor.
 */
export function planTasks(request: PlanTasksRequest): readonly Task[] {
  const policy = request.policy ?? STANDARD_TASK_DISPATCH_POLICY;
  assertSameRetailer(request.retailerId, request.lanes, 'planTasks');

  return request.gaps.map((ranked) => {
    const { gap } = ranked;
    assertSameRetailer(request.retailerId, gap, 'planTasks');

    const type = taskTypeForGap(gapKindOf(gap));
    const task = createTask({
      retailerId: gap.retailerId,
      storeId: gap.storeId,
      taskId: request.nextTaskId(gap),
      facingId: gap.facingId,
      productId: gap.productId,
      type,
      priority: priorityForRank(ranked.rank, policy),
      lanes: request.lanes,
      triggeringEventId: request.triggeringEventId?.(gap) ?? null,
      createdAt: request.at,
    });

    if (isReservedLane(task.lane)) {
      throw new LaneMappingError(
        `Task type "${type}" resolves onto lane "${task.lane}", reserved for ${RESERVED_LANES[task.lane]}`,
      );
    }

    return task;
  });
}

export interface EslDependencies {
  readonly esl: EslActuationPort;
}

/** What actually happened to one task at the shelf edge. */
export interface TaskDispatch {
  readonly task: Task;
  /** `null` when the fleet expresses nothing and no command was sent. */
  readonly command: ExpressTaskCommand | null;
  readonly result: EslActuationResult;
  /**
   * True when the shelf edge could not carry this task and it must reach the
   * employee another way — the handheld list. A dark tag is not a closed loop.
   */
  readonly routeElsewhere: boolean;
}

export interface DispatchTasksResult {
  readonly retailerId: RetailerId;
  readonly dispatches: readonly TaskDispatch[];
  /** The subset the shelf could not express, for the handheld fallback channel. */
  readonly routedElsewhere: readonly Task[];
}

/**
 * The ladder sent with a command: what the caller *wants*, in order, unfiltered.
 *
 * Deliberately not pre-trimmed to what the fleet supports. `degraded` is defined
 * against the caller's first preference, so trimming the ladder here would make
 * every command look like a perfect match and the fleet running a decade-old
 * mono generation would report the same clean result as a new one.
 */
const ladderFor = (capabilities: EslFleetCapabilities): readonly EslExpressionMode[] =>
  capabilities.degradationLadder.length > 0
    ? capabilities.degradationLadder
    : STANDARD_DEGRADATION_LADDER;

/** Whether any rung of the ladder is something this fleet can actually do. */
const canExpress = (capabilities: EslFleetCapabilities): boolean =>
  ladderFor(capabilities).some(
    (mode) => mode !== 'none' && capabilities.supportedModes.includes(mode),
  );

const flashFor = (
  priority: TaskPriority,
  capabilities: EslFleetCapabilities,
  policy: TaskDispatchPolicy,
): EslFlashPattern | null => {
  const wanted = policy.flashByPriority[priority];
  return wanted !== null && capabilities.supportedFlashPatterns.includes(wanted) ? wanted : null;
};

const badgeFor = (task: Task, policy: TaskDispatchPolicy): EslBadgeContent => ({
  headline: policy.badgeHeadline[task.type],
  detail: task.productId,
});

/**
 * Builds the command for one task against one fleet's declared capabilities.
 *
 * Exported because re-escalation expresses the same task again through the same
 * shape, and a second copy of this mapping would be a second place for the lane,
 * the lease and the flash pattern to drift.
 */
export function buildExpressCommand(
  task: Task,
  capabilities: EslFleetCapabilities,
  at: Instant,
  policy: TaskDispatchPolicy = STANDARD_TASK_DISPATCH_POLICY,
): ExpressTaskCommand {
  assertSameRetailer(task.retailerId, capabilities, 'buildExpressCommand');

  return {
    retailerId: task.retailerId,
    storeId: task.storeId,
    taskId: task.taskId,
    facingId: task.facingId,
    // The adapter owns the facing-to-tag binding; asking it to resolve one keeps
    // that mapping in the one place that can also tell us the tag went offline.
    tagId: null,
    taskType: task.type,
    lane: task.lane,
    priority: task.priority,
    flashPattern: flashFor(task.priority, capabilities, policy),
    badge: badgeFor(task, policy),
    modePreference: ladderFor(capabilities),
    expiresAt: plus(at, capabilities.expressionLeaseMillis),
    requestedAt: at,
  };
}

const chunk = <T>(items: readonly T[], size: number): readonly (readonly T[])[] => {
  const limit = Math.max(1, Math.floor(size));
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += limit) {
    chunks.push(items.slice(index, index + limit));
  }
  return chunks;
};

const groupByStore = (tasks: readonly Task[]): ReadonlyMap<StoreId, readonly Task[]> => {
  const grouped = new Map<StoreId, Task[]>();
  for (const task of tasks) {
    const existing = grouped.get(task.storeId);
    if (existing === undefined) grouped.set(task.storeId, [task]);
    else existing.push(task);
  }
  return grouped;
};

/**
 * Expresses already-created tasks at the shelf edge.
 *
 * Grouped by store because capabilities and batch limits are a property of the
 * fleet in a building, and batched because a gateway that accepts fifty commands
 * at once should not be asked fifty times. A fleet whose ladder bottoms out at
 * `none` is never called at all: the port's own answer to "can you express this?"
 * is already known, and a round trip to be told so would only add latency to work
 * that has to be routed elsewhere regardless.
 *
 * Commands and results are zipped positionally, as the port contracts. An adapter
 * that returns a short list is treated as having failed the commands it did not
 * answer for, rather than silently leaving them counted as lit.
 */
export async function expressTasks(
  deps: EslDependencies,
  request: {
    readonly retailerId: RetailerId;
    readonly tasks: readonly Task[];
    readonly at: Instant;
    readonly policy?: TaskDispatchPolicy;
  },
): Promise<readonly TaskDispatch[]> {
  const policy = request.policy ?? STANDARD_TASK_DISPATCH_POLICY;
  const dispatches = new Map<TaskId, TaskDispatch>();

  for (const [storeId, tasks] of groupByStore(request.tasks)) {
    for (const task of tasks) assertSameRetailer(request.retailerId, task, 'expressTasks');

    const capabilities = await deps.esl.describeCapabilities(request.retailerId, storeId);
    if (!canExpress(capabilities)) {
      for (const task of tasks) {
        dispatches.set(task.taskId, {
          task,
          command: null,
          result: { status: 'unavailable', reason: 'no_supported_mode', retryAfter: null },
          routeElsewhere: true,
        });
      }
      continue;
    }

    const planned = tasks.map((task) => ({
      task,
      command: buildExpressCommand(task, capabilities, request.at, policy),
    }));

    for (const batch of chunk(planned, capabilities.batchLimit)) {
      const results = await deps.esl.expressBatch({
        retailerId: request.retailerId,
        storeId,
        commands: batch.map((entry) => entry.command),
      });

      batch.forEach(({ task, command }, index) => {
        const result: EslActuationResult = results[index] ?? {
          status: 'unavailable',
          reason: 'fleet_unreachable',
          retryAfter: null,
        };
        dispatches.set(task.taskId, {
          task,
          command,
          result,
          routeElsewhere: result.status === 'unavailable' || result.mode === 'none',
        });
      });
    }
  }

  // Returned in the order the caller asked for, which is worklist order — the
  // store-by-store grouping is an efficiency of the fleet, not a re-prioritisation.
  return request.tasks.map(
    (task) =>
      dispatches.get(task.taskId) ?? {
        task,
        command: null,
        result: { status: 'unavailable', reason: 'fleet_unreachable', retryAfter: null },
        routeElsewhere: true,
      },
  );
}

/**
 * Creates typed tasks from a ranked worklist and expresses them at the shelf.
 *
 * The one entry point the dispatch side of the loop is driven through.
 */
export async function dispatchTasks(
  deps: EslDependencies,
  request: PlanTasksRequest,
): Promise<DispatchTasksResult> {
  const tasks = planTasks(request);
  const dispatches = await expressTasks(deps, {
    retailerId: request.retailerId,
    tasks,
    at: request.at,
    ...(request.policy === undefined ? {} : { policy: request.policy }),
  });

  return {
    retailerId: request.retailerId,
    dispatches,
    routedElsewhere: dispatches.filter((entry) => entry.routeElsewhere).map((entry) => entry.task),
  };
}
