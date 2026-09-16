import { describe, expect, it, vi } from 'vitest';
import {
  fetchFailed,
  fetchStarted,
  fetchSucceeded,
  granularityChanged,
  queueFilterChanged,
  queueSelected,
  windowChanged,
} from '../src/state/actions';
import { dashboardReducer } from '../src/state/reducer';
import { initialState } from '../src/state/dashboard-state';
import type { SliceName } from '../src/state/dashboard-state';
import { createStore } from '../src/state/store';
import { createEffects } from '../src/state/effects';
import {
  selectAvailabilityStatus,
  selectDepartmentsByIndex,
  selectErrors,
  selectIsAnyPending,
  selectQueuesByUrgency,
} from '../src/state/selectors';
import { isPending, pendingRequestId, valueOf } from '../src/models/async-data';
import { retailerId, queueId } from '../src/models/ids';
import { instant, millis, plus, timeWindow } from '../src/models/time';
import { cancelledError, httpError, networkError } from '../src/services/errors';
import { createSampleApi } from '../src/fixtures/sample-api';
import {
  SAMPLE_NOW,
  sampleAvailabilityIndexReport,
  sampleDataset,
} from '../src/fixtures/sample-data';

const RETAILER = retailerId('rt-northfield');
const base = () => initialState(RETAILER, SAMPLE_NOW);

const startAndGetId = (state = base(), slice: SliceName = 'availabilityIndex') => {
  const started = dashboardReducer(state, fetchStarted(slice, SAMPLE_NOW));
  const id = pendingRequestId(started[slice]);
  expect(id).not.toBeNull();
  return { started, id: id! };
};

describe('dashboardReducer — request lifecycle', () => {
  it('mints a request id on start and hands the next one out afterwards', () => {
    const first = startAndGetId();
    const second = startAndGetId(first.started, 'taskWorkRate');
    expect(second.id).not.toBe(first.id);
    expect(second.started.nextRequestId).toBe(base().nextRequestId + 2);
  });

  it('applies a result that belongs to the request it is waiting on', () => {
    const { started, id } = startAndGetId();
    const report = sampleAvailabilityIndexReport();

    const settled = dashboardReducer(
      started,
      fetchSucceeded('availabilityIndex', id, SAMPLE_NOW, report),
    );

    expect(settled.availabilityIndex.status).toBe('success');
    expect(valueOf(settled.availabilityIndex)).toBe(report);
  });

  it('drops a superseded response instead of walking the dashboard backwards', () => {
    const first = startAndGetId();
    const second = startAndGetId(first.started);
    const stale = sampleAvailabilityIndexReport();

    // The slow first request lands after the fast second one was issued.
    const settled = dashboardReducer(
      second.started,
      fetchSucceeded('availabilityIndex', first.id, SAMPLE_NOW, stale),
    );

    expect(settled).toBe(second.started);
    expect(settled.availabilityIndex.status).toBe('loading');
  });

  it('drops a superseded failure too, so an old error cannot mask a live request', () => {
    const first = startAndGetId();
    const second = startAndGetId(first.started);

    const settled = dashboardReducer(
      second.started,
      fetchFailed('availabilityIndex', first.id, SAMPLE_NOW, networkError('late')),
    );

    expect(settled).toBe(second.started);
  });

  it('keeps the loaded value on screen through a refresh and a failed refresh', () => {
    const { started, id } = startAndGetId();
    const report = sampleAvailabilityIndexReport();
    const loaded = dashboardReducer(
      started,
      fetchSucceeded('availabilityIndex', id, SAMPLE_NOW, report),
    );

    const refreshing = startAndGetId(loaded);
    expect(refreshing.started.availabilityIndex.status).toBe('refreshing');
    expect(valueOf(refreshing.started.availabilityIndex)).toBe(report);

    const broken = dashboardReducer(
      refreshing.started,
      fetchFailed('availabilityIndex', refreshing.id, SAMPLE_NOW, httpError(503, 'x', null, null)),
    );
    expect(broken.availabilityIndex.status).toBe('error');
    expect(valueOf(broken.availabilityIndex)).toBe(report);
  });
});

describe('dashboardReducer — scope', () => {
  it('clears every scoped report so no panel shows a figure for the old window', () => {
    const { started, id } = startAndGetId();
    const loaded = dashboardReducer(
      started,
      fetchSucceeded('availabilityIndex', id, SAMPLE_NOW, sampleAvailabilityIndexReport()),
    );

    const rescoped = dashboardReducer(loaded, granularityChanged('day'));

    expect(rescoped.scope.granularity).toBe('day');
    expect(rescoped.availabilityIndex.status).toBe('idle');
    expect(rescoped.departmentalOutcomes.status).toBe('idle');
  });

  it('leaves the live task queues alone — they are not a report over the window', () => {
    const queues = sampleDataset().taskQueues;
    const { started, id } = startAndGetId(base(), 'taskQueues');
    const loaded = dashboardReducer(started, fetchSucceeded('taskQueues', id, SAMPLE_NOW, queues));

    const rescoped = dashboardReducer(
      loaded,
      windowChanged(timeWindow(SAMPLE_NOW, plus(SAMPLE_NOW, millis(3_600_000)))),
    );

    expect(valueOf(rescoped.taskQueues)).toBe(queues);
  });
});

