import type { Instant, Millis, Ratio, TimeWindow } from '../models/time';
import { instantFromISO, millis, ratio, timeWindow } from '../models/time';
import { DecodeFailure } from './errors';

/**
 * Hand-written decoders for the reporting endpoints' JSON.
 *
 * No schema library, and no `as` cast at the boundary either. Every field is
 * checked, and a field that is missing or the wrong type fails the decode with
 * the dotted path that caused it — so a contract break surfaces as
 * "`overall.index` expected ratio, received string" in the panel and the console,
 * rather than as `NaN%` on a card that a store manager then acts on.
 *
 * The encoding these decode is the one the service publishes in `WIRE_ENCODING`:
 * JSON transport, ISO-8601 UTC timestamps, opaque string identifiers, ratios as
 * decimals in [0, 1], durations as integer milliseconds.
 */
export type Decoder<T> = (raw: unknown, path: string) => T;

const describe = (raw: unknown): string => {
  if (raw === null) return 'null';
  if (Array.isArray(raw)) return `array(${raw.length})`;
  return typeof raw;
};

export const fail = (path: string, expected: string, raw: unknown): never => {
  throw new DecodeFailure(path, expected, describe(raw));
};

export const decodeObject = (raw: unknown, path: string): Readonly<Record<string, unknown>> => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return fail(path, 'object', raw);
  }
  return raw as Readonly<Record<string, unknown>>;
};

/** Reads a field. Present-but-undefined is treated as absent, like JSON omission. */
export const field = (raw: unknown, key: string, path: string): unknown =>
  decodeObject(raw, path)[key];

export const at = (path: string, key: string): string => (path === '' ? key : `${path}.${key}`);

export const decodeString = (raw: unknown, path: string): string =>
  typeof raw === 'string' ? raw : fail(path, 'string', raw);

export const decodeNumber = (raw: unknown, path: string): number =>
  typeof raw === 'number' && Number.isFinite(raw) ? raw : fail(path, 'finite number', raw);

export const decodeInteger = (raw: unknown, path: string): number => {
  const value = decodeNumber(raw, path);
  return Number.isInteger(value) ? value : fail(path, 'integer', raw);
};

/** A non-negative count. Guards against a negative slipping into a bar chart. */
export const decodeCount = (raw: unknown, path: string): number => {
  const value = decodeInteger(raw, path);
  return value >= 0 ? value : fail(path, 'non-negative integer', raw);
};

export const decodeBoolean = (raw: unknown, path: string): boolean =>
  typeof raw === 'boolean' ? raw : fail(path, 'boolean', raw);

export const decodeRatio = (raw: unknown, path: string): Ratio => {
  const value = decodeNumber(raw, path);
  try {
    return ratio(value);
  } catch {
    return fail(path, 'ratio in [0, 1]', raw);
  }
};

export const decodeMillis = (raw: unknown, path: string): Millis => {
  const value = decodeNumber(raw, path);
  try {
    return millis(value);
  } catch {
    return fail(path, 'non-negative duration in milliseconds', raw);
  }
};

export const decodeInstant = (raw: unknown, path: string): Instant => {
  const value = decodeString(raw, path);
  try {
    return instantFromISO(value);
  } catch {
    return fail(path, 'ISO-8601 UTC timestamp', raw);
  }
};

export const decodeTimeWindow = (raw: unknown, path: string): TimeWindow => {
  const from = decodeInstant(field(raw, 'from', path), at(path, 'from'));
  const to = decodeInstant(field(raw, 'to', path), at(path, 'to'));
  try {
    return timeWindow(from, to);
  } catch {
    return fail(path, 'half-open window with to >= from', raw);
  }
};

/** `null` passes through; anything else is handed to the inner decoder. */
export const decodeNullable =
  <T>(inner: Decoder<T>): Decoder<T | null> =>
  (raw, path) =>
    raw === null || raw === undefined ? null : inner(raw, path);

export const decodeArray =
  <T>(inner: Decoder<T>): Decoder<readonly T[]> =>
  (raw, path) => {
    if (!Array.isArray(raw)) return fail(path, 'array', raw);
    return raw.map((item, index) => inner(item, `${path}[${index}]`));
  };

/**
 * A closed union member.
 *
 * Unknown members fail rather than falling back. The service's unions are closed
 * and a new member is a major version bump — silently dropping one would leave
 * tasks missing from a queue with no indication anything was lost.
 */
export const decodeEnum =
  <T extends string>(members: readonly T[], name: string): Decoder<T> =>
  (raw, path) => {
    const value = decodeString(raw, path);
    return (members as readonly string[]).includes(value)
      ? (value as T)
      : fail(path, `${name} (one of ${members.join(', ')})`, raw);
  };

/** An opaque identifier: any non-empty string, branded by the caller. */
export const decodeId =
  <T extends string>(name: string): Decoder<T> =>
  (raw, path) => {
    const value = decodeString(raw, path).trim();
    return value.length > 0 ? (value as T) : fail(path, `non-empty ${name}`, raw);
  };

/** A total record keyed by a closed union — every member must be present. */
export const decodeRecordOf =
  <K extends string, V>(keys: readonly K[], inner: Decoder<V>): Decoder<Readonly<Record<K, V>>> =>
  (raw, path) => {
    const object = decodeObject(raw, path);
    const entries = keys.map((key) => [key, inner(object[key], at(path, key))] as const);
    return Object.fromEntries(entries) as Readonly<Record<K, V>>;
  };

/**
 * A total record keyed by a closed union, defaulting absent members to zero.
 *
 * Count rollups legitimately omit buckets that are empty, and a missing
 * `cancelled` key means "none", not "unknown" — unlike a missing measurement,
 * which still fails. Used only for count maps, never for measures.
 */
export const decodeCountsOf =
  <K extends string>(keys: readonly K[]): Decoder<Readonly<Record<K, number>>> =>
  (raw, path) => {
    const object = decodeObject(raw, path);
    const entries = keys.map(
      (key) => [key, object[key] === undefined ? 0 : decodeCount(object[key], at(path, key))] as const,
    );
    return Object.fromEntries(entries) as Readonly<Record<K, number>>;
  };
