import type { ShelfState, SignalSource } from './enums';
import type { FacingId, ProductId, RetailerId, StoreId } from './ids';
import type { PageRequest } from './paging';
import type { ReportEnvelope, ReportScope } from './scope';
import type { Millis, Ratio, TimeWindow } from './time';

/** Where a facing physically sits. */
export interface FacingLocation {
  readonly aisle: string;
  readonly bay: string;
  readonly shelf: number;
  /** Left-to-right index of the facing within the shelf. */
  readonly position: number;
}

export const formatFacingLocation = (location: FacingLocation): string =>
  `Aisle ${location.aisle} · Bay ${location.bay} · Shelf ${location.shelf}.${location.position}`;

/**
 * One bucket of the availability index.
 *
 * The numerator and denominator ride alongside the ratio so a chart can
 * re-aggregate buckets without a second request, and so a figure computed from a
 * sliver of measured time can be *shown* as untrustworthy rather than plotted
 * with the same confidence as a fully observed one. `index` is `null` — never
 * `0` — when nothing was measured, and every component here must render that
 * null as "not measured", not as a zero.
 */
export interface AvailabilityIndexPoint {
  readonly window: TimeWindow;
  readonly index: Ratio | null;
  readonly coverage: Ratio;
  readonly inStockFacingMillis: Millis;
  readonly measuredFacingMillis: Millis;
  readonly unknownFacingMillis: Millis;
  readonly facingCount: number;
}

export type AvailabilityIndexReport = ReportEnvelope<AvailabilityIndexPoint>;

/**
 * Per-facing availability over the window — the row-level record the index rolls
 * up from, and the level a retailer drills to when they dispute a number.
 */
export interface AvailabilityRecord {
  readonly retailerId: RetailerId;
  readonly storeId: StoreId;
  readonly facingId: FacingId;
  readonly productId: ProductId;
  readonly location: FacingLocation;
  readonly window: TimeWindow;
  readonly stateAtWindowStart: ShelfState;
  readonly stateAtWindowEnd: ShelfState;
  readonly inStockMillis: Millis;
  readonly outOfStockMillis: Millis;
  readonly unknownMillis: Millis;
  readonly measuredMillis: Millis;
  readonly coverage: Ratio;
  readonly index: Ratio | null;
  /** Out-of-stock transitions observed in the window. */
  readonly gapCount: number;
  /** Sources that contributed evidence, for judging how well observed the facing was. */
  readonly contributingSources: readonly SignalSource[];
}

/** Ordering for availability record listings. Worst-first is the operational default. */
export type AvailabilityRecordSort =
  | 'index_asc'
  | 'index_desc'
  | 'out_of_stock_millis_desc'
  | 'gap_count_desc'
  | 'coverage_asc';

export const AVAILABILITY_RECORD_SORTS = [
  'index_asc',
  'index_desc',
  'out_of_stock_millis_desc',
  'gap_count_desc',
  'coverage_asc',
] as const satisfies readonly AvailabilityRecordSort[];

export const DEFAULT_AVAILABILITY_RECORD_SORT: AvailabilityRecordSort = 'index_asc';

export interface AvailabilityRecordQuery {
  readonly scope: ReportScope;
  readonly sort: AvailabilityRecordSort;
  /** `null` returns every facing in scope. */
  readonly minGapCount: number | null;
  readonly page: PageRequest;
}

/** Stable row key for a record — a facing is unique within its store. */
export const availabilityRecordKey = (record: AvailabilityRecord): string =>
  `${record.storeId}/${record.facingId}`;