describe('dashboardReducer — queue controls', () => {
  it('drops the loaded items when the selected queue changes', () => {
    const items = sampleDataset().taskQueueItems;
    const { started, id } = startAndGetId(base(), 'taskQueueItems');
    const loaded = dashboardReducer(
      started,
      fetchSucceeded('taskQueueItems', id, SAMPLE_NOW, items),
    );

    const switched = dashboardReducer(loaded, queueSelected(queueId('q-0287-mixed')));

    expect(switched.selectedQueueId).toBe('q-0287-mixed');
    expect(switched.taskQueueItems.status).toBe('idle');
  });

  it('returns the same state for a no-op selection, so nothing re-renders', () => {
    const state = base();
    expect(dashboardReducer(state, queueSelected(null))).toBe(state);
  });

  it('drops the items when the filter changes, since they no longer match it', () => {
    const state = dashboardReducer(
      base(),
      queueFilterChanged({ ...base().queueFilter, unassignedOnly: true }),
    );
    expect(state.queueFilter.unassignedOnly).toBe(true);
    expect(state.taskQueueItems.status).toBe('idle');
  });
});

describe('store', () => {
  it('does not notify when the reducer returns the state it was given', () => {
    const store = createStore(dashboardReducer, base());
    const listener = vi.fn();
    store.subscribe(listener);

    store.dispatch(queueSelected(null));
    expect(listener).not.toHaveBeenCalled();

    store.dispatch(fetchStarted('adoption', SAMPLE_NOW));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('survives a listener unsubscribing during the notification pass', () => {
    const store = createStore(dashboardReducer, base());
    const second = vi.fn();
    const unsubscribeFirst = store.subscribe(() => unsubscribeFirst());
    store.subscribe(second);

    store.dispatch(fetchStarted('adoption', SAMPLE_NOW));

    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('effects', () => {
  const setUp = (api = createSampleApi()) => {
    const store = createStore(dashboardReducer, base());
    const effects = createEffects({ store, api, clock: () => SAMPLE_NOW });
    return { store, effects };
  };

  it('moves a slice through loading and into success', async () => {
    const { store, effects } = setUp();

    const pending = effects.loadAvailabilityIndex();
    expect(isPending(store.getState().availabilityIndex)).toBe(true);

    await pending;
    expect(store.getState().availabilityIndex.status).toBe('success');
    expect(valueOf(store.getState().availabilityIndex)).toEqual(sampleAvailabilityIndexReport());
  });

  it('records a failure as an error the panel can present', async () => {
    const { store, effects } = setUp(
      createSampleApi({ failWith: httpError(503, 'Service Unavailable', 'catching up', null) }),
    );

    await effects.loadResolvedGapRate();

    expect(store.getState().resolvedGapRate.status).toBe('error');
    expect(selectErrors(store.getState()).map((entry) => entry.slice)).toEqual(['resolvedGapRate']);
  });

  it('never turns its own cancellation into an error panel', async () => {
    const { store, effects } = setUp(createSampleApi({ failWith: cancelledError() }));

    await effects.loadAdoption();

    expect(selectErrors(store.getState())).toHaveLength(0);
    // The slice is left pending — a newer request is the one that will settle it.
    expect(isPending(store.getState().adoption)).toBe(true);
  });

  it('aborts the in-flight request when the same slice is asked for again', async () => {
    const { store, effects } = setUp(createSampleApi({ latency: 5 }));

    const first = effects.loadTaskWorkRate();
    const firstId = pendingRequestId(store.getState().taskWorkRate);
    const second = effects.loadTaskWorkRate();
    const secondId = pendingRequestId(store.getState().taskWorkRate);

    expect(secondId).not.toBe(firstId);
    await Promise.all([first, second]);
    expect(store.getState().taskWorkRate.status).toBe('success');
  });

  it('does not fetch queue items before a queue is selected', async () => {
    const { store, effects } = setUp();
    await effects.loadTaskQueueItems();
    expect(store.getState().taskQueueItems.status).toBe('idle');
  });

  it('loads every report the dashboard shows in one pass', async () => {
    const { store, effects } = setUp();
    store.dispatch(queueSelected(queueId('q-0142-restock')));

    await effects.loadAll();

    const state = store.getState();
    expect(selectIsAnyPending(state)).toBe(false);
    expect(selectErrors(state)).toHaveLength(0);
    expect(valueOf(state.taskQueueItems)).toEqual(sampleDataset().taskQueueItems);
  });
});

describe('selectors', () => {
  const loaded = async () => {
    const store = createStore(dashboardReducer, base());
    const effects = createEffects({
      store,
      api: createSampleApi(),
      clock: () => SAMPLE_NOW,
    });
    await effects.loadAll();
    return store.getState();
  };

  it('downgrades the availability status when coverage is too thin to trust', async () => {
    const state = await loaded();
    // The sample index is 0.9683 (a "watch") over 78% coverage (good), so the
    // worse of the two is what the card reports.
    expect(selectAvailabilityStatus(state)).toBe('warning');
  });

  it('reports unknown when nothing has loaded, rather than defaulting to good', () => {
    expect(selectAvailabilityStatus(base())).toBe('unknown');
  });

  it('orders queues and departments worst-first', async () => {
    const state = await loaded();
    expect(selectQueuesByUrgency(state)[0]?.queueId).toBe('q-0142-restock');
    expect(selectDepartmentsByIndex(state)[0]?.departmentName).toBe('Produce');
  });
});

describe('clock', () => {
  it('advances only when the instant actually changes', () => {
    const state = base();
    const same = dashboardReducer(state, { kind: 'clock/ticked', now: SAMPLE_NOW });
    expect(same).toBe(state);

    const later = instant(SAMPLE_NOW + 60_000);
    expect(dashboardReducer(state, { kind: 'clock/ticked', now: later }).now).toBe(later);
  });
});
