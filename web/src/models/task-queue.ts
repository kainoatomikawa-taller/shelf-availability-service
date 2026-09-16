import type { LedColor, TaskPriority, TaskStatus, TaskType } from './enums';
import { TASK_PRIORITIES, isOpenTaskStatus } from './enums';
import type {
  EmployeeId,
  FacingId,
  ProductId,
  QueueId,
  RetailerId,
  StoreId,
  TaskId,
} from './ids';
import type { FacingLocation } from './availability';
import type { Instant, Millis } from './time';
import { elapsed } from './time';

/**
 * A row in a store's work queue.
 *
 * The lifecycle is flattened to `status` plus nullable timestamps here, unlike
 * the service's discriminated `TaskState`. That is deliberate and is the one
 * place the dashboard diverges from the domain shape: a queue table renders
 * every row through the same columns, so it needs "acknowledged at, or nothing"
 * rather than a union it must narrow per cell. The narrowing still happens — at
 * the decode boundary, once, where the service's state union is flattened and
 * anything it cannot account for fails the decode.
 */
export interface TaskQueueItem {
  readonly retailerId: RetailerId;
  readonly storeId: StoreId;
  readonly taskId: TaskId;
  readonly facingId: FacingId;
  readonly productId: ProductId;
  /** What the shelf label says, for a row a person has to find on a shelf. */
  readonly productName: string;
  readonly location: FacingLocation;
  readonly type: TaskType;
  readonly priority: TaskPriority;
  /** LED lane resolved when the task was raised. Shown as a swatch, never alone. */
  readonly lane: LedColor;
  readonly status: TaskStatus;
  readonly assigneeId: EmployeeId | null;
  readonly assigneeName: string | null;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
  readonly acknowledgedAt: Instant | null;
  readonly resolvedAt: Instant | null;
  /** Repeat-offender counter: how many times this task was resolved and bounced back. */
  readonly failedVerifications: number;
  readonly requiresVerification: boolean;
  /** When the task stops being workable, when the retailer set one. */
  readonly dueAt: Instant | null;
}

/** How long a task has been open, measured against the dashboard's clock. */
export const taskAge = (item: TaskQueueItem, now: Instant): Millis =>
  elapsed(item.createdAt, now);

/** Past its due time and not yet finished. Terminal tasks are never breaching. */
export const isBreaching = (item: TaskQueueItem, now: Instant): boolean =>
  item.dueAt !== null && now > item.dueAt && isOpenTaskStatus(item.status);

/**
 * The queue itself, as a store manager sees it in the sidebar: enough to decide
 * where to send someone without opening the queue.
 */
export interface TaskQueueSummary {
  readonly retailerId: RetailerId;
  readonly queueId: QueueId;
  readonly storeId: StoreId;
  readonly label: string;
  /** `null` for a mixed queue that is not cut by task type. */
  readonly taskType: TaskType | null;
  readonly openCount: number;
  readonly unassignedCount: number;
  readonly breachingCount: number;
  readonly awaitingVerificationCount: number;
  readonly countsByPriority: Readonly<Record<TaskPriority, number>>;
  readonly countsByStatus: Readonly<Record<TaskStatus, number>>;
  /** The oldest open task in the queue. `null` when the queue is empty. */
  readonly oldestOpenAt: Instant | null;
  readonly updatedAt: Instant;
}

/** Age of the oldest open task — the number that decides which queue is worked next. */
export const queueHeadAge = (summary: TaskQueueSummary, now: Instant): Millis | null =>
  summary.oldestOpenAt === null ? null : elapsed(summary.oldestOpenAt, now);

/**
 * Queues worst-first: breaches, then criticals, then the oldest head.
 *
 * Sorting by open count alone would bury a queue holding one four-hour critical
 * behind one holding forty fresh low-priority tags.
 */
export const compareQueuesByUrgency = (a: TaskQueueSummary, b: TaskQueueSummary): number =>
  b.breachingCount - a.breachingCount ||
  b.countsByPriority.critical - a.countsByPriority.critical ||
  // Oldest head first, so the earliest instant sorts first. An empty queue has
  // no head at all and sorts last rather than being treated as infinitely old.
  (a.oldestOpenAt ?? Number.POSITIVE_INFINITY) - (b.oldestOpenAt ?? Number.POSITIVE_INFINITY);

export const emptyPriorityCounts = (): Record<TaskPriority, number> =>
  TASK_PRIORITIES.reduce<Record<TaskPriority, number>>(
    (counts, priority) => ({ ...counts, [priority]: 0 }),
    { critical: 0, high: 0, normal: 0, low: 0 },
  );

/** Ordering a queue listing can be asked for. */
export type TaskQueueSort = 'priority_desc' | 'age_desc' | 'due_at_asc' | 'status_asc';

export const TASK_QUEUE_SORTS = [
  'priority_desc',
  'age_desc',
  'due_at_asc',
  'status_asc',
] as const satisfies readonly TaskQueueSort[];

export interface TaskQueueFilter {
  readonly retailerId: RetailerId;
  /** `null` covers every store the reader can see. */
  readonly storeIds: readonly StoreId[] | null;
  readonly taskTypes: readonly TaskType[] | null;
  readonly statuses: readonly TaskStatus[] | null;
  readonly priorities: readonly TaskPriority[] | null;
  /** Restrict to tasks nobody holds — the "who do I send" view. */
  readonly unassignedOnly: boolean;
}

export const taskQueueItemKey = (item: TaskQueueItem): string => item.taskId;
