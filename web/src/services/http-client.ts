import type { Result } from '../models/result';
import { err, ok } from '../models/result';
import type { Millis } from '../models/time';
import { millis } from '../models/time';
import type { Decoder } from './decode';
import type { ServiceError } from './errors';
import {
  DecodeFailure,
  cancelledError,
  httpError,
  isRetryable,
  networkError,
  timeoutError,
} from './errors';

export type ServiceResult<T> = Result<T, ServiceError>;

/** The subset of `fetch` this client uses. Injected so tests never touch a global. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Injected so retry backoff is instant under test instead of really sleeping. */
export type SleepLike = (delay: Millis, signal: AbortSignal | null) => Promise<void>;

export interface HttpClientConfig {
  /** Origin plus any path prefix, e.g. `https://osa.example.com/api`. No trailing slash. */
  readonly baseUrl: string;
  /** Per-attempt budget. Exceeding it aborts that attempt, not the whole call. */
  readonly timeout: Millis;
  /** Total attempts including the first. `1` disables retry. */
  readonly maxAttempts: number;
  /** First backoff delay; doubles each attempt, capped at `maxRetryDelay`. */
  readonly retryBaseDelay: Millis;
  readonly maxRetryDelay: Millis;
  /** Called per request, so a rotated token is picked up without rebuilding the client. */
  readonly authToken: () => string | null;
  /**
   * The reporting schema major.minor this build was written against, sent so the
   * service can answer in a version we can decode, or refuse before we render a
   * misread number.
   */
  readonly schemaVersion: string;
  readonly fetch: FetchLike;
  readonly sleep: SleepLike;
}

export interface RequestOptions<T> {
  readonly path: string;
  /** `null` and `undefined` entries are dropped; arrays repeat the key. */
  readonly query: QueryParams;
  readonly decode: Decoder<T>;
  /** Caller's cancellation — a scope change, or a component unmounting. */
  readonly signal: AbortSignal | null;
}

export type QueryValue = string | number | boolean | readonly string[] | null;
export type QueryParams = Readonly<Record<string, QueryValue>>;

const defaultSleep: SleepLike = (delay, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, delay);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

export const DEFAULT_HTTP_CONFIG: Omit<HttpClientConfig, 'baseUrl' | 'fetch'> = {
  timeout: millis(15_000),
  maxAttempts: 3,
  retryBaseDelay: millis(400),
  maxRetryDelay: millis(5_000),
  authToken: () => null,
  schemaVersion: '1.0',
  sleep: defaultSleep,
};

export const buildQuery = (params: QueryParams): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null) continue;
    if (Array.isArray(value)) {
      for (const member of value) search.append(key, member);
    } else {
      search.append(key, String(value));
    }
  }
  const encoded = search.toString();
  return encoded === '' ? '' : `?${encoded}`;
};

/**
 * `Retry-After`, in either of its two legal forms.
 *
 * Honouring it matters more than it looks: the reporting endpoints sit in front
 * of per-retailer partitions, and a dashboard that ignores a 429 and hammers
 * through its own backoff turns one slow report into a noisy neighbour for every
 * other reader of that partition.
 */
export const parseRetryAfter = (header: string | null, now: number): Millis | null => {
  if (header === null) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return millis(Math.round(seconds * 1000));
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : millis(Math.max(0, date - now));
};

/**
 * A typed GET against the reporting endpoints, with a bounded retry.
 *
 * Errors come back as values rather than exceptions so every caller has to deal
 * with the failure to get at the data — which is what keeps the loading/error
 * branches in the state layer from being forgotten.
 */
export class ReportingHttpClient {
  private readonly config: HttpClientConfig;

  constructor(config: HttpClientConfig) {
    this.config = config;
  }

  async get<T>(options: RequestOptions<T>): Promise<ServiceResult<T>> {
    const url = `${this.config.baseUrl}${options.path}${buildQuery(options.query)}`;
    let lastError: ServiceError = networkError('Request was never attempted');

    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt += 1) {
      if (options.signal?.aborted === true) return err(cancelledError());

      const outcome = await this.attempt(url, options);
      if (outcome.ok) return outcome;

      lastError = outcome.error;
      if (lastError.kind === 'cancelled') return outcome;
      if (!isRetryable(lastError) || attempt === this.config.maxAttempts) return outcome;

      await this.config.sleep(this.backoffFor(attempt, lastError), options.signal);
    }

    return err(lastError);
  }

  /** Exponential, unless the service named its own delay — then defer to that. */
  private backoffFor(attempt: number, error: ServiceError): Millis {
    if (error.kind === 'http' && error.retryAfter !== null) {
      return millis(Math.min(error.retryAfter, this.config.maxRetryDelay));
    }
    const exponential = this.config.retryBaseDelay * 2 ** (attempt - 1);
    return millis(Math.min(exponential, this.config.maxRetryDelay));
  }

  private async attempt<T>(url: string, options: RequestOptions<T>): Promise<ServiceResult<T>> {
    const controller = new AbortController();
    const onCallerAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onCallerAbort, { once: true });

    // Tracked separately from the abort itself: once the controller has fired we
    // can no longer tell a timeout from a caller cancellation, and the two get
    // very different treatment — one retries, the other must not.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.config.timeout);

    try {
      const token = this.config.authToken();
      const response = await this.config.fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          'x-osa-schema-version': this.config.schemaVersion,
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        },
      });

      if (!response.ok) return err(await readHttpError(response));

      const body: unknown = await response.json();
      return ok(options.decode(body, ''));
    } catch (cause: unknown) {
      if (cause instanceof DecodeFailure) return err(cause.error);
      if (options.signal?.aborted === true) return err(cancelledError());
      if (timedOut || isAbort(cause)) return err(timeoutError(this.config.timeout));
      return err(networkError(cause instanceof Error ? cause.message : String(cause)));
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onCallerAbort);
    }
  }
}

const isAbort = (cause: unknown): boolean =>
  cause instanceof Error && (cause.name === 'AbortError' || cause.name === 'TimeoutError');

/**
 * Turn a non-2xx into a `ServiceError`, keeping whatever the service said.
 *
 * The body is read defensively: an error response is exactly the case where the
 * payload is least likely to be the JSON we expected, and failing to read the
 * detail must not replace a useful 503 with an unhelpful parse error.
 */
const readHttpError = async (response: Response): Promise<ServiceError> => {
  const retryAfter = parseRetryAfter(response.headers.get('retry-after'), Date.now());
  let detail: string | null = null;
  try {
    const text = await response.text();
    if (text.trim() !== '') {
      detail = extractDetail(text);
    }
  } catch {
    detail = null;
  }
  return httpError(response.status, response.statusText, detail, retryAfter);
};

const extractDetail = (text: string): string => {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      for (const key of ['detail', 'message', 'error']) {
        const value = record[key];
        if (typeof value === 'string' && value.trim() !== '') return value;
      }
    }
  } catch {
    // Not JSON — fall through to the raw text.
  }
  return text.slice(0, 280);
};

export const createHttpClient = (
  baseUrl: string,
  overrides: Partial<Omit<HttpClientConfig, 'baseUrl'>> = {},
): ReportingHttpClient =>
  new ReportingHttpClient({
    baseUrl: baseUrl.replace(/\/+$/, ''),
    fetch: (input, init) => globalThis.fetch(input, init),
    ...DEFAULT_HTTP_CONFIG,
    ...overrides,
  });
