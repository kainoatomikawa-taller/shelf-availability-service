import { assertNever } from '../domain/common/exhaustive.js';
import type { SignalId } from '../domain/common/ids.js';
import type { Instant } from '../domain/common/time.js';
import type { Signal } from '../domain/facing/signals.js';
import type { FacingPass } from '../domain/merchandising/revisit-density.js';
import type {
  DetectionEvent,
  DetectionEventEnvelope,
  DetectionSource,
} from '../ports/inbound/detection-ingestion.port.js';

/**
 * Wire detection events to domain signals.
 *
 * The one place the published schema and the internal model are allowed to know
 * about each other. Both sides are written out independently on purpose — the
 * contract must not shift when a domain type is refactored — and this translation
 * is the seam where that independence is paid for. Keeping it in a single
 * exhaustive switch means a sixth detection source is a compile error here rather
 * than a field that quietly never arrives.
 */

export interface NormalizationContext {
  /**
   * Mints the domain id for one observation's signal.
   *
   * Injected rather than generated, and derived from the envelope by every real
   * adapter, so that replaying the same event produces the same signal ids and a
   * redelivery cannot fork the history.
   */
  readonly nextSignalId: (
    envelope: DetectionEventEnvelope,
    source: DetectionSource,
    index: number,
  ) => SignalId;
  /** When the platform took delivery. Latency and audit only — never orders history. */
  readonly receivedAt: Instant;
}

/**
 * Fields every signal takes from the envelope rather than the observation.
 *
 * `observedAt` comes from the envelope's `occurredAt`: a single Arpalus pass or
 * Caper frame covers a whole bay, and every facing in it was seen at the same
 * instant. Per-observation timestamps would invite producers to claim sub-frame
 * precision they do not have.
 */
const envelopeFields = (
  envelope: DetectionEventEnvelope,
  source: DetectionSource,
  index: number,
  context: NormalizationContext,
) =>
  ({
    signalId: context.nextSignalId(envelope, source, index),
    retailerId: envelope.retailerId,
    storeId: envelope.storeId,
    observedAt: envelope.occurredAt,
    receivedAt: context.receivedAt,
  }) as const;

/**
 * Normalizes a whole detection event into domain signals, preserving the order
 * its observations were submitted in — ingestion reports results positionally,
 * and a producer matching them back up by index must get its own ordering.
 *
 * The switch is over the event rather than a bare source string so that each
 * branch narrows the observations to the shape that source is contracted to send:
 * the mapping cannot read a field the wire never promised.
 */
export function normalizeDetectionEvent(
  event: DetectionEvent,
  context: NormalizationContext,
): readonly Signal[] {
  const { envelope } = event;
  const base = (index: number) => envelopeFields(envelope, event.source, index, context);

  switch (event.source) {
    case 'shopper_scan':
      return event.observations.map((observation, index) => ({
        ...base(index),
        source: 'shopper_scan',
        facingId: observation.facingId,
        confidence: observation.confidence,
        shopperId: observation.shopperId,
        productId: observation.productId,
        outcome: observation.outcome,
      }));

    case 'arpalus_detection':
      return event.observations.map((observation, index) => ({
        ...base(index),
        source: 'arpalus_detection',
        facingId: observation.facingId,
        confidence: observation.confidence,
        productId: observation.productId,
        detectedFacings: observation.detectedFacings,
        expectedFacings: observation.expectedFacings,
        voidRatio: observation.voidRatio,
      }));

    case 'caper_frame':
      return event.observations.map((observation, index) => ({
        ...base(index),
        source: 'caper_frame',
        facingId: observation.facingId,
        confidence: observation.confidence,
        productId: observation.productId,
        productVisible: observation.productVisible,
        gapWidthCm: observation.gapWidthCm,
      }));

    case 'carrot_tag_label':
      return event.observations.map((observation, index) => ({
        ...base(index),
        source: 'carrot_tag_label',
        facingId: observation.facingId,
        confidence: observation.confidence,
        tagId: observation.tagId,
        labelState: observation.labelState,
        displayedPriceCents: observation.displayedPriceCents,
        litLane: observation.litLane,
      }));

    case 'pos_movement':
      return event.observations.map((observation, index) => ({
        ...base(index),
        source: 'pos_movement',
        facingId: observation.facingId,
        confidence: observation.confidence,
        productId: observation.productId,
        unitsSold: observation.unitsSold,
        expectedUnitsSold: observation.expectedUnitsSold,
        windowMillis: observation.windowMillis,
      }));

    default:
      return assertNever(event, 'normalizeDetectionEvent');
  }
}

/**
 * The passes a detection event represents, for revisit-density measurement.
 *
 * A pass is a look at a facing, whatever it concluded, so every observation in
 * the event counts as one. Density is measured from the same events that feed the
 * facing model — it is a property of the traffic we actually received, never a
 * number configured beside it.
 */
export const passesFromDetectionEvent = (event: DetectionEvent): readonly FacingPass[] =>
  event.observations.map((observation) => ({
    retailerId: event.envelope.retailerId,
    storeId: event.envelope.storeId,
    facingId: observation.facingId,
    at: event.envelope.occurredAt,
    source: event.source,
  }));
