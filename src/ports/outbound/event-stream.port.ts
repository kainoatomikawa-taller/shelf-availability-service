import type { Instant } from '../../domain/common/time.js';

/**
 * Outbound (driven) port for the event stream the detection producers publish to.
 *
 * Deliberately transport-neutral. Kafka is the expected substrate, but nothing
 * here names it: a record has a topic, a partition, a monotonic offset, a key, an
 * opaque payload and headers, which is the shape Kinesis, Pub/Sub and an SQS FIFO
 * queue all present too. Binding the consumers to that shape rather than to a
 * client library keeps the five source adapters testable without a broker and
 * keeps a substrate swap inside one class.
 *
 * **The key is the retailer partition.** Producers publish keyed by `retailerId`,
 * so every event for a retailer lands on one partition and is delivered in
 * publication order. The consumer re-asserts that agreement against each decoded
 * envelope rather than trusting it — see `DetectionStreamConsumer`.
 */

/** One message as the broker hands it over, before anything has been decoded. */
export interface StreamRecord {
  readonly topic: string;
  /** Broker partition index. Ordering is guaranteed within one of these, nowhere else. */
  readonly partition: number;
  /** Opaque, lexicographically comparable within a partition; what a commit names. */
  readonly offset: string;
  /**
   * Partition key. Carries the `retailerId` for every detection topic; `null`
   * when a producer published unkeyed, which the consumer treats as a fault
   * rather than guessing a partition.
   */
  readonly key: string | null;
  /** Raw payload. Bytes from a real broker; a string is accepted for test doubles. */
  readonly value: Uint8Array | string;
  readonly headers: Readonly<Record<string, string>>;
  /** Broker append time. Latency reporting and a fallback `producedAt` only. */
  readonly timestamp: Instant;
}

/**
 * Records delivered together, always from a single topic and partition.
 *
 * Single-partition by construction so a handler can reason about ordering and
 * emit one commit watermark. A broker that fans several partitions into one poll
 * is adapted by splitting them before they reach the handler.
 */
export interface StreamBatch {
  readonly topic: string;
  readonly partition: number;
  /** In ascending offset order. */
  readonly records: readonly StreamRecord[];
}

/**
 * What the handler tells the transport to commit.
 *
 * `commitThrough` is the offset of the last record that reached a terminal
 * answer, inclusive. `null` means commit nothing and redeliver the batch — the
 * honest response when the first record still needs a retry.
 */
export interface StreamBatchAck {
  readonly commitThrough: string | null;
}

export type StreamBatchHandler = (batch: StreamBatch) => Promise<StreamBatchAck>;

export interface StreamSubscription {
  readonly topics: readonly string[];
  close(): Promise<void>;
}

export interface EventStreamConsumerPort {
  /**
   * Subscribes to `topics` and drives `handler` once per delivered batch.
   *
   * Implementations must commit through the returned offset and must not advance
   * past it, or a record the consumer asked to have redelivered would be lost.
   */
  subscribe(topics: readonly string[], handler: StreamBatchHandler): Promise<StreamSubscription>;
}
