/**
 * The smallest store that does the job: a pure reducer, a current value and a
 * subscription list.
 *
 * Hand-rolled rather than pulled from a library because the dashboard needs
 * exactly three things from a store — dispatch, read, subscribe — and the
 * reducer itself is where all the interesting decisions live. Keeping the
 * container this thin means the reducer stays a pure function that can be tested
 * without React, a renderer, or a mocked library.
 */
export interface Store<S, A> {
  getState(): S;
  dispatch(action: A): void;
  /** Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

export type Reducer<S, A> = (state: S, action: A) => S;

export const createStore = <S, A>(reducer: Reducer<S, A>, initial: S): Store<S, A> => {
  let state = initial;
  let listeners: readonly (() => void)[] = [];

  return {
    getState: () => state,

    dispatch: (action) => {
      const next = reducer(state, action);
      // Reference equality is the signal: the reducer returns the state it was
      // given when an action does not apply (a superseded response, a no-op
      // filter change), and re-notifying for those would re-render every panel
      // on the dashboard for nothing.
      if (next === state) return;
      state = next;
      // Snapshot before notifying: a listener that unsubscribes during the pass
      // must not shift the list out from under the iteration.
      for (const listener of listeners) listener();
    },

    subscribe: (listener) => {
      listeners = [...listeners, listener];
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        listeners = listeners.filter((candidate) => candidate !== listener);
      };
    },
  };
};
