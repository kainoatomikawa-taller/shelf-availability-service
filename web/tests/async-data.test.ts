import { describe, expect, it } from 'vitest';
import {
  beginLoad,
  failed,
  heldValue,
  idle,
  isCurrentRequest,
  isPending,
  isStale,
  mapAsync,
  requestId,
  succeed,
  valueOf,
} from '../src/models/async-data';
import type { AsyncData } from '../src/models/async-data';
import { networkError } from '../src/services/errors';
import { instant } from '../src/models/time';

const t0 = instant(1_000);
const t1 = instant(2_000);
const t2 = instant(3_000);

describe('AsyncData', () => {
  it('goes from idle to loading with nothing to show', () => {
    const loading = beginLoad(idle<number>(), requestId(1), t0);
    expect(loading.status).toBe('loading');
    expect(valueOf(loading)).toBeNull();
    expect(isPending(loading)).toBe(true);
  });

  it('keeps the previous value while refreshing, so a poll never blanks a panel', () => {
    const loaded = succeed(41, t0);
    const refreshing = beginLoad(loaded, requestId(2), t1);

    expect(refreshing.status).toBe('refreshing');
    expect(valueOf(refreshing)).toBe(41);
    expect(isStale(refreshing)).toBe(true);
  });

  it('keeps the last good value when a refresh fails, marked stale', () => {
    const loaded = succeed(41, t0);
    const refreshing = beginLoad(loaded, requestId(2), t1);
    const broken = failed(refreshing, networkError('socket closed'), t2);

    expect(broken.status).toBe('error');
    expect(valueOf(broken)).toBe(41);
    expect(heldValue(broken)?.loadedAt).toBe(t0);
    expect(isStale(broken)).toBe(true);
  });

  it('has no value to keep when the first load fails', () => {
    const broken = failed(beginLoad(idle<number>(), requestId(1), t0), networkError('dns'), t1);
    expect(valueOf(broken)).toBeNull();
    expect(isStale(broken)).toBe(false);
  });

  it('only recognises the request it is actually waiting on', () => {
    const loading = beginLoad(idle<number>(), requestId(7), t0);
    expect(isCurrentRequest(loading, requestId(7))).toBe(true);
    expect(isCurrentRequest(loading, requestId(6))).toBe(false);
    expect(isCurrentRequest(succeed(1, t0), requestId(7))).toBe(false);
  });

  it('projects the carried value in every state that has one', () => {
    const double = (value: number): number => value * 2;
    expect(valueOf(mapAsync(succeed(4, t0), double))).toBe(8);

    const staleError: AsyncData<number> = failed(succeed(4, t0), networkError('x'), t1);
    expect(valueOf(mapAsync(staleError, double))).toBe(8);
    expect(valueOf(mapAsync(idle<number>(), double))).toBeNull();
  });
});
