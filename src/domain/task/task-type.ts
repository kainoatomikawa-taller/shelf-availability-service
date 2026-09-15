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
