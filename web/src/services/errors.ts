import { assertNever } from '../models/exhaustive';
import type { Millis } from '../models/time';

/**
 * Everything that can go wrong between asking the reporting endpoints a question
 * and having an answer the dashboard can render.
 *
 * A union rather than an `Error` subclass hierarchy: the UI branches on *why* a
 * panel is empty — a 403 needs different words and a different affordance from a
 * dropped connection — and a union makes that branch exhaustive.
 */
export type ServiceError =
  | { readonly kind: 'network'; readonly message: string }
  | { readonly kind: 'timeout'; readonly afterMillis: Millis }
  /** The caller aborted — a scope change superseded the request, not a failure. */
  | { readonly kind: 'cancelled' }
  | {
      readonly kind: 'http';
      readonly status: number;
      readonly statusText: string;
      /** Problem detail from the service, when it sent one. */
      readonly detail: string | null;
      /** From `Retry-After`, when the service asked us to back off. */
      readonly retryAfter: Millis | null;
    }
  | {
      /** The response parsed as JSON but did not match the published schema. */
      readonly kind: 'decode';
      /** Dotted path to the offending field, e.g. `overall.index`. */
      readonly path: string;
      readonly expected: string;
      readonly received: string;
    };

export const networkError = (message: string): ServiceError => ({ kind: 'network', message });

export const timeoutError = (afterMillis: Millis): ServiceError => ({
  kind: 'timeout',
  afterMillis,
});

export const cancelledError = (): ServiceError => ({ kind: 'cancelled' });

export const httpError = (
  status: number,
  statusText: string,
  detail: string | null,
  retryAfter: Millis | null,
): ServiceError => ({ kind: 'http', status, statusText, detail, retryAfter });

export const decodeError = (path: string, expected: string, received: string): ServiceError => ({
  kind: 'decode',
  path,
  expected,
  received,
});

/**
 * Thrown by decoders so a failure carries the field that caused it all the way
 * up, instead of degrading into "invalid response".
 */
export class DecodeFailure extends Error {
  readonly error: ServiceError;

  constructor(path: string, expected: string, received: string) {
    super(`Expected ${expected} at "${path}", received ${received}`);
    this.name = 'DecodeFailure';
    this.error = decodeError(path, expected, received);
  }
}

/**
 * Whether trying again unchanged could plausibly succeed.
 *
 * A decode failure is never retryable: the same request would produce the same
 * unparseable body, and retrying only delays the report that the contract broke.
 */
export const isRetryable = (error: ServiceError): boolean => {
  switch (error.kind) {
    case 'network':
    case 'timeout':
      return true;
    case 'cancelled':
    case 'decode':
      return false;
    case 'http':
      return error.status === 408 || error.status === 429 || error.status >= 500;
    default:
      return assertNever(error, 'isRetryable');
  }
};

/** A cancellation is bookkeeping, not something to put in front of a user. */
export const isUserVisible = (error: ServiceError): boolean => error.kind !== 'cancelled';

export interface ErrorPresentation {
  /** Short, sentence case, no trailing period — goes in the panel headline. */
  readonly title: string;
  /** One sentence the reader can act on. */
  readonly detail: string;
  readonly retryable: boolean;
}

/**
 * How an error reads in a panel.
 *
 * Deliberately central: an availability card and a task table failing the same
 * way must say the same thing, and the wording is the part most likely to drift
 * if each component writes its own.
 */
export const describeServiceError = (error: ServiceError): ErrorPresentation => {
  switch (error.kind) {
    case 'network':
      return {
        title: 'Could not reach the service',
        detail: 'The request did not complete. Check the connection and try again.',
        retryable: true,
      };
    case 'timeout':
      return {
        title: 'The report timed out',
        detail: `No answer after ${Math.round(error.afterMillis / 1000)}s. A narrower window usually returns faster.`,
        retryable: true,
      };
    case 'cancelled':
      return { title: 'Request cancelled', detail: 'Superseded by a newer request.', retryable: false };
    case 'decode':
      return {
        title: 'The service sent an unexpected response',
        detail: `Expected ${error.expected} at "${error.path}". This is a schema mismatch, not a transient fault.`,
        retryable: false,
      };
    case 'http':
      return describeHttpError(error.status, error.statusText, error.detail);
    default:
      return assertNever(error, 'describeServiceError');
  }
};

const describeHttpError = (
  status: number,
  statusText: string,
  detail: string | null,
): ErrorPresentation => {
  const fallback = detail ?? statusText;
  if (status === 401) {
    return { title: 'Session expired', detail: 'Sign in again to keep reading this report.', retryable: false };
  }
  if (status === 403) {
    return {
      title: 'Not available for this retailer',
      detail: 'This account cannot read the requested partition.',
      retryable: false,
    };
  }
  if (status === 404) {
    return { title: 'Nothing reported here', detail: 'The service has no report for this scope.', retryable: false };
  }
  if (status === 429) {
    return { title: 'Too many requests', detail: 'The service asked us to slow down. Retrying shortly.', retryable: true };
  }
  if (status >= 500) {
    return { title: 'The service failed', detail: `The reporting endpoint returned ${status}. ${fallback}`.trim(), retryable: true };
  }
  return { title: `Request rejected (${status})`, detail: fallback, retryable: false };
};
