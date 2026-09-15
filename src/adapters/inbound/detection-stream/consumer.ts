import { assertNever } from '../../../domain/common/exhaustive.js';
import { retailerId as asRetailerId, type RetailerId } from '../../../domain/common/ids.js';
import { belongsToRetailer } from '../../../domain/common/partition.js';
import { err, ok, type Result } from '../../../domain/common/result.js';
import type { Instant, Millis } from '../../../domain/common/time.js';
import type {
  DetectionEvent,
  DetectionEventBatch,
  DetectionIngestionPort,
  IngestionOutcome,
  IngestionRejection,
  ObservationResult,
} from '../../../ports/inbound/detection-ingestion.port.js';
import type {
  DeadLetter,
  DeadLetterReason,
  DeadLetterSinkPort,
} from '../../../ports/outbound/dead-letter.port.js';
import type {
  EventStreamConsumerPort,
  StreamBatch,
  StreamRecord,
  StreamSubscription,
} from '../../../ports/outbound/event-stream.port.js';
import { ALL_SOURCE_ADAPTERS } from './registry.js';
import type { AnySourceAdapter } from './source-adapter.js';
import { isPlainObject, WireViolationError } from './wire.js';

/**
 * The driving adapter: it reads the detection stream and drives the ingestion
 * use case with what it finds.
 *
 * Everything source-specific lives in the five `SourceAdapter`s; what lives here
 * is the part that is the same whichever vendor published — deserialize, check
 * the producer's version, translate, re-assert the retailer partition, group, and
 * decide what to commit. That split is why adding a source is one new file and a
 * registry entry rather than a change to this class.
 *
 * ### Nothing in a payload can stop the consumer
 *
 * Every failure that is a property of the *data* — unreadable bytes, bad JSON, an
 * unknown producer version, a missing field, a partition key that disagrees with
 * the envelope, a rejection ingestion will give again on every retry — produces a
 * dead letter and a disposition, never a throw. Five vendors on five release
 * cadences publish here; one of them shipping a bad build must cost that vendor
 * its own dead-letter queue, not cost every retailer their shelf detections.
 *
 * Only infrastructure failures propagate: the ingestion port throwing, or the
 * dead-letter sink refusing to take the evidence. Those leave the batch
 * uncommitted so the broker redelivers it, which is safe because ingestion is
 * idempotent on the envelope's key.
 *
 * ### The retailer partition survives the whole trip
 *
 * Producers publish keyed by `retailerId`, so a retailer's events occupy one
 * broker partition and arrive in order. The consumer does not merely inherit that:
 * it checks each decoded envelope against the record's key, and it groups decoded
 * events by `retailerId` before calling ingestion, so every `DetectionEventBatch`
 * it submits is single-partition by construction — the same invariant the domain
 * enforces internally, asserted at the point the data enters the process.
 */

/** What became of one stream record. */
export type DispositionOutcome =
  | { readonly status: 'ingested'; readonly results: readonly ObservationResult[] }
  /** Already ingested under this key; the original result stands. */
  | { readonly status: 'duplicate'; readonly firstAcceptedAt: Instant }
  | {
      readonly status: 'dead_lettered';
      readonly reason: DeadLetterReason;
      readonly detail: string;
    }
  /** Refused for a reason that time can fix. Held back from the commit watermark. */
  | { readonly status: 'retry'; readonly retryAfter: Millis };

export interface RecordDisposition {
  readonly offset: string;
  /** `null` when decoding failed before the envelope's partition could be read. */
  readonly retailerId: RetailerId | null;
  readonly outcome: DispositionOutcome;
}

export interface ConsumedBatch {
  readonly topic: string;
  readonly partition: number;
  /** One per record, in the order the records arrived. */
  readonly dispositions: readonly RecordDisposition[];
  /** Retailer partitions this batch touched, in first-appearance order. */
  readonly retailers: readonly RetailerId[];
  readonly deadLettered: number;
  /**
   * Offset to commit through, inclusive, or `null` to commit nothing.
   *
   * Stops at the first record needing a retry. Records after that point were
   * still processed and may already have been ingested; redelivering them is
   * harmless because ingestion is idempotent, whereas committing past a record
   * that was never handled would lose it.
   */
  readonly commitThrough: string | null;
}

export interface DetectionStreamConsumerDependencies {
  readonly stream: EventStreamConsumerPort;
  readonly ingestion: DetectionIngestionPort;
  readonly deadLetters: DeadLetterSinkPort;
  /** The platform clock, injected like everywhere else in this codebase. */
  readonly now: () => Instant;
  /** Defaults to the five shipped source adapters; narrowed in tests. */
  readonly adapters?: readonly AnySourceAdapter[];
}

