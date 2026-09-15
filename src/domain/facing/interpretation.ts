import { assertNever } from '../common/exhaustive.js';
import type { Instant } from '../common/time.js';
import type { ShelfState } from './shelf-state.js';
import { confidence, type Confidence, type Signal, type SignalSource } from './signals.js';

/**
 * Evidence a single signal contributes about the shelf.
 *
 * Not every signal speaks to stock: a planogram record states intent and a
 * Carrot Tag reports label health. Those return `no_stock_evidence` rather than
 * being coerced into a state, so the facing keeps them in its snapshot without
 * letting them move the timeline.
 */
export type ShelfEvidence =
  | {
      readonly kind: 'observation';
      readonly state: ShelfState;
      readonly at: Instant;
      readonly source: SignalSource;
      readonly confidence: Confidence;
    }
  | { readonly kind: 'no_stock_evidence'; readonly source: SignalSource; readonly reason: string };

/**
 * Thresholds that turn raw detector output into a stock call.
 *
 * Retailer-tunable by design — shelf depth, camera placement and forecast quality
 * differ per banner — but defaulted so the domain is usable without config.
 */
export interface InterpretationPolicy {
  /** Void ratio at or above which an Arpalus detection reads as out-of-stock. */
  readonly arpalusVoidRatioThreshold: Confidence;
  /** Minimum detector confidence before a vision signal is allowed to move the state. */
  readonly minVisionConfidence: Confidence;
  /** Gap (cm) at or above which a Caper frame without a visible product reads as a void. */
  readonly caperGapWidthCm: number;
  /** Sell-through ratio at or below which POS movement reads as phantom inventory. */
  readonly posPhantomSellThroughRatio: number;
  /** Minimum forecast units in the window before POS movement is trusted at all. */
  readonly posMinExpectedUnits: number;
}

export const STANDARD_INTERPRETATION_POLICY: InterpretationPolicy = {
  arpalusVoidRatioThreshold: confidence(0.7),
  minVisionConfidence: confidence(0.6),
  caperGapWidthCm: 12,
  posPhantomSellThroughRatio: 0.1,
  posMinExpectedUnits: 3,
};

const observation = (
  state: ShelfState,
  signal: Signal,
): Extract<ShelfEvidence, { kind: 'observation' }> => ({
  kind: 'observation',
  state,
  at: signal.observedAt,
  source: signal.source,
  confidence: signal.confidence,
});

const noEvidence = (signal: Signal, reason: string): ShelfEvidence => ({
  kind: 'no_stock_evidence',
  source: signal.source,
  reason,
});

/**
 * Pure signal -> shelf evidence reduction. No IO, no clock, no retailer lookup:
 * the policy is passed in so the same function serves ingestion, replay and
 * back-testing identically.
 */
export function interpretSignal(
  signal: Signal,
  policy: InterpretationPolicy = STANDARD_INTERPRETATION_POLICY,
): ShelfEvidence {
  switch (signal.source) {
    case 'shopper_scan':
      // A human stood at the shelf; treated as high-trust regardless of confidence.
      return signal.outcome === 'found'
        ? observation('in_stock', signal)
        : observation('out_of_stock', signal);

    case 'arpalus_detection': {
      if (signal.confidence < policy.minVisionConfidence) {
        return noEvidence(signal, 'detection confidence below vision threshold');
      }
      const voided =
        signal.voidRatio >= policy.arpalusVoidRatioThreshold || signal.detectedFacings === 0;
      return observation(voided ? 'out_of_stock' : 'in_stock', signal);
    }

    case 'caper_frame': {
      if (signal.confidence < policy.minVisionConfidence) {
        return noEvidence(signal, 'frame confidence below vision threshold');
      }
      if (signal.productVisible) {
        return observation('in_stock', signal);
      }
      return signal.gapWidthCm >= policy.caperGapWidthCm
        ? observation('out_of_stock', signal)
        : noEvidence(signal, 'product not visible but gap too narrow to call a void');
    }

    case 'planogram_record':
      // Intent, not observation. A delisted product is the one exception: the
      // facing is legitimately empty and must not accrue out-of-stock time.
      return signal.assortmentStatus === 'active'
        ? noEvidence(signal, 'planogram states expected assortment, not observed stock')
        : observation('unknown', signal);

    case 'carrot_tag_label':
      // Label health drives tasks (price/tag lanes), never the stock timeline.
      return noEvidence(signal, 'label state is not evidence of shelf stock');

    case 'pos_movement': {
      if (signal.expectedUnitsSold < policy.posMinExpectedUnits) {
        return noEvidence(signal, 'forecast too small to infer stock from sell-through');
      }
      const sellThrough = signal.unitsSold / signal.expectedUnitsSold;
      return sellThrough <= policy.posPhantomSellThroughRatio
        ? observation('out_of_stock', signal)
        : observation('in_stock', signal);
    }

    default:
      return assertNever(signal, 'interpretSignal');
  }
}
