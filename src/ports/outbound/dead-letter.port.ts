import type { RetailerId } from '../../domain/common/ids.js';
import type { Instant } from '../../domain/common/time.js';

/**
 * Outbound (driven) port for records the consumer could not turn into a
 * detection event.
 *
 * A stream consumer has exactly two ways to answer a message it cannot use:
 * stop, or set it aside. Stopping is wrong here — one vendor shipping a bad
 * build would halt every other retailer's shelf detections behind it — so the
 * consumer sets it aside and keeps reading. That is only defensible if the
 * message is kept verbatim and attributable, which is what this port is for: a
 * dead letter is evidence for the producer's owner, not a log line.
 */

export type DeadLetterReason =
  /** Arrived on a topic no source adapter is bound to. */
  | 'unknown_topic'
  /** The payload bytes are not valid UTF-8. */
  | 'undecodable_bytes'
  /** Valid UTF-8, but not valid JSON. */
  | 'malformed_payload'
  /** The producer's own version marker is missing or names a version we cannot read. */
  | 'unsupported_wire_version'
  /** Readable version, but a field is absent, mistyped or outside its range. */
  | 'schema_violation'
  /** The broker's partition key and the envelope's `retailerId` disagree. */
  | 'partition_key_mismatch'
  /** Decoded cleanly, and the ingestion use case refused it for a reason retrying cannot fix. */
  | 'rejected_by_ingestion';

export interface DeadLetter {
  readonly topic: string;
  readonly partition: number;
  readonly offset: string;
  readonly key: string | null;
  /**
   * The payload as received, so the producer's owner can reproduce the failure.
   * Lossily decoded when the bytes themselves were the problem.
   */
  readonly payload: string;
  readonly reason: DeadLetterReason;
  /** Human-readable, and specific: the offending field path wherever there is one. */
  readonly detail: string;
  /**
   * Partition of the event, once it is known. `null` when decoding failed before
   * the envelope could be read — the one case where a dead letter cannot be
   * filed under a retailer, and the reason the field is nullable rather than absent.
   */
  readonly retailerId: RetailerId | null;
  readonly failedAt: Instant;
}

export interface DeadLetterSinkPort {
  /** Captures a batch of dead letters. Called once per consumed stream batch. */
  capture(letters: readonly DeadLetter[]): Promise<void>;
}
