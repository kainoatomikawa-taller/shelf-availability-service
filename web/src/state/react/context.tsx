import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import type { ReactNode } from 'react';
import type { AsyncData } from '../../models/async-data';
import type { RetailerId } from '../../models/ids';
import type { Instant } from '../../models/time';
import { instant } from '../../models/time';
import type { DashboardApi } from '../../services/reporting.client';
import type { DashboardAction } from '../actions';
import { clockTicked } from '../actions';
import type { DashboardState, SliceName } from '../dashboard-state';
import { initialState } from '../dashboard-state';
import type { DashboardEffects, DashboardStore } from '../effects';
import { createEffects } from '../effects';
import { dashboardReducer } from '../reducer';
import { createStore } from '../store';

interface DashboardContextValue {
  readonly store: DashboardStore;
  readonly effects: DashboardEffects;
}

const DashboardContext = createContext<DashboardContextValue | null>(null);

export interface DashboardProviderProps {
  readonly api: DashboardApi;
  readonly retailerId: RetailerId;
  /** Injected so a test or a screenshot renders at a fixed instant. */
  readonly clock?: () => Instant;
  /** How often the dashboard's own clock advances, for ages and freshness lines. */
  readonly tickInterval?: number;
  readonly children: ReactNode;
}

export const DashboardProvider = ({
  api,
  retailerId,
  clock = () => instant(Date.now()),
  tickInterval = 30_000,
  children,
}: DashboardProviderProps) => {
  // Built once per provider: recreating the store on re-render would reset every
  // panel to `idle` whenever a parent re-rendered.
  const contextRef = useRef<DashboardContextValue | null>(null);
  if (contextRef.current === null) {
    const store = createStore<DashboardState, DashboardAction>(
      dashboardReducer,
      initialState(retailerId, clock()),
    );
    contextRef.current = { store, effects: createEffects({ store, api, clock }) };
  }
  const context = contextRef.current;

  useEffect(() => {
    if (tickInterval <= 0) return;
    const timer = setInterval(() => context.store.dispatch(clockTicked(clock())), tickInterval);
    return () => clearInterval(timer);
  }, [context, clock, tickInterval]);

  // Anything still in flight when the dashboard goes away is abandoned rather
  // than left to resolve into a store nobody is reading.
  useEffect(() => () => context.effects.cancelAll(), [context]);

  return <DashboardContext.Provider value={context}>{children}</DashboardContext.Provider>;
};

const useDashboardContext = (): DashboardContextValue => {
  const context = useContext(DashboardContext);
  if (context === null) {
    throw new Error('useDashboard* must be used inside a <DashboardProvider>');
  }
  return context;
};

export const useDashboardStore = (): DashboardStore => useDashboardContext().store;

export const useDashboardEffects = (): DashboardEffects => useDashboardContext().effects;

export const useDashboardDispatch = (): ((action: DashboardAction) => void) => {
  const store = useDashboardStore();
  return useMemo(() => store.dispatch.bind(store), [store]);
};

/**
 * Subscribe to a projection of the state.
 *
 * `useSyncExternalStore` rather than a context value holding the state: a
 * context that carried the state would re-render every consumer on every
 * dispatch, and a dashboard polling ten reports dispatches constantly. This way
 * a panel only re-renders when what it selected actually changed.
 *
 * The result is memoised on the identity of the state object, and that is not an
 * optimisation — it is what makes the hook safe to use at all. A selector that
 * derives anything (`selectQueuesByUrgency` sorts a copy; `selectErrors` builds
 * a list) returns a fresh reference on every call, and `useSyncExternalStore`
 * reads that as "changed" and re-renders, which calls it again, forever. The
 * store hands out a new state object only when the reducer actually changed
 * something, so caching against it gives every selector a stable snapshot
 * without each one having to memoise itself.
 *
 * The one case this does not cover is a selector whose behaviour changes between
 * renders without the state changing — an inline arrow closing over a prop, say.
 * Prefer a module-scope selector, as everything in `state/selectors.ts` is, or
 * put the varying input in the state where it belongs.
 */
export const useDashboardSelector = <T,>(selector: (state: DashboardState) => T): T => {
  const store = useDashboardStore();
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const cache = useRef<{ readonly state: DashboardState; readonly value: T } | null>(null);

  const getSnapshot = useCallback((): T => {
    const state = store.getState();
    const cached = cache.current;
    if (cached !== null && cached.state === state) return cached.value;
    const value = selectorRef.current(state);
    cache.current = { state, value };
    return value;
  }, [store]);

  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
};

export const useDashboardState = (): DashboardState => useDashboardSelector(identity);

const identity = (state: DashboardState): DashboardState => state;

/** One slice's async state — what a panel binds its loading and error branches to. */
export const useAsyncSlice = (slice: SliceName): AsyncData<unknown> => {
  const store = useDashboardStore();
  return useSyncExternalStore(
    store.subscribe,
    () => store.getState()[slice],
    () => store.getState()[slice],
  );
};
