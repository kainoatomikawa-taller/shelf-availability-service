/**
 * The closed unions the read side speaks in.
 *
 * These are written out here rather than imported from the domain package, for
 * the same reason the ports write their wire payloads out explicitly: a
 * published contract must not shift under an internal refactor. The cost is
 * duplication; the guard against drift is `services/contract-conformance.ts`,
 * which fails the build if the service's union gains or loses a member.
 */

/** What the shelf looks like at a facing. `unknown` is a state, not a null. */
export type ShelfState = 'in_stock' | 'out_of_stock' | 'unknown';

export const SHELF_STATES = ['in_stock', 'out_of_stock', 'unknown'] as const satisfies
  readonly ShelfState[];

/** The six detection families that can contribute evidence about a facing. */
export type SignalSource =
  | 'shopper_scan'
  | 'arpalus_detection'
  | 'caper_frame'
  | 'planogram_record'
  | 'carrot_tag_label'
  | 'pos_movement';

export const SIGNAL_SOURCES = [
  'shopper_scan',
  'arpalus_detection',
  'caper_frame',
  'planogram_record',
  'carrot_tag_label',
  'pos_movement',
] as const satisfies readonly SignalSource[];

/** The work a store employee can be dispatched to do at a facing. */
export type TaskType =
  | 'restock_out_of_stock'
  | 'replenish_low_stock'
  | 'misplaced_product'
  | 'planogram_correction'
  | 'price_label_correction'
  | 'tag_maintenance'
  | 'spoilage_removal'
  | 'audit_count';

export const TASK_TYPES = [
  'restock_out_of_stock',
  'replenish_low_stock',
  'misplaced_product',
  'planogram_correction',
  'price_label_correction',
  'tag_maintenance',
  'spoilage_removal',
  'audit_count',
] as const satisfies readonly TaskType[];

export type TaskPriority = 'critical' | 'high' | 'normal' | 'low';

/** Worst-first. The order a queue is worked in, and the order it sorts by. */
export const TASK_PRIORITIES = ['critical', 'high', 'normal', 'low'] as const satisfies
  readonly TaskPriority[];

export type TaskStatus =
  | 'created'
  | 'assigned'
  | 'acknowledged'
  | 'in_progress'
  | 'awaiting_verification'
  | 'verified'
  | 'reopened'
  | 'cancelled'
  | 'expired';

export const TASK_STATUSES = [
  'created',
  'assigned',
  'acknowledged',
  'in_progress',
  'awaiting_verification',
  'verified',
  'reopened',
  'cancelled',
  'expired',
] as const satisfies readonly TaskStatus[];

export const TERMINAL_TASK_STATUSES = ['verified', 'cancelled', 'expired'] as const satisfies
  readonly TaskStatus[];

export const isTerminalTaskStatus = (status: TaskStatus): boolean =>
  (TERMINAL_TASK_STATUSES as readonly TaskStatus[]).includes(status);

/** A task nobody has finished yet — what a queue badge counts. */
export const isOpenTaskStatus = (status: TaskStatus): boolean => !isTerminalTaskStatus(status);

/** Colors a Carrot Tags LED can be driven to. `green` is reserved for shopper pick. */
export type LedColor =
  | 'red'
  | 'amber'
  | 'green'
  | 'blue'
  | 'purple'
  | 'cyan'
  | 'white'
  | 'pink'
  | 'teal';

export const LED_COLORS = [
  'red',
  'amber',
  'green',
  'blue',
  'purple',
  'cyan',
  'white',
  'pink',
  'teal',
] as const satisfies readonly LedColor[];

/** Human labels for the unions, so no component invents its own wording. */
export const TASK_TYPE_LABELS: Readonly<Record<TaskType, string>> = {
  restock_out_of_stock: 'Restock out of stock',
  replenish_low_stock: 'Replenish low stock',
  misplaced_product: 'Misplaced product',
  planogram_correction: 'Planogram correction',
  price_label_correction: 'Price label correction',
  tag_maintenance: 'Tag maintenance',
  spoilage_removal: 'Spoilage removal',
  audit_count: 'Audit count',
};

export const TASK_STATUS_LABELS: Readonly<Record<TaskStatus, string>> = {
  created: 'Created',
  assigned: 'Assigned',
  acknowledged: 'Acknowledged',
  in_progress: 'In progress',
  awaiting_verification: 'Awaiting verification',
  verified: 'Verified',
  reopened: 'Reopened',
  cancelled: 'Cancelled',
  expired: 'Expired',
};

export const TASK_PRIORITY_LABELS: Readonly<Record<TaskPriority, string>> = {
  critical: 'Critical',
  high: 'High',
  normal: 'Normal',
  low: 'Low',
};

export const SHELF_STATE_LABELS: Readonly<Record<ShelfState, string>> = {
  in_stock: 'In stock',
  out_of_stock: 'Out of stock',
  unknown: 'Unknown',
};

export const SIGNAL_SOURCE_LABELS: Readonly<Record<SignalSource, string>> = {
  shopper_scan: 'Shopper scan',
  arpalus_detection: 'Arpalus vision',
  caper_frame: 'Caper cart',
  planogram_record: 'Planogram',
  carrot_tag_label: 'Carrot Tag',
  pos_movement: 'POS movement',
};
