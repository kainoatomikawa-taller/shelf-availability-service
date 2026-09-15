import type {
  CarrotTagId,
  EventId,
  FacingId,
  ProductId,
  RetailerId,
  ShopperId,
  SignalId,
  StoreId,
} from '../../domain/common/ids.js';
import type { RetailerPartitioned } from '../../domain/common/partition.js';
import type { Instant, Millis } from '../../domain/common/time.js';
import type { SignalApplication } from '../../domain/facing/facing.js';
import type { ShelfState } from '../../domain/facing/shelf-state.js';
import type { Confidence, SignalOf, SignalSource } from '../../domain/facing/signals.js';
import type { LedColor } from '../../domain/task/color-lane.js';
import type { SchemaContract, SchemaVersion } from '../common/schema-contract.js';

/**
 * Detection event ingestion — the inbound (driving) boundary of the service.
 *
 * Types and contract constants only: no behaviour lives here. Adapters for each
 * producer implement the translation; this module states what they must produce.
 *
 * **This layer owns the boundary.** The five detection producers adapt to the
 * schema below; the schema does not bend to whatever each producer happens to
 * emit. That is what keeps a change in one vendor's payload from rippling into
 * the domain or into the other four adapters.
 */

/**
 * The five producers that *observe* a shelf.
 *
 * Deliberately not all six `SignalSource`s: `planogram_record` is authored
 * reference data describing what *should* be on the shelf, synchronised on the
 * retailer's merchandising cadence rather than streamed as detections. Deriving
 * this union by exclusion means adding a seventh signal source forces an explicit
 * decision about which side of the boundary it belongs on.
 */
export type DetectionSource = Exclude<SignalSource, 'planogram_record'>;

export const DETECTION_SOURCES = [
  'shopper_scan',
  'arpalus_detection',
  'caper_frame',
  'carrot_tag_label',
  'pos_movement',
] as const satisfies readonly DetectionSource[];

/** Pinned literal; assignability to `SchemaVersion` is enforced by the contract constant below. */
export type DetectionSchemaVersion = '1.0';

export const CURRENT_DETECTION_SCHEMA_VERSION: DetectionSchemaVersion = '1.0';

/**
 * The full versioning contract for this schema, published so a producer can
 * negotiate before it sends anything.
 */
export const DETECTION_SCHEMA_CONTRACT: SchemaContract = {
  schemaName: 'osa.detection-event',
  current: CURRENT_DETECTION_SCHEMA_VERSION,
  supported: [CURRENT_DETECTION_SCHEMA_VERSION],
  sunsets: [],
  encoding: {
    transport: 'json',
    timestamps: 'iso-8601-utc',
    identifiers: 'opaque-utf8-string',
    ratios: 'decimal-0-to-1',
    durations: 'integer-milliseconds',
  },
  unknownFields: 'ignore',
};

/** Which system emitted the event, and the build that produced it. */
export interface DetectionProducer {
  readonly system: DetectionSource;
  /** Camera, cart, register, tag gateway or mobile client that observed the shelf. */
  readonly instanceId: string;
  /** Producer build version, so a bad rollout can be isolated from the event stream. */
  readonly softwareVersion: string;
}

/**
 * Envelope carried by every detection event, whatever the source.
 *
 * Identifiers are typed as their branded domain types: on the wire they are
 * opaque strings, and the adapter validates and brands them as it crosses the
 * boundary. Same for instants, which are ISO-8601 on the wire and epoch millis
 * once inside.
 */
export interface DetectionEventEnvelope extends RetailerPartitioned {
  readonly schemaVersion: DetectionSchemaVersion;
  /** Producer-assigned, unique within the producer. */
  readonly eventId: string;
  /**
   * Dedupe key. Redelivery is normal at this boundary, so ingestion is required
   * to be idempotent on this key rather than on arrival order.
   */
  readonly idempotencyKey: string;
  /** Partition key. Required on the wire — never inferred from the connection. */
  readonly retailerId: RetailerId;
  readonly storeId: StoreId;
  readonly producer: DetectionProducer;
  /** When the shelf was observed. This is what orders the facing history. */
  readonly occurredAt: Instant;
  /** When the producer emitted the event. Used for latency reporting only. */
  readonly producedAt: Instant;
  /** Ties an event to the upstream batch or trip that generated it. */
  readonly correlationId: string | null;
}