/** Why a record never became a detection event. */
interface DecodeFailure {
  readonly reason: DeadLetterReason;
  readonly detail: string;
  /** Known once the envelope has been read, so the dead letter stays partitioned. */
  readonly retailerId: RetailerId | null;
}

/** A record and everything learned about it, accumulated across the passes below. */
interface Slot {
  readonly record: StreamRecord;
  readonly event: DetectionEvent | null;
  readonly failure: DecodeFailure | null;
  outcome: IngestionOutcome | null;
}

// `fatal` so invalid UTF-8 is a dead letter rather than a payload silently
// peppered with replacement characters; the lossy decoder exists only to put
// something legible in front of whoever has to debug it.
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });
const LOSSY_UTF8 = new TextDecoder('utf-8');

const asText = (value: Uint8Array | string): string =>
  typeof value === 'string' ? value : STRICT_UTF8.decode(value);

const asLossyText = (value: Uint8Array | string): string =>
  typeof value === 'string' ? value : LOSSY_UTF8.decode(value);

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Restates a rejection as one line an operator can act on. */
const describeRejection = (rejection: IngestionRejection): string => {
  switch (rejection.reason) {
    case 'unsupported_schema_version':
      return `ingestion rejected schema version "${rejection.received}"; supported: ${rejection.supported.join(', ')}`;
    case 'schema_violation':
      return `ingestion rejected ${rejection.field}: ${rejection.detail}`;
    case 'unknown_source':
      return `ingestion does not know source "${rejection.received}"`;
    case 'retailer_not_onboarded':
      return `retailer "${rejection.retailerId}" is not onboarded`;
    case 'cross_retailer_mismatch':
      return `event declares retailer "${rejection.actual}" in the "${rejection.expected}" partition`;
    case 'producer_not_authorised':
      return `producer ${rejection.producer.system}/${rejection.producer.instanceId} is not authorised`;
    case 'unknown_facing':
      return `no facing "${rejection.facingId}" in this partition`;
    case 'observation_outside_retention':
      return `observed at ${rejection.observedAt}, before the retention horizon ${rejection.retainedFrom}`;
    case 'rate_limited':
      return `rate limited; retry after ${rejection.retryAfter}ms`;
    default:
      return assertNever(rejection, 'describeRejection');
  }
};

const deadLetterOf = (
  record: StreamRecord,
  failure: DecodeFailure,
  failedAt: Instant,
): DeadLetter => ({
  topic: record.topic,
  partition: record.partition,
  offset: record.offset,
  key: record.key,
  payload: asLossyText(record.value),
  reason: failure.reason,
  detail: failure.detail,
  retailerId: failure.retailerId,
  failedAt,
});

export class DetectionStreamConsumer {
  private readonly adapters: ReadonlyMap<string, AnySourceAdapter>;

  /** Every topic this consumer subscribes to — one per detection source. */
  readonly topics: readonly string[];

  constructor(private readonly deps: DetectionStreamConsumerDependencies) {
    const adapters = deps.adapters ?? ALL_SOURCE_ADAPTERS;
    this.adapters = new Map(adapters.map((adapter) => [adapter.topic, adapter]));
    this.topics = [...this.adapters.keys()];
  }

  /**
   * Subscribes to every detection topic and consumes until the subscription is
   * closed, acking each batch with the offset it is safe to commit through.
   */
  async start(): Promise<StreamSubscription> {
    return this.deps.stream.subscribe(this.topics, async (batch) => {
      const consumed = await this.consume(batch);
      return { commitThrough: consumed.commitThrough };
    });
  }

