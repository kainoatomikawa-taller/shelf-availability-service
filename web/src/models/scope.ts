import type { ProductId, RetailerId, StoreId } from './ids';
import type { Instant, TimeWindow } from './time';

/** Rollup grain for a time series. `period` returns a single bucket for the whole window. */
export type ReportGranularity = 'hour' | 'day' | 'week' | 'period';

export const REPORT_GRANULARITIES = ['hour', 'day', 'week', 'period'] as const satisfies
  readonly ReportGranularity[];

/** How a report is broken down beyond the overall figure. */
export type ReportDimension = 'store' | 'product' | 'department' | 'category' | 'aisle' | 'task_type';

export const REPORT_DIMENSIONS = [
  'store',
  'product',
  'department',
  'category',
  'aisle',
  'task_type',
] as const satisfies readonly ReportDimension[];

/**
 * What every report on this dashboard is asked for.
 *
 * `retailerId` is required and there is no all-retailers shape, because the read
 * side has none: the service will not answer a question that spans two
 * partitions, so the dashboard cannot build a control that asks one.
 */
export interface ReportScope {
  readonly retailerId: RetailerId;
  /** `null` covers every store in the partition. */
  readonly storeIds: readonly StoreId[] | null;
  /** `null` covers every SKU. */
  readonly productIds: readonly ProductId[] | null;
  /** Half-open `[from, to)`. */
  readonly window: TimeWindow;
  readonly granularity: ReportGranularity;
  readonly breakdownBy: readonly ReportDimension[];
}

/** One labelled slice of a breakdown. */
export interface ReportBreakdown<T> {
  readonly dimension: ReportDimension;
  /** Dimension member: a store id, product id, department, category, aisle or task type. */
  readonly key: string;
  readonly label: string;
  readonly value: T;
}

/**
 * The shape every report shares: a single figure for the whole window, the same
 * figure bucketed, and the cuts through it.
 *
 * Generic rather than repeated four times, so a component that renders "overall
 * plus series" works against any of them.
 */
export interface ReportEnvelope<P> {
  readonly retailerId: RetailerId;
  readonly window: TimeWindow;
  readonly granularity: ReportGranularity;
  /** The whole window as one bucket. */
  readonly overall: P;
  readonly series: readonly P[];
  readonly breakdowns: readonly ReportBreakdown<P>[];
  readonly computedAt: Instant;
}

/** The breakdown slices for one dimension, in the order the service returned them. */
export const breakdownsFor = <P>(
  report: ReportEnvelope<P>,
  dimension: ReportDimension,
): readonly ReportBreakdown<P>[] =>
  report.breakdowns.filter((breakdown) => breakdown.dimension === dimension);
