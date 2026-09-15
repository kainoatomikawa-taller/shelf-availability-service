/**
 * The work a store employee can be dispatched to do at a facing.
 *
 * Each type is one lane in the Carrot Tags LED mapping, which is why this union
 * is closed and exhaustively enumerated: an unmapped task type could not be lit.
 */
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

/**
 * Whether a resolved task of this type must survive the two-clean-passes check
 * before it counts as closed. Physical-stock work is verified; label and audit
 * work is confirmed by the tag itself.
 */
export const requiresShelfVerification = (type: TaskType): boolean => {
  switch (type) {
    case 'restock_out_of_stock':
    case 'replenish_low_stock':
    case 'misplaced_product':
    case 'planogram_correction':
    case 'spoilage_removal':
      return true;
    case 'price_label_correction':
    case 'tag_maintenance':
    case 'audit_count':
      return false;
  }
};

export const TASK_PRIORITIES = [
  'low',
  'normal',
  'high',
  'critical',
] as const satisfies readonly TaskPriority[];

/**
 * One step up the urgency ladder, saturating at `critical`.
 *
 * Used when work bounces back: a facing that was reported fixed and is still
 * empty has already cost the retailer one dispatch, so it re-enters the worklist
 * above where it sat the first time rather than at the same urgency that failed.
 */
export function raisePriority(priority: TaskPriority, steps = 1): TaskPriority {
  if (steps <= 0) return priority;
  const raised = TASK_PRIORITIES.indexOf(priority) + Math.floor(steps);
  return TASK_PRIORITIES[Math.min(raised, TASK_PRIORITIES.length - 1)] ?? 'critical';
}