/** A shopper looking for the item while picking an order. */
export interface ShopperScanObservation {
  readonly facingId: FacingId;
  readonly confidence: Confidence;
  readonly shopperId: ShopperId;
  readonly productId: ProductId;
  readonly outcome: 'found' | 'not_found' | 'substituted';
}

/** One facing's slice of an Arpalus shelf-vision run. */
export interface ArpalusDetectionObservation {
  readonly facingId: FacingId;
  readonly confidence: Confidence;
  readonly productId: ProductId;
  readonly detectedFacings: number;
  readonly expectedFacings: number;
  readonly voidRatio: Confidence;
}

/** One facing's slice of a Caper smart-cart frame. */
export interface CaperFrameObservation {
  readonly facingId: FacingId;
  readonly confidence: Confidence;
  readonly productId: ProductId;
  readonly productVisible: boolean;
  readonly gapWidthCm: number;
}

/** Carrot Tags electronic label health and the lane its LED is currently driving. */
export interface CarrotTagLabelObservation {
  readonly facingId: FacingId;
  readonly confidence: Confidence;
  readonly tagId: CarrotTagId;
  readonly labelState: 'nominal' | 'price_mismatch' | 'unbound' | 'battery_low' | 'offline';
  readonly displayedPriceCents: number;
  readonly litLane: LedColor | null;
}

/** POS sell-through for one facing over the event's window. */
export interface PosMovementObservation {
  readonly facingId: FacingId;
  readonly confidence: Confidence;
  readonly productId: ProductId;
  readonly unitsSold: number;
  readonly expectedUnitsSold: number;
  readonly windowMillis: Millis;
}

/** Maps a detection source to the observation shape its producer must emit. */
export interface DetectionObservationBySource {
  readonly shopper_scan: ShopperScanObservation;
  readonly arpalus_detection: ArpalusDetectionObservation;
  readonly caper_frame: CaperFrameObservation;
  readonly carrot_tag_label: CarrotTagLabelObservation;
  readonly pos_movement: PosMovementObservation;
}

export type DetectionObservationOf<S extends DetectionSource> = DetectionObservationBySource[S];

/**
 * One detection event: an envelope plus the facings it observed.
 *
 * A single capture — one Arpalus pass, one Caper frame — routinely covers a whole
 * bay, so the event carries many observations sharing the envelope's
 * `occurredAt`. A producer that observes one facing sends an array of one.
 */
export interface DetectionEventOf<S extends DetectionSource> {
  readonly envelope: DetectionEventEnvelope;
  readonly source: S;
  readonly observations: readonly DetectionObservationOf<S>[];
}

export type DetectionEvent =
  | DetectionEventOf<'shopper_scan'>
  | DetectionEventOf<'arpalus_detection'>
  | DetectionEventOf<'caper_frame'>
  | DetectionEventOf<'carrot_tag_label'>
  | DetectionEventOf<'pos_movement'>;

/**
 * Compile-time proof that each wire observation carries everything its domain
 * signal needs, beyond what the envelope supplies.
 *
 * The wire schema is written out explicitly rather than derived from the domain,
 * because a published contract must not shift whenever an internal type is
 * refactored. These aliases give us the other half of that bargain: if the domain
 * gains a required field the wire cannot supply, the build fails here and the
 * drift becomes an explicit version decision instead of a runtime surprise.
 */
type FieldsRequiredBySignal<S extends DetectionSource> = Omit<
  SignalOf<S>,
  'signalId' | 'retailerId' | 'storeId' | 'source' | 'observedAt' | 'receivedAt'
>;

type Conforms<Wire extends Domain, Domain> = Wire;

