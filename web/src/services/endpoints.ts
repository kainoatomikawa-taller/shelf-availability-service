import type { AvailabilityRecordQuery, AvailabilityRecordSort } from '../models/availability';
import type { TaskQueueFilter, TaskQueueSort } from '../models/task-queue';
import type { PageRequest } from '../models/paging';
import type { ReportScope } from '../models/scope';
import { toISO } from '../models/time';
import type { QueryParams } from './http-client';

/**
 * The reporting endpoints, and the one place a scope becomes a URL.
 *
 * Paths are retailer-prefixed rather than carrying the retailer as a query
 * parameter. That mirrors the read side exactly: the partition is not a filter
 * that can be dropped or defaulted, it is the address of the data, and a request
 * with no retailer in its path is not a broader query — it is not a query at all.
 */
export const REPORTING_SCHEMA_VERSION = '1.0';

export const paths = {
  availabilityIndex: (retailer: string): string =>
    `/retailers/${encodeURIComponent(retailer)}/reports/availability-index`,
  availabilityRecords: (retailer: string): string =>
    `/retailers/${encodeURIComponent(retailer)}/reports/availability-records`,
  taskWorkRate: (retailer: string): string =>
    `/retailers/${encodeURIComponent(retailer)}/reports/task-work-rate`,
  resolvedGapRate: (retailer: string): string =>
    `/retailers/${encodeURIComponent(retailer)}/reports/resolved-gap-rate`,
  detectionToResolution: (retailer: string): string =>
    `/retailers/${encodeURIComponent(retailer)}/reports/detection-to-resolution`,
  adoption: (retailer: string): string =>
    `/retailers/${encodeURIComponent(retailer)}/reports/adoption`,
  storeAdoption: (retailer: string): string =>
    `/retailers/${encodeURIComponent(retailer)}/reports/adoption/stores`,
  departmentalOutcomes: (retailer: string): string =>
    `/retailers/${encodeURIComponent(retailer)}/reports/departmental-outcomes`,
  taskQueues: (retailer: string): string =>
    `/retailers/${encodeURIComponent(retailer)}/task-queues`,
  taskQueueItems: (retailer: string, queue: string): string =>
    `/retailers/${encodeURIComponent(retailer)}/task-queues/${encodeURIComponent(queue)}/items`,
  reportableTaskTypes: (retailer: string): string =>
    `/retailers/${encodeURIComponent(retailer)}/reports/task-types`,
} as const;

/**
 * A scope as query parameters.
 *
 * `retailerId` is deliberately absent — it is already in the path, and sending
 * it twice would create a shape where the two could disagree.
 */
export const scopeQuery = (scope: ReportScope): QueryParams => ({
  from: toISO(scope.window.from),
  to: toISO(scope.window.to),
  granularity: scope.granularity,
  storeId: scope.storeIds === null ? null : (scope.storeIds as readonly string[]),
  productId: scope.productIds === null ? null : (scope.productIds as readonly string[]),
  breakdownBy: scope.breakdownBy.length === 0 ? null : (scope.breakdownBy as readonly string[]),
});

export const pageQuery = (page: PageRequest): QueryParams => ({
  limit: page.limit,
  cursor: page.cursor,
});

export const availabilityRecordQuery = (query: AvailabilityRecordQuery): QueryParams => ({
  ...scopeQuery(query.scope),
  ...pageQuery(query.page),
  sort: query.sort satisfies AvailabilityRecordSort,
  minGapCount: query.minGapCount,
});

export const taskQueueQuery = (filter: TaskQueueFilter): QueryParams => ({
  storeId: filter.storeIds === null ? null : (filter.storeIds as readonly string[]),
  taskType: filter.taskTypes === null ? null : (filter.taskTypes as readonly string[]),
  status: filter.statuses === null ? null : (filter.statuses as readonly string[]),
  priority: filter.priorities === null ? null : (filter.priorities as readonly string[]),
  unassignedOnly: filter.unassignedOnly ? true : null,
});

export const taskQueueItemQuery = (
  filter: TaskQueueFilter,
  sort: TaskQueueSort,
  page: PageRequest,
): QueryParams => ({
  ...taskQueueQuery(filter),
  ...pageQuery(page),
  sort,
});
