import type { FacingId, RetailerId, StoreId } from '../common/ids.js';
import { assertSameRetailer, type RetailerPartitioned } from '../common/partition.js';
import { millis, overlapMillis, windowDuration, type Millis, type TimeWindow } from '../common/time.js';
import type { Facing } from '../facing/facing.js';
import { eventsWithin, stateAt, type FacingStateEvent } from '../facing/event-history.js';
import type { ShelfState } from '../facing/shelf-state.js';

/**
 * A facing's state as a step function over a window: the state it carried in at
 * `window.from`, plus every transition inside the window.
 *
 * Carry-in state is explicit because a facing that went out of stock last night
 * must accrue out-of-stock time from the first second of today's window, not from
 * whenever the next event happens to land.
 */
export interface FacingTimeline extends RetailerPartitioned {
  readonly retailerId: RetailerId;
  readonly storeId: StoreId;
  readonly facingId: FacingId;
  readonly stateAtWindowStart: ShelfState;
  /** Transitions inside the window, ascending by `at`. */
  readonly events: readonly FacingStateEvent[];
}

/** Projects a facing's history onto a window, ready for the index. */
export const timelineFor = (facing: Facing, window: TimeWindow): FacingTimeline => ({
  retailerId: facing.retailerId,
  storeId: facing.storeId,
  facingId: facing.facingId,
  stateAtWindowStart: stateAt(facing.history, window.from),
  events: eventsWithin(facing.history, window),
});

export interface FacingAvailability extends RetailerPartitioned {
  readonly retailerId: RetailerId;
  readonly facingId: FacingId;
  readonly window: TimeWindow;
  readonly inStockMillis: Millis;
  readonly outOfStockMillis: Millis;
  /** Time with no usable evidence. Excluded from the index denominator. */
  readonly unknownMillis: Millis;
  /** `inStockMillis + outOfStockMillis` — the facing-time the index is scored over. */
  readonly measuredMillis: Millis;
  /** `measuredMillis / windowMillis`. How much of the window we could actually judge. */
  readonly coverage: number;
  /** `inStockMillis / measuredMillis`, or `null` when nothing was measured. */
  readonly index: number | null;
}

/**
 * Availability index for a single facing over a window.
 *
 *   index = in-stock facing-time / measured facing-time
 *
 * Unknown time is excluded from both numerator and denominator rather than
 * counted as available (which would flatter the score) or unavailable (which
 * would punish a retailer for a camera outage). `coverage` is reported alongside
 * so a high index computed from a sliver of the window is visibly untrustworthy.
 */
export function computeFacingAvailability(
  timeline: FacingTimeline,
  window: TimeWindow,
): FacingAvailability {
  const totals: Record<ShelfState, number> = { in_stock: 0, out_of_stock: 0, unknown: 0 };

  let cursor = window.from;
  let state = timeline.stateAtWindowStart;

  for (const event of timeline.events) {
    assertSameRetailer(timeline.retailerId, event, 'computeFacingAvailability');
    if (event.at <= cursor) {
      // Carry-in already accounts for anything at or before the window start;
      // a zero-length segment contributes nothing but must still advance state.
      state = event.to;
      continue;
    }
    if (event.at >= window.to) break;

    totals[state] += overlapMillis(window, cursor, event.at);
    cursor = event.at;
    state = event.to;
  }

  totals[state] += overlapMillis(window, cursor, window.to);

  const inStockMillis = millis(totals.in_stock);
  const outOfStockMillis = millis(totals.out_of_stock);
  const unknownMillis = millis(totals.unknown);
  const measuredMillis = millis(inStockMillis + outOfStockMillis);
  const totalWindow = windowDuration(window);

  return {
    retailerId: timeline.retailerId,
    facingId: timeline.facingId,
    window,
    inStockMillis,
    outOfStockMillis,
    unknownMillis,
    measuredMillis,
    coverage: totalWindow === 0 ? 0 : measuredMillis / totalWindow,
    index: measuredMillis === 0 ? null : inStockMillis / measuredMillis,
  };
}

export interface AvailabilityIndex extends RetailerPartitioned {
  /** Partition key. An index is always *a retailer's* index — never a pooled one. */
  readonly retailerId: RetailerId;
  readonly window: TimeWindow;
  readonly facingCount: number;
  readonly inStockFacingMillis: Millis;
  readonly measuredFacingMillis: Millis;
  readonly unknownFacingMillis: Millis;
  readonly coverage: number;
  readonly index: number | null;
  readonly perFacing: readonly FacingAvailability[];
}

/**
 * Availability index over a set of facings in one retailer partition.
 *
 *   index = Σ in-stock facing-time / Σ measured facing-time
 *
 * Facing-time weighted, not facing-count averaged: a facing observed for ten
 * minutes should not swing the number as hard as one observed all day. Mixing
 * partitions is rejected rather than silently pooled.
 */
export function computeAvailabilityIndex(
  retailerId: RetailerId,
  timelines: readonly FacingTimeline[],
  window: TimeWindow,
): AvailabilityIndex {
  const perFacing: FacingAvailability[] = [];
  let inStock = 0;
  let measured = 0;
  let unknown = 0;

  for (const timeline of timelines) {
    assertSameRetailer(retailerId, timeline, 'computeAvailabilityIndex');
    const availability = computeFacingAvailability(timeline, window);
    perFacing.push(availability);
    inStock += availability.inStockMillis;
    measured += availability.measuredMillis;
    unknown += availability.unknownMillis;
  }

  const denominator = millis(measured);
  const observable = windowDuration(window) * timelines.length;

  return {
    retailerId,
    window,
    facingCount: timelines.length,
    inStockFacingMillis: millis(inStock),
    measuredFacingMillis: denominator,
    unknownFacingMillis: millis(unknown),
    coverage: observable === 0 ? 0 : denominator / observable,
    index: denominator === 0 ? null : inStock / denominator,
    perFacing,
  };
}
