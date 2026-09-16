import { describe, expect, it } from 'vitest';
import { createAvailabilityClient } from '../src/services/availability.client';
import { createTaskPerformanceClient } from '../src/services/task-performance.client';
import { buildQuery, parseRetryAfter } from '../src/services/http-client';
import { describeServiceError, isRetryable } from '../src/services/errors';
import { scopeQuery } from '../src/services/endpoints';
import { retailerId, storeId } from '../src/models/ids';
import { instant, millis, timeWindow } from '../src/models/time';
import type { ReportScope } from '../src/models/scope';
import {
  errorResponse,
  jsonResponse,
  stubFetch,
  testClient,
  wireAvailabilityIndexReport,
} from './support/wire';

const RETAILER = retailerId('rt-northfield');
const WINDOW = timeWindow(instant(Date.UTC(2026, 8, 15)), instant(Date.UTC(2026, 8, 16)));
const COMPUTED_AT = instant(Date.UTC(2026, 8, 16, 0, 5));

const scope: ReportScope = {
  retailerId: RETAILER,
  storeIds: [storeId('st-0142'), storeId('st-0287')],
  productIds: null,
  window: WINDOW,
  granularity: 'hour',
  breakdownBy: ['department'],
};

describe('availability client', () => {
  it('decodes a report from the published wire encoding', async () => {
    const stub = stubFetch([jsonResponse(wireAvailabilityIndexReport(RETAILER, WINDOW, COMPUTED_AT))]);
    const client = createAvailabilityClient(testClient(stub.fetch));

    const result = await client.availabilityIndex(scope);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.retailerId).toBe(RETAILER);
    // ISO-8601 on the wire becomes epoch millis in the model.
    expect(result.value.computedAt).toBe(COMPUTED_AT);
    expect(result.value.window.from).toBe(WINDOW.from);
    expect(result.value.overall.index).toBeCloseTo(0.9683);
    expect(result.value.breakdowns[0]?.label).toBe('Produce');
  });

  it('keeps an unmeasured bucket null rather than collapsing it to zero', async () => {
    const stub = stubFetch([jsonResponse(wireAvailabilityIndexReport(RETAILER, WINDOW, COMPUTED_AT))]);
    const client = createAvailabilityClient(testClient(stub.fetch));

    const result = await client.availabilityIndex(scope);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.series[1]?.index).toBeNull();
  });

  it('addresses the retailer in the path and never as a droppable query parameter', async () => {
    const stub = stubFetch([jsonResponse(wireAvailabilityIndexReport(RETAILER, WINDOW, COMPUTED_AT))]);
    await createAvailabilityClient(testClient(stub.fetch)).availabilityIndex(scope);

    const url = stub.requests[0]?.url ?? '';
    expect(url).toContain('/retailers/rt-northfield/reports/availability-index');
    expect(url).not.toContain('retailerId=');
    expect(url).toContain('storeId=st-0142&storeId=st-0287');
    expect(url).toContain('granularity=hour');
  });

  it('sends the schema version it was written against, and the bearer token', async () => {
    const stub = stubFetch([jsonResponse(wireAvailabilityIndexReport(RETAILER, WINDOW, COMPUTED_AT))]);
    await createAvailabilityClient(testClient(stub.fetch)).availabilityIndex(scope);

    const headers = stub.requests[0]?.init.headers as Record<string, string>;
    expect(headers['x-osa-schema-version']).toBe('1.0');
    expect(headers['authorization']).toBe('Bearer token-abc');
  });

  it('reports a schema mismatch as a decode failure naming the field', async () => {
    const broken = wireAvailabilityIndexReport(RETAILER, WINDOW, COMPUTED_AT);
    const stub = stubFetch([jsonResponse({ ...broken, overall: { ...(broken['overall'] as object), coverage: 'high' } })]);

    const result = await createAvailabilityClient(testClient(stub.fetch)).availabilityIndex(scope);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('decode');
    if (result.error.kind !== 'decode') return;
    expect(result.error.path).toBe('overall.coverage');
    expect(result.error.received).toBe('string');
    // A body that cannot be parsed will not parse on a second try either.
    expect(isRetryable(result.error)).toBe(false);
  });

  it('rejects an unknown member of a closed union rather than dropping it', async () => {
    const broken = wireAvailabilityIndexReport(RETAILER, WINDOW, COMPUTED_AT);
    const stub = stubFetch([jsonResponse({ ...broken, granularity: 'fortnight' })]);

    const result = await createAvailabilityClient(testClient(stub.fetch)).availabilityIndex(scope);

    expect(result.ok).toBe(false);
    if (result.ok || result.error.kind !== 'decode') return;
    expect(result.error.path).toBe('granularity');
  });
});

