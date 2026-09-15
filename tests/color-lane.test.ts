import { describe, expect, it } from 'vitest';
import {
  LED_COLORS,
  LaneMappingError,
  RESERVED_LANES,
  STANDARD_COLOR_LANES,
  TASK_TYPES,
  isReservedLane,
  laneFor,
  resolveColorLaneMap,
  taskTypeForLane,
  unwrap,
  type RetailerLaneOverride,
} from '../src/index.js';
import { ACME, RIVAL } from './support/fixtures.js';

const override = (lanes: RetailerLaneOverride['lanes']): RetailerLaneOverride => ({
  retailerId: ACME,
  lanes,
});

describe('LED colour lanes — the standard mapping', () => {
  it('assigns every task type a lane', () => {
    for (const type of TASK_TYPES) {
      expect(LED_COLORS).toContain(STANDARD_COLOR_LANES[type]);
    }
  });

  it('keeps lanes exclusive so one lit colour means one job', () => {
    const colors = TASK_TYPES.map((type) => STANDARD_COLOR_LANES[type]);

    expect(new Set(colors).size).toBe(TASK_TYPES.length);
  });

  it('never assigns a reserved colour to a task lane', () => {
    for (const type of TASK_TYPES) {
      expect(isReservedLane(STANDARD_COLOR_LANES[type])).toBe(false);
    }
    expect(RESERVED_LANES.green).toBe('shopper_pick_guidance');
  });

  it('is what a retailer gets when it has no override', () => {
    const lanes = unwrap(resolveColorLaneMap(ACME));

    expect(lanes.lanes).toEqual(STANDARD_COLOR_LANES);
    expect(lanes.overriddenTypes).toEqual([]);
    expect(lanes.retailerId).toBe(ACME);
  });
});

describe('LED colour lanes — retailer overrides', () => {
  it('applies a partial override on top of the standard mapping', () => {
    const lanes = unwrap(
      resolveColorLaneMap(
        ACME,
        override({ restock_out_of_stock: 'teal', audit_count: 'red' }),
      ),
    );

    expect(laneFor(lanes, 'restock_out_of_stock')).toBe('teal');
    expect(laneFor(lanes, 'audit_count')).toBe('red');
    // Untouched lanes keep the platform default.
    expect(laneFor(lanes, 'misplaced_product')).toBe(STANDARD_COLOR_LANES.misplaced_product);
    expect([...lanes.overriddenTypes].sort()).toEqual(['audit_count', 'restock_out_of_stock']);
  });

  it('rejects an override that claims a reserved colour', () => {
    const result = resolveColorLaneMap(ACME, override({ spoilage_removal: 'green' }));

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBeInstanceOf(LaneMappingError);
    expect(result.ok === false && result.error.message).toContain('shopper_pick_guidance');
  });

  it('rejects an override that collides with a lane it never mentioned', () => {
    // Moving restock onto amber leaves low-stock replenishment on amber too.
    const result = resolveColorLaneMap(ACME, override({ restock_out_of_stock: 'amber' }));

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.message).toContain('exclusive');
  });

  it('accepts a straight swap of two lanes', () => {
    const lanes = unwrap(
      resolveColorLaneMap(
        ACME,
        override({ restock_out_of_stock: 'amber', replenish_low_stock: 'red' }),
      ),
    );

    expect(laneFor(lanes, 'restock_out_of_stock')).toBe('amber');
    expect(laneFor(lanes, 'replenish_low_stock')).toBe('red');
  });

  it('does not count an override that restates the default as an override', () => {
    const lanes = unwrap(
      resolveColorLaneMap(ACME, override({ restock_out_of_stock: 'red' })),
    );

    expect(lanes.overriddenTypes).toEqual([]);
  });

  it("refuses to apply another retailer's override", () => {
    const foreign: RetailerLaneOverride = { retailerId: RIVAL, lanes: { audit_count: 'red' } };
    const result = resolveColorLaneMap(ACME, foreign);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.message).toContain(RIVAL);
  });

  it('resolves a lit lane back to the task type for that retailer only', () => {
    const acme = unwrap(resolveColorLaneMap(ACME, override({ restock_out_of_stock: 'teal', audit_count: 'red' })));
    const standard = unwrap(resolveColorLaneMap(RIVAL));

    expect(taskTypeForLane(acme, 'red')).toBe('audit_count');
    expect(taskTypeForLane(standard, 'red')).toBe('restock_out_of_stock');
    expect(taskTypeForLane(standard, 'green')).toBeNull();
  });
});
