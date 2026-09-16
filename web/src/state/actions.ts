import type { RequestId } from '../models/async-data';
import type { AvailabilityRecordSort } from '../models/availability';
import type { QueueId, ProductId, StoreId } from '../models/ids';
import type { ReportDimension, ReportGranularity, ReportScope } from '../models/scope';
import type { ServiceError } from '../services/errors';
import type { TaskQueueFilter, TaskQueueSort } from '../models/task-queue';
import type { Instant, TimeWindow } from '../models/time';
import type { SliceName, SliceValue } from './dashboard-state';

/**
 * A settled request, typed against the slice it settled.
 *
 * Built as a mapped union rather than `value: unknown` so the reducer cannot put
 * an adoption report into the availability slice — the exact class of mistake a
 * generic fetch pipeline invites, and one that would show up as a runtime
 * "cannot read property of undefined" three components downstream.
 */
export type FetchSucceeded = {
  [S in SliceName]: {
    readonly kind: 'fetch/succeeded';
    readonly slice: S;
    readonly requestId: RequestId;
    readonly at: Instant;
    readonly value: SliceValue<S>;
  };
}[SliceName];

export type DashboardAction =
  // --- Scope -------------------------------------------------------------
  | { readonly kind: 'scope/replaced'; readonly scope: ReportScope }
  | { readonly kind: 'scope/window_changed'; readonly window: TimeWindow }
  | { readonly kind: 'scope/granularity_changed'; readonly granularity: ReportGranularity }
  | { readonly kind: 'scope/stores_changed'; readonly storeIds: readonly StoreId[] | null }
  | { readonly kind: 'scope/products_changed'; readonly productIds: readonly ProductId[] | null }
  | { readonly kind: 'scope/breakdown_changed'; readonly breakdownBy: readonly ReportDimension[] }

  // --- Clock -------------------------------------------------------------
  | { readonly kind: 'clock/ticked'; readonly now: Instant }

  // --- Queue controls ----------------------------------------------------
  | { readonly kind: 'queue/selected'; readonly queueId: QueueId | null }
  | { readonly kind: 'queue/filter_changed'; readonly filter: TaskQueueFilter }
  | { readonly kind: 'queue/sort_changed'; readonly sort: TaskQueueSort }
  | { readonly kind: 'records/sort_changed'; readonly sort: AvailabilityRecordSort }

  // --- Request lifecycle -------------------------------------------------
  /**
   * No `requestId` — the reducer mints it.
   *
   * Allocating the id in the pure reducer rather than in the effect keeps the
   * counter in the state it belongs to: two effects starting in the same tick
   * cannot read the same "next" id and then both claim to be the current
   * request for their slice.
   */
  | { readonly kind: 'fetch/started'; readonly slice: SliceName; readonly at: Instant }
  | FetchSucceeded
  | {
      readonly kind: 'fetch/failed';
      readonly slice: SliceName;
      readonly requestId: RequestId;
      readonly at: Instant;
      readonly error: ServiceError;
    };

export const scopeReplaced = (scope: ReportScope): DashboardAction => ({
  kind: 'scope/replaced',
  scope,
});

export const windowChanged = (window: TimeWindow): DashboardAction => ({
  kind: 'scope/window_changed',
  window,
});

export const granularityChanged = (granularity: ReportGranularity): DashboardAction => ({
  kind: 'scope/granularity_changed',
  granularity,
});

export const storesChanged = (storeIds: readonly StoreId[] | null): DashboardAction => ({
  kind: 'scope/stores_changed',
  storeIds,
});

export const clockTicked = (now: Instant): DashboardAction => ({ kind: 'clock/ticked', now });

export const queueSelected = (queueId: QueueId | null): DashboardAction => ({
  kind: 'queue/selected',
  queueId,
});

export const queueFilterChanged = (filter: TaskQueueFilter): DashboardAction => ({
  kind: 'queue/filter_changed',
  filter,
});

export const queueSortChanged = (sort: TaskQueueSort): DashboardAction => ({
  kind: 'queue/sort_changed',
  sort,
});

export const recordSortChanged = (sort: AvailabilityRecordSort): DashboardAction => ({
  kind: 'records/sort_changed',
  sort,
});

export const fetchStarted = (slice: SliceName, at: Instant): DashboardAction => ({
  kind: 'fetch/started',
  slice,
  at,
});

export const fetchSucceeded = <S extends SliceName>(
  slice: S,
  requestId: RequestId,
  at: Instant,
  value: SliceValue<S>,
): DashboardAction =>
  ({ kind: 'fetch/succeeded', slice, requestId, at, value }) as DashboardAction;

export const fetchFailed = (
  slice: SliceName,
  requestId: RequestId,
  at: Instant,
  error: ServiceError,
): DashboardAction => ({ kind: 'fetch/failed', slice, requestId, at, error });