  /**
   * Consumes one batch from one topic-partition.
   *
   * Three passes on purpose. Decode everything first, so an ingestion call is
   * never made from a half-read batch; then ingest once per retailer partition,
   * so the single-partition guarantee is structural rather than a comment; then
   * walk the records back in arrival order to report and to work out the commit
   * watermark, which only the original order can tell us.
   */
  async consume(batch: StreamBatch): Promise<ConsumedBatch> {
    const failedAt = this.deps.now();
    const adapter = this.adapters.get(batch.topic);

    if (adapter === undefined) {
      // Only reachable through a pattern subscription or a misconfigured runner,
      // and retrying will never make the topic known — so it is terminal, and the
      // batch commits through rather than blocking the partition forever.
      const failure: DecodeFailure = {
        reason: 'unknown_topic',
        detail: `no detection source adapter is bound to topic "${batch.topic}"`,
        retailerId: null,
      };
      return this.finish(
        batch,
        batch.records.map((record) => ({ record, event: null, failure, outcome: null })),
        failedAt,
      );
    }

    const slots: Slot[] = [];
    const groups = new Map<RetailerId, Slot[]>();

    for (const record of batch.records) {
      const decoded = this.decode(adapter, record);
      const slot: Slot = decoded.ok
        ? { record, event: decoded.value, failure: null, outcome: null }
        : { record, event: null, failure: decoded.error, outcome: null };
      slots.push(slot);

      if (decoded.ok) {
        const partition = decoded.value.envelope.retailerId;
        const group = groups.get(partition);
        if (group === undefined) groups.set(partition, [slot]);
        else group.push(slot);
      }
    }

    for (const [partition, group] of groups) {
      // Single-partition by construction: the grouping key *is* the batch's
      // partition, so there is no path here that pools two retailers' events.
      const detectionBatch: DetectionEventBatch = {
        retailerId: partition,
        // Non-null: a slot only joins a group after decoding succeeded.
        events: group.map((slot) => slot.event as DetectionEvent),
      };
      const outcomes = await this.deps.ingestion.ingestBatch(detectionBatch);

      if (outcomes.length !== group.length) {
        throw new Error(
          `DetectionIngestionPort returned ${outcomes.length} outcomes for ${group.length} events; outcomes are contracted to be positional`,
        );
      }
      group.forEach((slot, position) => {
        slot.outcome = outcomes[position] ?? null;
      });
    }

    return this.finish(batch, slots, failedAt);
  }

