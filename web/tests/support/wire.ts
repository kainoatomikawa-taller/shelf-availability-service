import { millis, toISO } from '../../src/models/time';
import type { Instant, TimeWindow } from '../../src/models/time';
import { ReportingHttpClient } from '../../src/services/http-client';
import type { FetchLike, HttpClientConfig } from '../../src/services/http-client';

/**
 * Wire-shaped fixtures and transport doubles.
 *
 * The payload builders here produce the raw JSON the reporting endpoints
 * publish — ISO-8601 UTC timestamps, integer millisecond durations, decimal
 * ratios — rather than decoded models. That is the point: a decoder tested
 * against its own output proves nothing, so these are written against the
 * encoding the service actually promises.
 */
export const wireWindow = (window: TimeWindow): Record<string, string> => ({
  from: toISO(window.from),
  to: toISO(window.to),
});

export const wireAvailabilityPoint = (
  window: TimeWindow,
  index: number | null,
  coverage: number,
): Record<string, unknown> => ({
  window: wireWindow(window),
  index,
  coverage,
  inStockFacingMillis: 3_600_000,
  measuredFacingMillis: 7_200_000,
  unknownFacingMillis: 600_000,
  facingCount: 12,
});

export const wireAvailabilityIndexReport = (
  retailerId: string,
  window: TimeWindow,
  computedAt: Instant,
): Record<string, unknown> => ({
  retailerId,
  window: wireWindow(window),
  granularity: 'hour',
  overall: wireAvailabilityPoint(window, 0.9683, 0.78),
  series: [wireAvailabilityPoint(window, 0.97, 0.8), wireAvailabilityPoint(window, null, 0.04)],
  breakdowns: [
    {
      dimension: 'department',
      key: 'dp-produce',
      label: 'Produce',
      value: wireAvailabilityPoint(window, 0.94, 0.84),
    },
  ],
  computedAt: toISO(computedAt),
});

export interface RecordedRequest {
  readonly url: string;
  readonly init: RequestInit;
}

export interface StubFetch {
  readonly fetch: FetchLike;
  readonly requests: RecordedRequest[];
}

/**
 * A `fetch` that replays queued responses and records what it was asked.
 *
 * Once the queue is exhausted it repeats the last response, so a retry test does
 * not have to enumerate every attempt to assert the one that matters.
 */
export const stubFetch = (responses: readonly (() => Promise<Response>)[]): StubFetch => {
  const requests: RecordedRequest[] = [];
  let index = 0;
  return {
    requests,
    fetch: (url, init) => {
      requests.push({ url, init });
      const next = responses[Math.min(index, responses.length - 1)];
      index += 1;
      if (next === undefined) throw new Error('stubFetch was given no responses');
      return next();
    },
  };
};

export const jsonResponse =
  (body: unknown, status = 200): (() => Promise<Response>) =>
  () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );

export const errorResponse =
  (
    status: number,
    body: unknown = { detail: 'nope' },
    headers: Record<string, string> = {},
  ): (() => Promise<Response>) =>
  () =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers }));

/** A client with no real timers: retry backoff resolves immediately. */
export const testClient = (
  fetchLike: FetchLike,
  overrides: Partial<HttpClientConfig> = {},
): ReportingHttpClient =>
  new ReportingHttpClient({
    baseUrl: 'https://osa.test/api',
    timeout: millis(50),
    maxAttempts: 3,
    retryBaseDelay: millis(1),
    maxRetryDelay: millis(2),
    authToken: () => 'token-abc',
    schemaVersion: '1.0',
    fetch: fetchLike,
    sleep: () => Promise.resolve(),
    ...overrides,
  });
