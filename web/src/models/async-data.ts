import type { ServiceError } from '../services/errors';
import { assertNever } from './exhaustive';
import type { Instant } from './time';

/**
 * The state of one thing the dashboard fetches.
 *
 * `refreshing` and `error`-with-`lastValue` exist because this dashboard polls.
 * A store manager watching the availability index does not want the number to
 * blank out every thirty seconds, and does not want a transient 502 to erase the
 * figure they were reading — so a reload keeps the value it is replacing, and a
 * failure keeps the value it could not replace, labelled stale either way.
 *
 * `requestId` is carried on the in-flight states so a late response from a
 * superseded request can be dropped rather than overwriting a newer one.
 */
export type AsyncData<T> =
  | { readonly status: 'idle' }
  | { readonly status: 'loading'; readonly requestId: RequestId; readonly since: Instant }
  | {
      readonly status: 'refreshing';
      readonly requestId: RequestId;
      readonly since: Instant;
      readonly value: T;
      readonly loadedAt: Instant;
    }
  | { readonly status: 'success'; readonly value: T; readonly loadedAt: Instant }
  | {
      readonly status: 'error';
      readonly error: ServiceError;
      readonly failedAt: Instant;
      /** The last good value, kept on screen and marked stale. `null` if there never was one. */
      readonly stale: { readonly value: T; readonly loadedAt: Instant } | null;
    };

/** Monotonic per-slice request counter. Only equality is ever asked of it. */
export type RequestId = number & { readonly __requestId: unique symbol };

export const requestId = (value: number): RequestId => value as RequestId;

export const idle = <T>(): AsyncData<T> => ({ status: 'idle' });

/**
 * Begin a load. Transitions to `refreshing` when there is already a value to
 * keep, `loading` when the slice has nothing to show.
 */
export const beginLoad = <T>(
  current: AsyncData<T>,
  id: RequestId,
  at: Instant,
): AsyncData<T> => {
  const held = heldValue(current);
  return held === null
    ? { status: 'loading', requestId: id, since: at }
    : { status: 'refreshing', requestId: id, since: at, value: held.value, loadedAt: held.loadedAt };
};

export const succeed = <T>(value: T, at: Instant): AsyncData<T> => ({
  status: 'success',
  value,
  loadedAt: at,
});

export const failed = <T>(
  current: AsyncData<T>,
  error: ServiceError,
  at: Instant,
): AsyncData<T> => ({ status: 'error', error, failedAt: at, stale: heldValue(current) });

/** The value and its age, whatever state is holding it. `null` when there is none. */
export const heldValue = <T>(
  data: AsyncData<T>,
): { readonly value: T; readonly loadedAt: Instant } | null => {
  switch (data.status) {
    case 'idle':
    case 'loading':
      return null;
    case 'refreshing':
    case 'success':
      return { value: data.value, loadedAt: data.loadedAt };
    case 'error':
      return data.stale;
    default:
      return assertNever(data, 'heldValue');
  }
};

/** The value if there is one. The accessor components use. */
export const valueOf = <T>(data: AsyncData<T>): T | null => heldValue(data)?.value ?? null;

/** True while a request is in flight, whether or not a value is on screen. */
export const isPending = (data: AsyncData<unknown>): boolean =>
  data.status === 'loading' || data.status === 'refreshing';

/** True when a value is showing but is not the result of the latest attempt. */
export const isStale = (data: AsyncData<unknown>): boolean =>
  data.status === 'refreshing' || (data.status === 'error' && data.stale !== null);

export const errorOf = (data: AsyncData<unknown>): ServiceError | null =>
  data.status === 'error' ? data.error : null;

/** The in-flight request's id, for the reducer's staleness check. */
export const pendingRequestId = (data: AsyncData<unknown>): RequestId | null =>
  data.status === 'loading' || data.status === 'refreshing' ? data.requestId : null;

/**
 * Whether a settled result should be applied.
 *
 * A response only wins if it belongs to the request the slice is still waiting
 * on — otherwise it is a slower answer to an older question, and applying it
 * would move the dashboard backwards.
 */
export const isCurrentRequest = (data: AsyncData<unknown>, id: RequestId): boolean =>
  pendingRequestId(data) === id;

/** Project the carried value without disturbing the state around it. */
export const mapAsync = <T, U>(data: AsyncData<T>, project: (value: T) => U): AsyncData<U> => {
  switch (data.status) {
    case 'idle':
    case 'loading':
      return data;
    case 'refreshing':
      return { ...data, value: project(data.value) };
    case 'success':
      return { ...data, value: project(data.value) };
    case 'error':
      return {
        ...data,
        stale:
          data.stale === null
            ? null
            : { value: project(data.stale.value), loadedAt: data.stale.loadedAt },
      };
    default:
      return assertNever(data, 'mapAsync');
  }
};
