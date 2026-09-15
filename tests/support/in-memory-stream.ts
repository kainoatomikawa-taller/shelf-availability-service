import {
  instant,
  millis,
  type DeadLetter,
  type DeadLetterSinkPort,
  type DetectionEventBatch,
  type DetectionIngestionPort,
  type EventStreamConsumerPort,
  type IngestionOutcome,
  type Instant,
  type SchemaContract,
  type StreamBatch,
  type StreamBatchAck,
  type StreamBatchHandler,
  type StreamRecord,
  type StreamSubscription,
} from '../../src/index.js';

/**
 * Test doubles for the transport side of detection-stream consumption.
 *
 * Faithful rather than convenient, in the same spirit as the in-memory ports: the
 * stream hands over records batched per topic-partition and honours the commit
 * watermark the handler returns, so a test that forgets a record can actually
 * observe it being redelivered.
 */

let offsetCounter = 0;

/** One record, with the retailer partition key a real producer would publish under. */
export const streamRecord = (
  topic: string,
  key: string | null,
  payload: unknown,
  overrides: Partial<StreamRecord> = {},
): StreamRecord => ({
  topic,
  partition: 0,
  offset: String(++offsetCounter).padStart(6, '0'),
  key,
  value: typeof payload === 'string' ? payload : JSON.stringify(payload),
  headers: {},
  timestamp: instant(Date.UTC(2026, 2, 2, 9, 0, 5)),
  ...overrides,
});

export const streamBatch = (topic: string, records: readonly StreamRecord[]): StreamBatch => ({
  topic,
  partition: 0,
  records,
});

export class InMemoryEventStream implements EventStreamConsumerPort {
  private handler: StreamBatchHandler | null = null;
  private subscribedTopics: readonly string[] = [];
  private closed = false;

  /** Every ack the consumer returned, in delivery order. */
  readonly acks: StreamBatchAck[] = [];

  async subscribe(
    topics: readonly string[],
    handler: StreamBatchHandler,
  ): Promise<StreamSubscription> {
    this.handler = handler;
    this.subscribedTopics = topics;
    this.closed = false;
    return {
      topics,
      close: async () => {
        this.closed = true;
        this.handler = null;
      },
    };
  }

  get topics(): readonly string[] {
    return this.subscribedTopics;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Drives the subscribed handler with one batch and records what it acked. */
  async deliver(batch: StreamBatch): Promise<StreamBatchAck> {
    if (this.handler === null) throw new Error('nothing is subscribed to this stream');
    // A broker never mixes partitions in one delivery, and the handler is written
    // assuming it; enforcing it here keeps a test from proving something false.
    if (batch.records.some((record) => record.topic !== batch.topic)) {
      throw new Error('a stream batch carries records from exactly one topic');
    }
    const ack = await this.handler(batch);
    this.acks.push(ack);
    return ack;
  }
}

export class RecordingDeadLetterSink implements DeadLetterSinkPort {
  readonly letters: DeadLetter[] = [];
  /** Counts calls, so a test can assert one batch produces one filing. */
  captureCalls = 0;

  async capture(letters: readonly DeadLetter[]): Promise<void> {
    this.captureCalls += 1;
    this.letters.push(...letters);
  }

  reasons(): readonly string[] {
    return this.letters.map((letter) => letter.reason);
  }
}

/**
 * Wraps a real ingestion port and keeps every batch it was handed.
 *
 * The only way to prove the partition survived consumption is to look at what the
 * consumer actually submitted — a per-retailer batch, never a pooled one — so the
 * test asserts against these rather than against the end state.
 */
export class RecordingIngestion implements DetectionIngestionPort {
  readonly batches: DetectionEventBatch[] = [];

  constructor(private readonly delegate: DetectionIngestionPort) {}

  async ingest(event: Parameters<DetectionIngestionPort['ingest']>[0]): Promise<IngestionOutcome> {
    return this.delegate.ingest(event);
  }

  async ingestBatch(batch: DetectionEventBatch): Promise<readonly IngestionOutcome[]> {
    this.batches.push(batch);
    return this.delegate.ingestBatch(batch);
  }

  async describeSchemaContract(): Promise<SchemaContract> {
    return this.delegate.describeSchemaContract();
  }
}

/** An ingestion port that answers with whatever a test scripted, in order. */
export class ScriptedIngestion implements DetectionIngestionPort {
  constructor(private readonly outcomes: readonly IngestionOutcome[]) {}

  private cursor = 0;

  async ingest(): Promise<IngestionOutcome> {
    const outcome = this.outcomes[this.cursor++];
    if (outcome === undefined) throw new Error('scripted ingestion ran out of outcomes');
    return outcome;
  }

  async ingestBatch(batch: DetectionEventBatch): Promise<readonly IngestionOutcome[]> {
    const results: IngestionOutcome[] = [];
    for (let index = 0; index < batch.events.length; index += 1) {
      results.push(await this.ingest());
    }
    return results;
  }

  async describeSchemaContract(): Promise<SchemaContract> {
    throw new Error('not used');
  }
}

export const rateLimited = (retryAfter: number): IngestionOutcome => ({
  status: 'rejected',
  rejection: { reason: 'rate_limited', retryAfter: millis(retryAfter) },
});

export const acceptedAt = (at: Instant): IngestionOutcome => ({
  status: 'accepted',
  acceptedAt: at,
  results: [],
});
