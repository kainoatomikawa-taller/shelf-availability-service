import type { RetailerId, StoreId } from '../../../domain/common/ids.js';
import type { Instant } from '../../../domain/common/time.js';
import {
  CURRENT_DETECTION_SCHEMA_VERSION,
  type DetectionEventEnvelope,
  type DetectionEventOf,
  type DetectionSource,
} from '../../../ports/inbound/detection-ingestion.port.js';
import type { StreamRecord } from '../../../ports/outbound/event-stream.port.js';

/**
 * What one detection producer's adapter has to provide.
 *
 * One of these per source, and the translation is entirely one-way: the producer
 * keeps its own field names, units, enum spellings and versioning scheme, and the
 * adapter absorbs the difference. Nothing upstream is asked to change, which is
 * the whole point of owning the boundary — five vendors on five release cadences
 * cannot be made to land a schema change together.
 */

export interface DecodeContext {
  /**
   * The record the payload arrived in. Producers that publish no emit timestamp
   * fall back to the broker's append time, which is the closest honest answer
   * available and is only ever used for latency reporting.
   */
  readonly record: StreamRecord;
}

export interface SourceAdapter<S extends DetectionSource> {
  readonly source: S;
  // No topic here on purpose. Detection topics are per retailer as well as per
  // source, so one producer's adapter reads as many topics as there are pilots,
  // and naming one would be naming whichever tenant was onboarded first. The
  // topic-to-adapter binding is a deployment fact, carried in the consumer's
  // `DetectionSubscription`s.
  /** The producer's *own* payload versions this adapter knows how to read. */
  readonly supportedWireVersions: readonly string[];
  /**
   * Reads the producer's own version marker, normalised to a comparable string.
   *
   * Each vendor marks versions differently — a `schema` URN, a numeric `version`
   * beside an event type, a protocol string on the gateway — so recognising the
   * marker is part of the adapter rather than something the consumer can do
   * generically. `null` means the payload carries no marker at all, which is
   * treated the same as an unreadable one: we will not guess at a shape.
   */
  wireVersion(payload: unknown): string | null;
  /** Translates a payload of a supported version. Throws `WireViolationError` otherwise. */
  decode(payload: unknown, context: DecodeContext): DetectionEventOf<S>;
}

/**
 * A source adapter with its type parameter erased to the union of the five.
 *
 * A `SourceAdapter<DetectionSource>` would be wrong — it would describe an
 * adapter whose observations may mix sources — so the registry holds the union of
 * the five concrete adapters instead, and `decode` returns the `DetectionEvent`
 * union rather than a widened event.
 */
export type AnySourceAdapter = {
  readonly [S in DetectionSource]: SourceAdapter<S>;
}[DetectionSource];

/** Everything an adapter has to establish before an envelope can be minted. */
export interface EnvelopeDraft {
  readonly source: DetectionSource;
  /** The producer's own id for this event, whatever it calls it. */
  readonly producerEventId: string;
  readonly retailerId: RetailerId;
  readonly storeId: StoreId;
  /** Camera, cart, register, gateway or mobile client. */
  readonly instanceId: string;
  readonly softwareVersion: string;
  readonly occurredAt: Instant;
  readonly producedAt: Instant;
  readonly correlationId: string | null;
}

/**
 * Builds the layer-owned envelope from what an adapter managed to establish.
 *
 * `schemaVersion` is always the current layer-owned version, never the producer's:
 * the producer's version was consumed upstream by `wireVersion`, and what leaves
 * the adapter is our schema regardless of which vendor dialect went in.
 *
 * The idempotency key is namespaced by source. Producer ids are only unique within
 * a producer, the ledger's key space is per retailer, and two vendors both minting
 * `batch-1` for one retailer would otherwise have the second event silently
 * swallowed as a duplicate of the first.
 */
export const envelopeFrom = (draft: EnvelopeDraft): DetectionEventEnvelope => ({
  schemaVersion: CURRENT_DETECTION_SCHEMA_VERSION,
  eventId: draft.producerEventId,
  idempotencyKey: `${draft.source}:${draft.producerEventId}`,
  retailerId: draft.retailerId,
  storeId: draft.storeId,
  producer: {
    system: draft.source,
    instanceId: draft.instanceId,
    softwareVersion: draft.softwareVersion,
  },
  occurredAt: draft.occurredAt,
  producedAt: draft.producedAt,
  correlationId: draft.correlationId,
});