export type ShopperScanObservationConformance = Conforms<
  ShopperScanObservation,
  FieldsRequiredBySignal<'shopper_scan'>
>;
export type ArpalusObservationConformance = Conforms<
  ArpalusDetectionObservation,
  FieldsRequiredBySignal<'arpalus_detection'>
>;
export type CaperObservationConformance = Conforms<
  CaperFrameObservation,
  FieldsRequiredBySignal<'caper_frame'>
>;
export type CarrotTagObservationConformance = Conforms<
  CarrotTagLabelObservation,
  FieldsRequiredBySignal<'carrot_tag_label'>
>;
export type PosMovementObservationConformance = Conforms<
  PosMovementObservation,
  FieldsRequiredBySignal<'pos_movement'>
>;

/** What ingestion did with one observation, per the domain's own vocabulary. */
export interface ObservationResult {
  readonly facingId: FacingId;
  readonly signalId: SignalId;
  /** Mirrors `SignalApplication` so the boundary cannot drift from the aggregate. */
  readonly application: SignalApplication['outcome'];
  readonly resultingState: ShelfState;
  /** The transition appended to the facing history, when the signal caused one. */
  readonly emittedEventId: EventId | null;
}

export type IngestionRejection =
  | {
      readonly reason: 'unsupported_schema_version';
      readonly received: string;
      readonly supported: readonly SchemaVersion[];
    }
  | { readonly reason: 'schema_violation'; readonly field: string; readonly detail: string }
  | { readonly reason: 'unknown_source'; readonly received: string }
  | { readonly reason: 'retailer_not_onboarded'; readonly retailerId: RetailerId }
  /** The envelope's partition disagrees with the authenticated producer's. */
  | {
      readonly reason: 'cross_retailer_mismatch';
      readonly expected: RetailerId;
      readonly actual: RetailerId;
    }
  | { readonly reason: 'producer_not_authorised'; readonly producer: DetectionProducer }
  | { readonly reason: 'unknown_facing'; readonly facingId: FacingId }
  /** Older than the retention horizon, so it can no longer be placed in a history. */
  | {
      readonly reason: 'observation_outside_retention';
      readonly observedAt: Instant;
      readonly retainedFrom: Instant;
    }
  | { readonly reason: 'rate_limited'; readonly retryAfter: Millis };

export type IngestionOutcome =
  | {
      readonly status: 'accepted';
      readonly acceptedAt: Instant;
      /** One entry per observation, in the order they were submitted. */
      readonly results: readonly ObservationResult[];
    }
  /** Already ingested under this idempotency key; the original result stands. */
  | {
      readonly status: 'duplicate';
      readonly idempotencyKey: string;
      readonly firstAcceptedAt: Instant;
    }
  | { readonly status: 'rejected'; readonly rejection: IngestionRejection };

/**
 * A batch confined to one retailer partition.
 *
 * Single-partition by construction: the no-cross-retailer-pooling rule the domain
 * enforces internally is enforced at the boundary too, so a mixed batch cannot be
 * assembled in the first place.
 */
export interface DetectionEventBatch extends RetailerPartitioned {
  readonly retailerId: RetailerId;
  readonly events: readonly DetectionEvent[];
}

/**
 * Inbound port every detection producer's adapter drives.
 *
 * Implementations must be idempotent on `envelope.idempotencyKey` and must not
 * assume arrival order: `occurredAt` orders the facing history, and a late
 * arrival is resolved by the aggregate, not by the transport.
 */
export interface DetectionIngestionPort {
  /** Ingests a single detection event. */
  ingest(event: DetectionEvent): Promise<IngestionOutcome>;

  /**
   * Ingests a batch. Outcomes are positional: one per submitted event, in order.
   * Events are accepted or rejected individually — one bad event does not fail
   * the batch, or a single malformed frame would stall a whole store's stream.
   */
  ingestBatch(batch: DetectionEventBatch): Promise<readonly IngestionOutcome[]>;

  /** The versioning contract, for producers to negotiate against before sending. */
  describeSchemaContract(): Promise<SchemaContract>;
}
