import type { Brand } from './brand';

/**
 * A point on the timeline, as epoch milliseconds (UTC).
 *
 * The service emits instants as ISO-8601 with an explicit UTC offset
 * (`WIRE_ENCODING.timestamps`); the dashboard parses them once at the decode
 * boundary and works in epoch millis from there, so no component ever does
 * date arithmetic on a string.
 */
export type Instant = Brand<number, 'Instant'>;

/** A span of time, in milliseconds. Never mixed with an `Instant`. */
export type Millis = Brand<number, 'Millis'>;

/** A decimal in the closed interval [0, 1] (`WIRE_ENCODING.ratios`). */
export type Ratio = Brand<number, 'Ratio'>;

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

export const ratio = (value: number): Ratio => {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`Ratio must be a decimal in [0, 1], got ${value}`);
  }
  return value as Ratio;
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

/**
 * A half-open interval `[from, to)`, matching the service's window semantics so
 * adjacent buckets tile an axis without double-counting the shared boundary.
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

/** Midpoint of a bucket — where a time-series mark is plotted. */
export const windowMidpoint = (window: TimeWindow): Instant =>
  instant(window.from + (window.to - window.from) / 2);
