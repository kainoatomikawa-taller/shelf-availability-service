import { LaneMappingError } from '../common/errors.js';
import type { RetailerId } from '../common/ids.js';
import type { RetailerPartitioned } from '../common/partition.js';
import { err, ok, type Result } from '../common/result.js';
import { TASK_TYPES, type TaskType } from './task-type.js';

/** Colors a Carrot Tags LED can be driven to. */
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

/**
 * Colors the platform holds back from the task lanes entirely.
 *
 * Green already means "pick this for an order" on every Carrot Tag in the estate.
 * Letting a retailer rebind it to, say, spoilage removal would make the same light
 * mean two things on the same shelf, so reserved colors are rejected at
 * configuration time rather than causing a floor-level ambiguity.
 */
export const RESERVED_LANES: Readonly<Partial<Record<LedColor, string>>> = {
  green: 'shopper_pick_guidance',
};

export const isReservedLane = (color: LedColor): boolean => color in RESERVED_LANES;

/** A total, bijective assignment of task types to LED colors. */
export type ColorLaneMap = Readonly<Record<TaskType, LedColor>>;

/**
 * The standard lane mapping shipped by the platform. Retailers inherit this
 * unless they override — see `resolveColorLaneMap`.
 */
export const STANDARD_COLOR_LANES: ColorLaneMap = {
  restock_out_of_stock: 'red',
  replenish_low_stock: 'amber',
  misplaced_product: 'blue',
  planogram_correction: 'purple',
  price_label_correction: 'cyan',
  tag_maintenance: 'white',
  spoilage_removal: 'pink',
  audit_count: 'teal',
};

/** A retailer's partial deviation from the standard mapping. */
export interface RetailerLaneOverride extends RetailerPartitioned {
  readonly retailerId: RetailerId;
  readonly lanes: Readonly<Partial<Record<TaskType, LedColor>>>;
}

/** The mapping actually in force for one retailer partition. */
export interface RetailerColorLanes extends RetailerPartitioned {
  readonly retailerId: RetailerId;
  readonly lanes: ColorLaneMap;
  /** Task types whose lane differs from `STANDARD_COLOR_LANES`. */
  readonly overriddenTypes: readonly TaskType[];
}

/**
 * Merges a retailer override onto the standard mapping and validates the result.
 *
 * Validation is on the merged map, not the override, because a partial override
 * can collide with a standard lane it never mentions — swapping one type's color
 * onto another's is exactly how two lanes end up sharing a light.
 */
export function resolveColorLaneMap(
  retailerId: RetailerId,
  override?: RetailerLaneOverride,
): Result<RetailerColorLanes, LaneMappingError> {
  if (override !== undefined && override.retailerId !== retailerId) {
    return err(
      new LaneMappingError(
        `Lane override belongs to retailer "${override.retailerId}" and cannot be applied to "${retailerId}"`,
      ),
    );
  }

  const lanes: Record<TaskType, LedColor> = { ...STANDARD_COLOR_LANES };
  const overriddenTypes: TaskType[] = [];

  for (const taskType of TASK_TYPES) {
    const requested = override?.lanes[taskType];
    if (requested === undefined) continue;

    if (isReservedLane(requested)) {
      return err(
        new LaneMappingError(
          `Lane "${requested}" is reserved for ${RESERVED_LANES[requested]} and cannot be assigned to task type "${taskType}"`,
        ),
      );
    }
    if (!LED_COLORS.includes(requested)) {
      return err(new LaneMappingError(`Unknown LED color "${requested}"`));
    }

    lanes[taskType] = requested;
    if (requested !== STANDARD_COLOR_LANES[taskType]) {
      overriddenTypes.push(taskType);
    }
  }

  const seen = new Map<LedColor, TaskType>();
  for (const taskType of TASK_TYPES) {
    const color = lanes[taskType];
    const claimedBy = seen.get(color);
    if (claimedBy !== undefined) {
      return err(
        new LaneMappingError(
          `Lane "${color}" is claimed by both "${claimedBy}" and "${taskType}"; lanes must be exclusive`,
        ),
      );
    }
    seen.set(color, taskType);
  }

  return ok({ retailerId, lanes, overriddenTypes });
}

export const laneFor = (lanes: RetailerColorLanes, type: TaskType): LedColor => lanes.lanes[type];

/** Reverse lookup: which task type a lit lane represents for this retailer. */
export function taskTypeForLane(lanes: RetailerColorLanes, color: LedColor): TaskType | null {
  for (const taskType of TASK_TYPES) {
    if (lanes.lanes[taskType] === color) return taskType;
  }
  return null;
}