describe('task performance client', () => {
  it('reaches the three reports at their own endpoints', async () => {
    const stub = stubFetch([errorResponse(500)]);
    const client = createTaskPerformanceClient(testClient(stub.fetch, { maxAttempts: 1 }));

    await client.taskWorkRate(scope);
    await client.resolvedGapRate(scope);
    await client.detectionToResolution(scope);

    expect(stub.requests.map((request) => new URL(request.url).pathname)).toEqual([
      '/api/retailers/rt-northfield/reports/task-work-rate',
      '/api/retailers/rt-northfield/reports/resolved-gap-rate',
      '/api/retailers/rt-northfield/reports/detection-to-resolution',
    ]);
  });
});

describe('http client', () => {
  it('retries a 503 and returns the answer the retry produced', async () => {
    const stub = stubFetch([
      errorResponse(503),
      jsonResponse(wireAvailabilityIndexReport(RETAILER, WINDOW, COMPUTED_AT)),
    ]);

    const result = await createAvailabilityClient(testClient(stub.fetch)).availabilityIndex(scope);

    expect(stub.requests).toHaveLength(2);
    expect(result.ok).toBe(true);
  });

  it('gives up after the configured attempts and reports the last failure', async () => {
    const stub = stubFetch([errorResponse(500), errorResponse(500), errorResponse(500)]);

    const result = await createAvailabilityClient(testClient(stub.fetch)).availabilityIndex(scope);

    expect(stub.requests).toHaveLength(3);
    expect(result.ok).toBe(false);
    if (result.ok || result.error.kind !== 'http') return;
    expect(result.error.status).toBe(500);
    expect(result.error.detail).toBe('nope');
  });

  it('does not retry a 403 — the same request would be refused again', async () => {
    const stub = stubFetch([errorResponse(403)]);

    const result = await createAvailabilityClient(testClient(stub.fetch)).availabilityIndex(scope);

    expect(stub.requests).toHaveLength(1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(describeServiceError(result.error).retryable).toBe(false);
  });

  it('reports a caller cancellation as cancelled, not as a failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const stub = stubFetch([jsonResponse({})]);

    const result = await createAvailabilityClient(testClient(stub.fetch)).availabilityIndex(
      scope,
      controller.signal,
    );

    expect(stub.requests).toHaveLength(0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('cancelled');
  });

  it('carries the service detail into the presented error', () => {
    const presentation = describeServiceError({
      kind: 'http',
      status: 503,
      statusText: 'Service Unavailable',
      detail: 'Read replica catching up',
      retryAfter: millis(2000),
    });
    expect(presentation.retryable).toBe(true);
    expect(presentation.detail).toContain('Read replica catching up');
  });
});

describe('query building', () => {
  it('drops nulls and repeats the key for each member of a list', () => {
    expect(buildQuery({ a: 'x', b: null, c: ['1', '2'], d: 7, e: true })).toBe(
      '?a=x&c=1&c=2&d=7&e=true',
    );
  });

  it('returns an empty string rather than a bare question mark', () => {
    expect(buildQuery({ a: null })).toBe('');
  });

  it('omits the breakdown parameter entirely when nothing is broken down', () => {
    const query = scopeQuery({ ...scope, breakdownBy: [] });
    expect(query['breakdownBy']).toBeNull();
  });

  it('reads Retry-After in both of its legal forms', () => {
    const now = Date.UTC(2026, 8, 15, 12, 0, 0);
    expect(parseRetryAfter('30', now)).toBe(30_000);
    expect(parseRetryAfter(new Date(now + 5_000).toUTCString(), now)).toBe(5_000);
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter('later', now)).toBeNull();
  });
});