  /**
   * Turns a record into a detection event, or into the reason it could not be one.
   *
   * The steps are ordered by how little they assume: bytes, then JSON, then the
   * producer's own version, and only then the field-by-field translation. Reading
   * fields out of a payload whose version we do not recognise would be guessing,
   * and guessing at the boundary is how a renamed field becomes a wrong shelf state.
   */
  private decode(
    adapter: AnySourceAdapter,
    record: StreamRecord,
  ): Result<DetectionEvent, DecodeFailure> {
    const fail = (
      reason: DeadLetterReason,
      detail: string,
      partition: RetailerId | null = null,
    ): Result<DetectionEvent, DecodeFailure> => err({ reason, detail, retailerId: partition });

    let text: string;
    try {
      text = asText(record.value);
    } catch {
      return fail('undecodable_bytes', 'payload bytes are not valid UTF-8');
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch (error: unknown) {
      return fail('malformed_payload', messageOf(error));
    }

    // Checked before the version is looked for, so that "this is not a detection
    // payload at all" reads as a schema violation rather than as an unreadable
    // version — the version reasons are the ones a vendor answers by shipping a
    // migration, and mislabelling this as one would send them after the wrong fix.
    if (!isPlainObject(payload)) {
      const shape = payload === null ? 'null' : Array.isArray(payload) ? 'an array' : typeof payload;
      return fail('schema_violation', `expected a JSON object payload, got ${shape}`);
    }

    let version: string | null;
    try {
      version = adapter.wireVersion(payload);
    } catch (error: unknown) {
      return fail('unsupported_wire_version', this.detailOf(error));
    }
    if (version === null) {
      return fail(
        'unsupported_wire_version',
        `payload carries no version marker; ${adapter.source} accepts ${adapter.supportedWireVersions.join(', ')}`,
      );
    }
    if (!adapter.supportedWireVersions.includes(version)) {
      return fail(
        'unsupported_wire_version',
        `producer version "${version}" is not readable by the ${adapter.source} adapter; accepted: ${adapter.supportedWireVersions.join(', ')}`,
      );
    }

    let event: DetectionEvent;
    try {
      event = adapter.decode(payload, { record });
    } catch (error: unknown) {
      return fail('schema_violation', this.detailOf(error));
    }

    // The broker's partition key and the envelope must agree. The port requires
    // the envelope to carry the partition rather than infer it from the
    // connection; this is the other half of that — a producer that publishes one
    // retailer's event under another's key has a routing bug, and honouring
    // either value over the other would put one retailer's shelf data in the
    // other's partition.
    const key = record.key;
    const envelopePartition = event.envelope.retailerId;
    if (key === null || key.trim() === '') {
      return fail(
        'partition_key_mismatch',
        `record carries no retailer partition key; the envelope declares "${envelopePartition}"`,
        envelopePartition,
      );
    }
    if (!belongsToRetailer(event.envelope, asRetailerId(key))) {
      return fail(
        'partition_key_mismatch',
        `record is keyed "${key}" but the envelope declares retailer "${envelopePartition}"`,
        envelopePartition,
      );
    }

    return ok(event);
  }

  /**
   * A decode failure as one line.
   *
   * `WireViolationError` already carries a field path, which is the message worth
   * forwarding. Anything else thrown in a decoder is almost always a domain
   * constructor refusing a value the wire supplied — `confidence` out of range, a
   * blank identifier — so it is reported the same way rather than escaping: at
   * this boundary an unanticipated value is still the producer's payload, and a
   * consumer that dies on one is a consumer that dies on a typo.
   */
  private detailOf(error: unknown): string {
    return error instanceof WireViolationError ? error.message : messageOf(error);
  }

  /** Builds the report, files the dead letters, and works out the commit watermark. */
  private async finish(
    batch: StreamBatch,
    slots: readonly Slot[],
    failedAt: Instant,
  ): Promise<ConsumedBatch> {
    const letters: DeadLetter[] = [];
    const dispositions: RecordDisposition[] = [];

    for (const slot of slots) {
      if (slot.failure !== null) {
        letters.push(deadLetterOf(slot.record, slot.failure, failedAt));
        dispositions.push({
          offset: slot.record.offset,
          retailerId: slot.failure.retailerId,
          outcome: {
            status: 'dead_lettered',
            reason: slot.failure.reason,
            detail: slot.failure.detail,
          },
        });
        continue;
      }

      // Non-null: a slot without a failure was decoded, and every decoded slot
      // joined a group that was ingested above.
      const event = slot.event as DetectionEvent;
      const outcome = slot.outcome as IngestionOutcome;
      const partition = event.envelope.retailerId;
      const resolved = this.resolve(outcome, slot.record, partition, failedAt);

      if (resolved.letter !== null) letters.push(resolved.letter);
      dispositions.push({
        offset: slot.record.offset,
        retailerId: partition,
        outcome: resolved.outcome,
      });
    }

    // Filed before the ack is computed: a sink that refuses the evidence leaves
    // the batch uncommitted and redelivered rather than losing the record.
    if (letters.length > 0) await this.deps.deadLetters.capture(letters);

    let commitThrough: string | null = null;
    for (const disposition of dispositions) {
      if (disposition.outcome.status === 'retry') break;
      commitThrough = disposition.offset;
    }

    // Only the partitions actually submitted to ingestion. A record rejected for
    // a key mismatch names a retailer too, but it never reached that retailer's
    // partition, and counting it here would overstate what the batch touched.
    const retailers: RetailerId[] = [];
    for (const slot of slots) {
      const partition = slot.event?.envelope.retailerId;
      if (partition !== undefined && !retailers.includes(partition)) retailers.push(partition);
    }

    return {
      topic: batch.topic,
      partition: batch.partition,
      dispositions,
      retailers,
      deadLettered: letters.length,
      commitThrough,
    };
  }

  /**
   * Reads an ingestion outcome as a disposition.
   *
   * The split that matters is inside `rejected`: rate limiting is the only
   * rejection that a later attempt can turn into an acceptance, so it alone holds
   * the commit watermark back. Every other rejection is a fact about the event —
   * an unknown facing, a version ingestion will not take, an unauthorised
   * producer — and retrying it forever would wedge the partition behind one bad
   * message, so it is filed and stepped over.
   */
  private resolve(
    outcome: IngestionOutcome,
    record: StreamRecord,
    partition: RetailerId,
    failedAt: Instant,
  ): { readonly outcome: DispositionOutcome; readonly letter: DeadLetter | null } {
    switch (outcome.status) {
      case 'accepted':
        return { outcome: { status: 'ingested', results: outcome.results }, letter: null };

      case 'duplicate':
        return {
          outcome: { status: 'duplicate', firstAcceptedAt: outcome.firstAcceptedAt },
          letter: null,
        };

      case 'rejected': {
        if (outcome.rejection.reason === 'rate_limited') {
          return {
            outcome: { status: 'retry', retryAfter: outcome.rejection.retryAfter },
            letter: null,
          };
        }
        const detail = describeRejection(outcome.rejection);
        return {
          outcome: { status: 'dead_lettered', reason: 'rejected_by_ingestion', detail },
          letter: deadLetterOf(
            record,
            { reason: 'rejected_by_ingestion', detail, retailerId: partition },
            failedAt,
          ),
        };
      }

      default:
        return assertNever(outcome, 'DetectionStreamConsumer.resolve');
    }
  }
}
