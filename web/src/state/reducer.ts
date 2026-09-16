import type { AsyncData, RequestId } from '../models/async-data';
import { beginLoad, failed, idle, isCurrentRequest, succeed } from '../models/async-data';
import { assertNever } from '../models/exhaustive';
import { timeWindow } from '../models/time';
import type { DashboardAction } from './actions';
import type { AsyncSlices, DashboardState, SliceName } from './dashboard-state';
import { SCOPED_SLICES } from './dashboard-state';

/**
 * The whole dashboard's state transition, as one pure function.
 *
 * Every rule that is easy to get wrong in a polling dashboard lives here rather
 * than in an effect or a component: which slices a scope change invalidates,
 * whether a settled response is still the one being waited on, and whether a
 * value survives the request that was meant to replace it.
 */
export const dashboardReducer = (
  state: DashboardState,
  action: DashboardAction,
): DashboardState => {
  switch (action.kind) {
    case 'scope/replaced':
      return withScope(state, action.scope);
    case 'scope/window_changed':
      return withScope(state, {
        ...state.scope,
        window: timeWindow(action.window.from, action.window.to),
      });
    case 'scope/granularity_changed':
      return withScope(state, { ...state.scope, granularity: action.granularity });
    case 'scope/stores_changed':
      return withScope(state, { ...state.scope, storeIds: action.storeIds });
    case 'scope/products_changed':
      return withScope(state, { ...state.scope, productIds: action.productIds });
    case 'scope/breakdown_changed':
      return withScope(state, { ...state.scope, breakdownBy: action.breakdownBy });

    case 'clock/ticked':
      return action.now === state.now ? state : { ...state, now: action.now };

    case 'queue/selected':
      return action.queueId === state.selectedQueueId
        ? state
        : // The items belong to the queue that was selected, not the one now
          // selected, so they are dropped rather than left showing another
          // queue's rows under a new heading until the fetch lands.
          { ...state, selectedQueueId: action.queueId, taskQueueItems: idle() };

    case 'queue/filter_changed':
      return { ...state, queueFilter: action.filter, taskQueueItems: idle() };

    case 'queue/sort_changed':
      return action.sort === state.queueSort ? state : { ...state, queueSort: action.sort };

    case 'records/sort_changed':
      return action.sort === state.recordSort ? state : { ...state, recordSort: action.sort };

    case 'fetch/started': {
      const requestId = state.nextRequestId as RequestId;
      const started = updateSlice(state, action.slice, (current) =>
        beginLoad(current, requestId, action.at),
      );
      return { ...started, nextRequestId: state.nextRequestId + 1 };
    }

    case 'fetch/succeeded':
      return settleSlice(state, action.slice, action.requestId, () =>
        succeed(action.value, action.at),
      );

    case 'fetch/failed':
      return settleSlice(state, action.slice, action.requestId, (current) =>
        failed(current, action.error, action.at),
      );

    default:
      return assertNever(action, 'dashboardReducer');
  }
};

/**
 * A new scope resets the reports it invalidates back to `idle`.
 *
 * Resetting rather than leaving the old value in place is the point: a figure
 * for last week's window sitting under a header that now says "today" is worse
 * than an empty panel, because it reads as an answer.
 */
const withScope = (state: DashboardState, scope: DashboardState['scope']): DashboardState => {
  const cleared = SCOPED_SLICES.reduce<Partial<AsyncSlices>>(
    (slices, name) => ({ ...slices, [name]: idle() }),
    {},
  );
  return { ...state, ...cleared, scope };
};

/**
 * Apply a transition to one slice, whichever slice it is.
 *
 * The transition is written against `AsyncData<unknown>` and the result is cast
 * back: TypeScript cannot correlate `slice` with `state[slice]` when `slice` is
 * the whole `SliceName` union, and writing the switch out ten times to avoid one
 * cast would bury the three transitions that actually matter.
 *
 * What keeps this sound is upstream of here: `FetchSucceeded` is a mapped union,
 * so an action can only ever carry the value type its own slice holds. The cast
 * re-states a pairing the action already proved.
 */
const updateSlice = (
  state: DashboardState,
  slice: SliceName,
  next: (current: AsyncData<unknown>) => AsyncData<unknown>,
): DashboardState => ({ ...state, [slice]: next(state[slice]) }) as DashboardState;

/**
 * Apply a settled result only if the slice is still waiting on that request.
 *
 * Without this check the dashboard walks backwards: a slow request for a
 * seven-day window, superseded by a fast one for today, would land second and
 * overwrite today's numbers with last week's. The slice keeps the id of the
 * request it is waiting on, and anything else is dropped on the floor.
 */
const settleSlice = (
  state: DashboardState,
  slice: SliceName,
  requestId: RequestId,
  next: (current: AsyncData<unknown>) => AsyncData<unknown>,
): DashboardState =>
  isCurrentRequest(state[slice], requestId) ? updateSlice(state, slice, next) : state;
