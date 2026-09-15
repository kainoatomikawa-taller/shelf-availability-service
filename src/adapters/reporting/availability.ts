import type { ProductId, RetailerId, StoreId } from '../../domain/common/ids.js';
import type { TimeWindow } from '../../domain/common/time.js';
import {
  computeAvailabilityIndex,
  computeFacingAvailability,
  timelineFor,
  type FacingTimeline,
} from '../../domain/availability/availability-index.js';
import { eventsWithin, stateAt } from '../../domain/facing/event-history.js';
import type { SignalSource } from '../../domain/facing/signals.js';
import { baselinePoint } from '../../application/availability-baseline.use-case.js';
import type {
  AvailabilityIndexPoint,
  AvailabilityRecord,
  AvailabilityRecordSort,
  ReportBreakdown,
  ReportDimension,
} from '../../ports/inbound/reporting.port.js';
import type { ReportingFacing } from './read-model.js';

/**
 * Projecting retained facings onto the read side's published shapes.
 *
 * Every figure here comes out of `computeAvailabilityIndex` — the same function
 * the live index and the prior baseline use. That is the point: a retailer
 * comparing "availability now" against "availability before we bought this" is
 * comparing two runs of one definition, not two implementations that agree until
 * the day they do not.
 */

/** Dimensions a *facing* can actually be cut by. */
export type AvailabilityDimension = 'store' | 'product' | 'department' | 'category' | 'aisle';

const AVAILABILITY_DIMENSIONS: readonly ReportDimension[] = [
  'store',
  'product',
  'department',
  'category',
  'aisle',
];

/**
 * Whether the availability read model can cut by this dimension.
 *
 * `task_type` cannot: it is a property of the work raised at a facing, not of the
 * facing's own time in stock, and "availability by task type" is not a question
 * with an answer. Returning an empty breakdown for it would be the same quiet
 * omission the audit export refuses to make, so the caller is told instead.
 */
export const isAvailabilityDimension = (
  dimension: ReportDimension,
): dimension is AvailabilityDimension => AVAILABILITY_DIMENSIONS.includes(dimension);

export const availabilityKeyOf = (
  entry: ReportingFacing,
  dimension: AvailabilityDimension,
): string => {
  switch (dimension) {
    case 'store':
      return entry.facing.storeId;
    case 'product':
      return entry.facing.productId;
    case 'department':
      return entry.classification.departmentId;
    case 'category':
      return entry.classification.categoryId;
    case 'aisle':
      return entry.facing.location.aisle;
  }
};

export const indexPointFor = (
  retailerId: RetailerId,
  facings: readonly ReportingFacing[],
  window: TimeWindow,
): AvailabilityIndexPoint => {
  const timelines: FacingTimeline[] = facings.map((entry) => timelineFor(entry.facing, window));
  return baselinePoint(computeAvailabilityIndex(retailerId, timelines, window));
};

export function availabilityBreakdowns(
  retailerId: RetailerId,
  facings: readonly ReportingFacing[],
  dimensions: readonly AvailabilityDimension[],
  window: TimeWindow,
): readonly ReportBreakdown<AvailabilityIndexPoint>[] {
  return dimensions.flatMap((dimension) => {
    const grouped = new Map<string, ReportingFacing[]>();
    for (const entry of facings) {
      const key = availabilityKeyOf(entry, dimension);
      const existing = grouped.get(key);
      if (existing === undefined) grouped.set(key, [entry]);
      else existing.push(entry);
    }
    return [...grouped]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, slice]) => ({
        dimension: dimension satisfies ReportDimension,
        key,
        label: key,
        value: indexPointFor(retailerId, slice, window),
      }));
  });
}

/**
 * One facing's row: the level a retailer drills to when they dispute a number.
 *
 * `gapCount` counts transitions *into* out-of-stock inside the window, not the
 * number of facings found empty. A facing that went out and came back three times
 * is three gaps and three dispatches, and reporting it as one would flatter both
 * the shelf and the store's workload.
 */
export function availabilityRecordFor(
  entry: ReportingFacing,
  window: TimeWindow,
): AvailabilityRecord {
  const { facing } = entry;
  const events = eventsWithin(facing.history, window);
  const availability = computeFacingAvailability(timelineFor(facing, window), window);

  const sources = new Set<SignalSource>();
  for (const event of events) sources.add(event.cause.source);

  return {
    retailerId: facing.retailerId,
    storeId: facing.storeId,
    facingId: facing.facingId,
    productId: facing.productId,
    location: facing.location,
    window,
    stateAtWindowStart: stateAt(facing.history, window.from),
    stateAtWindowEnd: stateAt(facing.history, window.to),
    inStockMillis: availability.inStockMillis,
    outOfStockMillis: availability.outOfStockMillis,
    unknownMillis: availability.unknownMillis,
    measuredMillis: availability.measuredMillis,
    coverage: availability.coverage,
    index: availability.index,
    gapCount: events.filter((event) => event.to === 'out_of_stock').length,
    contributingSources: [...sources],
  };
}

/**
 * Orders records for listing.
 *
 * Two rules, both there to stop a paged listing lying. A `null` index sorts last
 * under every ordering, ascending included: "we could not measure this facing" is
 * not the worst availability in the store, and a worst-first worklist that opens
 * with unmeasured rows sends somebody to walk shelves that may be perfectly full.
 * And facing id is the tie-break on every ordering, because an order that is not
 * total reshuffles between calls, and a cursor into a reshuffled list drops rows
 * and repeats others with nothing to show that it happened.
 */
export function sortAvailabilityRecords(
  records: readonly AvailabilityRecord[],
  sort: AvailabilityRecordSort,
): readonly AvailabilityRecord[] {
  const nullsLast = (
    a: number | null,
    b: number | null,
    compare: (x: number, y: number) => number,
  ): number => (a === null ? (b === null ? 0 : 1) : b === null ? -1 : compare(a, b));

  const primary = (a: AvailabilityRecord, b: AvailabilityRecord): number => {
    switch (sort) {
      case 'index_asc':
        return nullsLast(a.index, b.index, (x, y) => x - y);
      case 'index_desc':
        return nullsLast(a.index, b.index, (x, y) => y - x);
      case 'out_of_stock_millis_desc':
        return b.outOfStockMillis - a.outOfStockMillis;
      case 'gap_count_desc':
        return b.gapCount - a.gapCount;
      case 'coverage_asc':
        return a.coverage - b.coverage;
    }
  };

  return [...records].sort((a, b) => {
    const ranked = primary(a, b);
    return ranked === 0 ? a.facingId.localeCompare(b.facingId) : ranked;
  });
}

/** Facings the selector keeps. */
export const matchesScope = (
  entry: ReportingFacing,
  storeIds: readonly StoreId[] | null,
  productIds: readonly ProductId[] | null,
): boolean =>
  (storeIds === null || storeIds.includes(entry.facing.storeId)) &&
  (productIds === null || productIds.includes(entry.facing.productId));
