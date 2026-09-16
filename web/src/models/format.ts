import type { Instant, Millis, Ratio } from './time';

/**
 * How numbers are written across the dashboard.
 *
 * Centralised because the alternative is four panels rounding the same
 * availability index four different ways, and a retailer noticing before we do.
 *
 * Every formatter takes `null` and renders the em-dash placeholder for it. That
 * is the single most load-bearing rule in this file: a null here means "not
 * measured", and any formatter that turned it into `0` or `0%` would state a
 * fact the service explicitly refused to state.
 */
export const NOT_MEASURED = '—';

const RATIO_FORMAT = new Intl.NumberFormat('en', {
  style: 'percent',
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

const WHOLE_PERCENT_FORMAT = new Intl.NumberFormat('en', {
  style: 'percent',
  maximumFractionDigits: 0,
});

const COUNT_FORMAT = new Intl.NumberFormat('en');

const COMPACT_FORMAT = new Intl.NumberFormat('en', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

const DECIMAL_FORMAT = new Intl.NumberFormat('en', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 2,
});

export const formatRatio = (value: Ratio | number | null): string =>
  value === null ? NOT_MEASURED : RATIO_FORMAT.format(value);

export const formatWholePercent = (value: Ratio | number | null): string =>
  value === null ? NOT_MEASURED : WHOLE_PERCENT_FORMAT.format(value);

export const formatCount = (value: number | null): string =>
  value === null ? NOT_MEASURED : COUNT_FORMAT.format(value);

/** Auto-compact, for a stat tile's value: 1,284 / 12.9K / 4.2M. */
export const formatCompactCount = (value: number | null): string => {
  if (value === null) return NOT_MEASURED;
  return Math.abs(value) < 10_000 ? COUNT_FORMAT.format(value) : COMPACT_FORMAT.format(value);
};

export const formatDecimal = (value: number | null): string =>
  value === null ? NOT_MEASURED : DECIMAL_FORMAT.format(value);

/**
 * A duration at the coarsest grain that still says something.
 *
 * `2h 15m`, not `2.25 hours` and not `8100000ms`: store operations talk in hours
 * and minutes, and a latency chart's axis has to agree with the card above it.
 */
export const formatDuration = (value: Millis | number | null): string => {
  if (value === null) return NOT_MEASURED;
  const totalSeconds = Math.round(value / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours === 0 ? `${days}d` : `${days}d ${remainingHours}h`;
};

/** A signed change, for a delta chip. Percentage points, not a percentage of a percentage. */
export const formatDelta = (delta: number | null, unit: 'points' | 'percent' | 'count'): string => {
  if (delta === null) return NOT_MEASURED;
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : '';
  const magnitude = Math.abs(delta);
  switch (unit) {
    case 'points':
      return `${sign}${DECIMAL_FORMAT.format(magnitude * 100)} pts`;
    case 'percent':
      return `${sign}${WHOLE_PERCENT_FORMAT.format(magnitude)}`;
    case 'count':
      return `${sign}${COUNT_FORMAT.format(magnitude)}`;
  }
};

const TIME_FORMAT = new Intl.DateTimeFormat('en', {
  hour: 'numeric',
  minute: '2-digit',
  hour12: false,
  timeZone: 'UTC',
});

const DATE_TIME_FORMAT = new Intl.DateTimeFormat('en', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: false,
  timeZone: 'UTC',
});

const DATE_FORMAT = new Intl.DateTimeFormat('en', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

/**
 * Instants render in UTC, always.
 *
 * A pilot spans stores in several timezones and the service reasons entirely in
 * UTC. Rendering in the reader's local zone would put a shelf event at a time
 * nobody in that store recognises, and make two people comparing screens
 * disagree about when a gap opened.
 */
export const formatTimeUtc = (at: Instant | null): string =>
  at === null ? NOT_MEASURED : `${TIME_FORMAT.format(at)} UTC`;

export const formatDateTimeUtc = (at: Instant | null): string =>
  at === null ? NOT_MEASURED : `${DATE_TIME_FORMAT.format(at)} UTC`;

export const formatDateUtc = (at: Instant | null): string =>
  at === null ? NOT_MEASURED : DATE_FORMAT.format(at);

/** "4h ago" — for a freshness line under a figure. */
export const formatAge = (at: Instant | null, now: Instant): string =>
  at === null ? NOT_MEASURED : `${formatDuration(Math.max(0, now - at))} ago`;
