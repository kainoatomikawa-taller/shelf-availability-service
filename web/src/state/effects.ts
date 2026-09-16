import type { RequestId } from '../models/async-data';
import { pendingRequestId } from '../models/async-data';
import { firstPage } from '../models/paging';
import type { ServiceResult } from '../services/http-client';
import type { DashboardApi } from '../services/reporting.client';
import type { Instant } from '../models/time';
import type { DashboardAction } from './actions';
import { fetchFailed, fetchStarted, fetchSucceeded } from './actions';
import type { DashboardState, SliceName, SliceValue } from './dashboard-state';
import type { Store } from './store';

export type DashboardStore = Store<DashboardState, DashboardAction>;

/** How many rows a table asks for at a time. */
export const PAGE_SIZE = 50;

/**
 * The side-effecting half of the state layer: call a client, turn the result
 * into actions.
 *
 * Split from the reducer the way the application layer splits a pure decision
 * function from its orchestration. Everything here is plumbing — which endpoint,
 * which slice, which controller to abort — and every decision it makes about
 * *state* is delegated to the reducer, which is why this file has no branches on
 * what the data means.
 */
export interface DashboardEffects {
  loadAvailabilityIndex(): Promise<void>;
  loadAvailabilityRecords(): Promise<void>;
  loadTaskWorkRate(): Promise<void>;
  loadResolvedGapRate(): Promise<void>;
  loadDetectionToResolution(): Promise<void>;
  loadAdoption(): Promise<void>;
  loadStoreAdoption(): Promise<void>;
  loadDepartmentalOutcomes(): Promise<void>;
  loadTaskQueues(): Promise<void>;
  loadTaskQueueItems(): Promise<void>;
  /** Every scoped report plus the live queues — what a scope change triggers. */
  loadAll(): Promise<void>;
  /** Abort everything in flight. Called when the dashboard unmounts. */
  cancelAll(): void;
}

export interface EffectsConfig {
  readonly store: DashboardStore;
  readonly api: DashboardApi;
  /** Injected so tests settle actions at a known instant instead of racing a real clock. */
  readonly clock: () => Instant;
}

export const createEffects = ({ store, api, clock }: EffectsConfig): DashboardEffects => {
  /**
   * One controller per slice, not one per request.
   *
   * A second request for the same slice supersedes the first, so the first is
   * aborted rather than left to land: the reducer would drop its result anyway,
   * and leaving it running holds a connection open against a per-retailer
   * partition for an answer nobody will read.
   */
  const inFlight = new Map<SliceName, AbortController>();

  const begin = (slice: SliceName): { signal: AbortSignal; requestId: RequestId } => {
    inFlight.get(slice)?.abort();
    const controller = new AbortController();
    inFlight.set(slice, controller);

    store.dispatch(fetchStarted(slice, clock()));
    const requestId = pendingRequestId(store.getState()[slice]);
    if (requestId === null) {
      // Unreachable: `fetch/started` always leaves the slice pending. Throwing
      // rather than defaulting keeps a reducer regression loud.
      throw new Error(`Slice "${slice}" is not pending after fetch/started`);
    }
    return { signal: controller.signal, requestId };
  };

  const settle = <S extends SliceName>(
    slice: S,
    requestId: RequestId,
    result: ServiceResult<SliceValue<S>>,
  ): void => {
    const at = clock();
    if (result.ok) {
      store.dispatch(fetchSucceeded(slice, requestId, at, result.value));
      return;
    }
    // A cancellation is this layer's own doing — the slice is already showing
    // the newer request's loading state, and reporting it as a failure would put
    // an error panel over a request that is still perfectly healthy.
    if (result.error.kind === 'cancelled') return;
    store.dispatch(fetchFailed(slice, requestId, at, result.error));
  };

  const run = async <S extends SliceName>(
    slice: S,
    call: (signal: AbortSignal) => Promise<ServiceResult<SliceValue<S>>>,
  ): Promise<void> => {
    const { signal, requestId } = begin(slice);
    settle(slice, requestId, await call(signal));
  };

  const loadAvailabilityIndex = (): Promise<void> =>
    run('availabilityIndex', (signal) => api.availabilityIndex(store.getState().scope, signal));

  const loadAvailabilityRecords = (): Promise<void> =>
    run('availabilityRecords', (signal) => {
      const state = store.getState();
      return api.availabilityRecords(
        {
          scope: state.scope,
          sort: state.recordSort,
          minGapCount: null,
          page: firstPage(PAGE_SIZE),
        },
        signal,
      );
    });

  const loadTaskWorkRate = (): Promise<void> =>
    run('taskWorkRate', (signal) => api.taskWorkRate(store.getState().scope, signal));

  const loadResolvedGapRate = (): Promise<void> =>
    run('resolvedGapRate', (signal) => api.resolvedGapRate(store.getState().scope, signal));

  const loadDetectionToResolution = (): Promise<void> =>
    run('detectionToResolution', (signal) =>
      api.detectionToResolution(store.getState().scope, signal),
    );

  const loadAdoption = (): Promise<void> =>
    run('adoption', (signal) => api.adoption(store.getState().scope, signal));

  const loadStoreAdoption = (): Promise<void> =>
    run('storeAdoption', (signal) => api.storeAdoption(store.getState().scope, signal));

  const loadDepartmentalOutcomes = (): Promise<void> =>
    run('departmentalOutcomes', (signal) =>
      api.departmentalOutcomes(store.getState().scope, signal),
    );

  const loadTaskQueues = (): Promise<void> =>
    run('taskQueues', (signal) => api.taskQueues(store.getState().queueFilter, signal));

  const loadTaskQueueItems = async (): Promise<void> => {
    const { selectedQueueId, queueFilter, queueSort } = store.getState();
    // Nothing to fetch until a queue is picked, and dispatching a load for a
    // null queue would leave the slice spinning forever.
    if (selectedQueueId === null) return;
    await run('taskQueueItems', (signal) =>
      api.taskQueueItems(selectedQueueId, queueFilter, queueSort, firstPage(PAGE_SIZE), signal),
    );
  };

  const loadAll = async (): Promise<void> => {
    // Fired together rather than sequenced: the panels are independent, and
    // serialising them would make the slowest report the whole dashboard's time
    // to first number.
    await Promise.all([
      loadAvailabilityIndex(),
      loadAvailabilityRecords(),
      loadTaskWorkRate(),
      loadResolvedGapRate(),
      loadDetectionToResolution(),
      loadAdoption(),
      loadStoreAdoption(),
      loadDepartmentalOutcomes(),
      loadTaskQueues(),
      loadTaskQueueItems(),
    ]);
  };

  const cancelAll = (): void => {
    for (const controller of inFlight.values()) controller.abort();
    inFlight.clear();
  };

  return {
    loadAvailabilityIndex,
    loadAvailabilityRecords,
    loadTaskWorkRate,
    loadResolvedGapRate,
    loadDetectionToResolution,
    loadAdoption,
    loadStoreAdoption,
    loadDepartmentalOutcomes,
    loadTaskQueues,
    loadTaskQueueItems,
    loadAll,
    cancelAll,
  };
};
