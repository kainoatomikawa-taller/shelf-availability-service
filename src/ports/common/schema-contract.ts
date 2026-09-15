import type { Instant } from '../../domain/common/time.js';

/**
 * Versioning contract shared by every schema this layer publishes at its boundary.
 *
 * This layer owns its boundary schemas: upstream producers and downstream
 * consumers adapt to them, not the other way round. The rules are therefore
 * stated once, here, and referenced by each port.
 *
 * Versions are `major.minor`:
 *  - **Minor** — additive and backward compatible. New optional fields, new
 *    enum members in a position documented as open. Producers pinned to the same
 *    major need no change, and consumers must ignore fields they do not know.
 *  - **Major** — anything else: removing a field, narrowing a type, renaming,
 *    changing units or making an optional field required.
 *
 * The service accepts the current major and the previous major until that
 * major's declared sunset instant, which gives producers a bounded, visible
 * migration window instead of a flag day.
 */
export type SchemaVersion = `${number}.${number}`;

/** Wire-level encoding rules, fixed across every boundary schema this layer owns. */
export interface WireEncoding {
  readonly transport: 'json';
  /** ISO-8601 with an explicit UTC offset. Domain `Instant`s are epoch millis internally. */
  readonly timestamps: 'iso-8601-utc';
  /** Identifiers are opaque UTF-8 strings; producers must not assume a format. */
  readonly identifiers: 'opaque-utf8-string';
  /** Confidence and ratio fields are decimals in the closed interval [0, 1]. */
  readonly ratios: 'decimal-0-to-1';
  /** Durations are integer milliseconds. */
  readonly durations: 'integer-milliseconds';
}

export const WIRE_ENCODING: WireEncoding = {
  transport: 'json',
  timestamps: 'iso-8601-utc',
  identifiers: 'opaque-utf8-string',
  ratios: 'decimal-0-to-1',
  durations: 'integer-milliseconds',
};

/** A major version scheduled for removal, announced ahead of the cut-off. */
export interface SchemaSunset {
  readonly version: SchemaVersion;
  /** After this instant the version is rejected rather than accepted with a warning. */
  readonly sunsetAt: Instant;
  readonly replacedBy: SchemaVersion;
  /** Where a producer finds the migration guide. */
  readonly migrationGuide: string;
}

/**
 * What a port publishes so a producer or consumer can negotiate before sending
 * anything — the machine-readable half of the versioning contract.
 */
export interface SchemaContract {
  readonly schemaName: string;
  readonly current: SchemaVersion;
  /** Every version still accepted, including `current`. */
  readonly supported: readonly SchemaVersion[];
  readonly sunsets: readonly SchemaSunset[];
  readonly encoding: WireEncoding;
  /**
   * Whether unrecognised fields are ignored (forward compatible) or rejected.
   * Fixed at `ignore` for every schema this layer owns.
   */
  readonly unknownFields: 'ignore';
}
