import type { Brand } from './brand.js';

/** A point on the timeline, as epoch milliseconds (UTC). */
export type Instant = Brand<number, 'Instant'>;

/** A span of time, in milliseconds. Never mixed with an `Instant`. */
export type Millis = Brand<number, 'Millis'>;

export const instant = (epochMillis: number): Instant => {
  if (!Number.isFinite(epochMillis)) {
    throw new TypeError(`Instant must be a finite number of epoch millis, got ${epochMillis}`);
  }
  return epochMillis as Instant;
};

export const instantFromISO = (iso: string): Instant => {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) {
    throw new TypeError(`Instant must be a valid ISO-8601 timestamp, got "${iso}"`);
  }
  return parsed as Instant;
};

export const toISO = (value: Instant): string => new Date(value).toISOString();

export const millis = (value: number): Millis => {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`Millis must be a finite, non-negative number, got ${value}`);
  }
  return value as Millis;
};

export const SECOND: Millis = millis(1_000);
export const MINUTE: Millis = millis(60 * 1_000);
export const HOUR: Millis = millis(60 * 60 * 1_000);
export const DAY: Millis = millis(24 * 60 * 60 * 1_000);
export const WEEK: Millis = millis(7 * 24 * 60 * 60 * 1_000);

/** Non-negative distance between two instants. */
export const elapsed = (from: Instant, to: Instant): Millis => millis(Math.max(0, to - from));

export const plus = (at: Instant, span: Millis): Instant => instant(at + span);
export const minus = (at: Instant, span: Millis): Instant => instant(at - span);

export const isBefore = (a: Instant, b: Instant): boolean => a < b;
export const isAfter = (a: Instant, b: Instant): boolean => a > b;

/**
 * A half-open interval `[from, to)`. Half-open so that adjacent windows tile the
 * timeline without double-counting the shared boundary instant.
 */
export interface TimeWindow {
  readonly from: Instant;
  readonly to: Instant;
}

export const timeWindow = (from: Instant, to: Instant): TimeWindow => {
  if (to < from) {
    throw new RangeError(
      `TimeWindow end must not precede its start: ${toISO(from)} .. ${toISO(to)}`,
    );
  }
  return { from, to };
};

export const windowDuration = (window: TimeWindow): Millis => elapsed(window.from, window.to);

export const contains = (window: TimeWindow, at: Instant): boolean =>
  at >= window.from && at < window.to;

/** Length of the overlap between `[a, b)` and the window, clamped at zero. */
export const overlapMillis = (window: TimeWindow, from: Instant, to: Instant): Millis => {
  const start = Math.max(window.from, from);
  const end = Math.min(window.to, to);
  return millis(Math.max(0, end - start));
};
