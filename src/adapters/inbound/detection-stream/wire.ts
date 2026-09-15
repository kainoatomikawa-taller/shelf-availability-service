import { instant, instantFromISO, type Instant } from '../../../domain/common/time.js';
import { confidence, type Confidence } from '../../../domain/facing/signals.js';

/**
 * Reading primitives for untrusted producer payloads.
 *
 * Every source adapter is handed a parsed-but-unverified `unknown`, and each one
 * would otherwise grow its own pile of `typeof` checks. These combinators do that
 * once, and — more importantly — thread a field path through, so a rejection says
 * `segments[3].void_pct: expected a percentage within [0, 100], got 140` rather
 * than `TypeError: cannot read property of undefined`. The vendor engineer on the
 * other end of the dead-letter queue is the audience for that string.
 *
 * Readers throw rather than return a `Result`: a payload has one first error worth
 * reporting, and threading a result monad through five nested objects would bury
 * the mapping itself. The consumer catches at the record boundary, where the
 * throw becomes exactly one dead letter.
 */

export class WireViolationError extends Error {
  constructor(
    readonly field: string,
    readonly detail: string,
  ) {
    super(`${field}: ${detail}`);
    this.name = 'WireViolationError';
  }
}

const violate = (field: string, detail: string): never => {
  throw new WireViolationError(field, detail);
};

const describe = (value: unknown): string => {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return value.trim() === '' ? 'a blank string' : 'a string';
  return `a ${typeof value}`;
};

/** A JSON object paired with the path it was reached by. */
export interface WireObject {
  readonly path: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

/**
 * Whether a parsed payload is a JSON object at all.
 *
 * Exported so the consumer can separate "this is not a detection payload" from
 * "this payload is missing a field": both are schema violations, but only the
 * second is worth pointing a vendor at a field path for.
 */
export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const wireObject = (value: unknown, path: string): WireObject =>
  isPlainObject(value)
    ? { path, fields: value }
    : violate(path === '' ? '<payload>' : path, `expected an object, got ${describe(value)}`);

const pathTo = (o: WireObject, key: string): string => (o.path === '' ? key : `${o.path}.${key}`);

const rawValue = (o: WireObject, key: string): unknown => o.fields[key];

/** True when the key holds something other than `undefined` or `null`. */
export const present = (o: WireObject, key: string): boolean =>
  rawValue(o, key) !== undefined && rawValue(o, key) !== null;

export const obj = (o: WireObject, key: string): WireObject =>
  wireObject(rawValue(o, key), pathTo(o, key));

export const str = (o: WireObject, key: string): string => {
  const value = rawValue(o, key);
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : violate(pathTo(o, key), `expected a non-empty string, got ${describe(value)}`);
};

export const num = (o: WireObject, key: string): number => {
  const value = rawValue(o, key);
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : violate(pathTo(o, key), `expected a finite number, got ${describe(value)}`);
};

export const int = (o: WireObject, key: string): number => {
  const value = num(o, key);
  return Number.isInteger(value)
    ? value
    : violate(pathTo(o, key), `expected an integer, got ${value}`);
};

export const nonNegativeInt = (o: WireObject, key: string): number => {
  const value = int(o, key);
  return value >= 0 ? value : violate(pathTo(o, key), `expected a non-negative integer, got ${value}`);
};

export const nonNegativeNum = (o: WireObject, key: string): number => {
  const value = num(o, key);
  return value >= 0 ? value : violate(pathTo(o, key), `expected a non-negative number, got ${value}`);
};

export const bool = (o: WireObject, key: string): boolean => {
  const value = rawValue(o, key);
  return typeof value === 'boolean'
    ? value
    : violate(pathTo(o, key), `expected a boolean, got ${describe(value)}`);
};

export const arr = (o: WireObject, key: string): readonly unknown[] => {
  const value = rawValue(o, key);
  return Array.isArray(value)
    ? value
    : violate(pathTo(o, key), `expected an array, got ${describe(value)}`);
};

/**
 * An array that must carry at least one element.
 *
 * An empty observation list is a producer bug worth surfacing, not a no-op event:
 * silently accepting it would report a bay as scanned when nothing was looked at.
 */
export const nonEmptyArr = (o: WireObject, key: string): readonly unknown[] => {
  const value = arr(o, key);
  return value.length > 0 ? value : violate(pathTo(o, key), 'expected at least one element');
};

/** Elements of an array, each as a `WireObject` carrying its index in the path. */
export const objectsIn = (o: WireObject, key: string): readonly WireObject[] =>
  nonEmptyArr(o, key).map((element, index) =>
    wireObject(element, `${pathTo(o, key)}[${index}]`),
  );

/**
 * Translates a producer's own vocabulary into ours.
 *
 * The heart of adapting to upstream rather than dictating to it: every vendor
 * spells its enums differently, and an unrecognised member is reported with the
 * accepted set so the gap between the two vocabularies is legible at a glance.
 */
export const mapped = <T>(o: WireObject, key: string, table: Readonly<Record<string, T>>): T => {
  const code = str(o, key);
  const translated = table[code];
  return translated === undefined
    ? violate(
        pathTo(o, key),
        `unrecognised value "${code}"; expected one of ${Object.keys(table).join(', ')}`,
      )
    : translated;
};

export const isoInstant = (o: WireObject, key: string): Instant => {
  const value = str(o, key);
  try {
    return instantFromISO(value);
  } catch {
    return violate(pathTo(o, key), `expected an ISO-8601 timestamp, got "${value}"`);
  }
};

export const epochMillisInstant = (o: WireObject, key: string): Instant => instant(int(o, key));

export const ratio = (o: WireObject, key: string): Confidence => {
  const value = num(o, key);
  try {
    return confidence(value);
  } catch {
    return violate(pathTo(o, key), `expected a ratio within [0, 1], got ${value}`);
  }
};

/** A 0–100 percentage, as a ratio. One of the more common unit mismatches at this boundary. */
export const percentAsRatio = (o: WireObject, key: string): Confidence => {
  const value = num(o, key);
  return value >= 0 && value <= 100
    ? confidence(value / 100)
    : violate(pathTo(o, key), `expected a percentage within [0, 100], got ${value}`);
};

/**
 * A decimal money amount as minor units.
 *
 * Parsed off the string rather than through `parseFloat`, because `5.99 * 100` is
 * `598.9999999999999` and a price that reads as a cent low on the shelf edge is
 * exactly the defect this service exists to catch.
 */
export const decimalAsCents = (o: WireObject, key: string): number => {
  const text = str(o, key);
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (match === null) {
    return violate(pathTo(o, key), `expected a non-negative decimal amount like "5.99", got "${text}"`);
  }
  const whole = Number(match[1] ?? '0');
  const fraction = (match[2] ?? '').padEnd(2, '0');
  return whole * 100 + Number(fraction);
};

/** Reads a field when the producer supplied one, `null` when it did not. */
export const optional = <T>(
  o: WireObject,
  key: string,
  read: (o: WireObject, key: string) => T,
): T | null => (present(o, key) ? read(o, key) : null);
