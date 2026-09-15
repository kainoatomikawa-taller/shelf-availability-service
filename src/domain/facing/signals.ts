import type { Brand } from '../common/brand.js';
import type {
  CarrotTagId,
  FacingId,
  ProductId,
  RetailerId,
  ShopperId,
  SignalId,
  StoreId,
} from '../common/ids.js';
import type { RetailerPartitioned } from '../common/partition.js';
import type { Instant, Millis } from '../common/time.js';
import type { LedColor } from '../task/color-lane.js';

/**
 * The six upstream signal families the service closes the loop over. Adding a
 * seventh is intentionally a type-level breaking change: `SignalSnapshot`,
 * `interpretSignal` and the lane/audit surfaces all fan out from this union.
 */
export type SignalSource =
  | 'shopper_scan'
  | 'arpalus_detection'
  | 'caper_frame'
  | 'planogram_record'
  | 'carrot_tag_label'
  | 'pos_movement';

export const SIGNAL_SOURCES = [
  'shopper_scan',
  'arpalus_detection',
  'caper_frame',
  'planogram_record',
  'carrot_tag_label',
  'pos_movement',
] as const satisfies readonly SignalSource[];

/** Detector/observer confidence, constrained to [0, 1]. */
export type Confidence = Brand<number, 'Confidence'>;

export const confidence = (value: number): Confidence => {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`Confidence must be within [0, 1], got ${value}`);
  }
  return value as Confidence;
};

export const CERTAIN: Confidence = confidence(1);

interface SignalEnvelope<S extends SignalSource> extends RetailerPartitioned {
  readonly signalId: SignalId;
  /** Partition key — first-class on the signal itself, not inherited from a lookup. */
  readonly retailerId: RetailerId;
  readonly storeId: StoreId;
  readonly facingId: FacingId;
  readonly source: S;
  /** When the world was observed. Ordering of the facing history uses this, never receivedAt. */
  readonly observedAt: Instant;
  /** When the platform received it. Kept for latency/audit reporting only. */
  readonly receivedAt: Instant;
  readonly confidence: Confidence;
}

/** An Instacart shopper physically looking for the item while picking an order. */
export interface ShopperScanSignal extends SignalEnvelope<'shopper_scan'> {
  readonly shopperId: ShopperId;
  readonly productId: ProductId;
  /** `not_found` and `substituted` are the strongest out-of-stock evidence the service receives. */
  readonly outcome: 'found' | 'not_found' | 'substituted';
}

/** Arpalus shelf-vision run over a store pass: void space vs. expected facings. */
export interface ArpalusDetectionSignal extends SignalEnvelope<'arpalus_detection'> {
  readonly productId: ProductId;
  readonly detectedFacings: number;
  readonly expectedFacings: number;
  /** Fraction of the facing's linear space detected as void. */
  readonly voidRatio: Confidence;
}

/** A frame from a Caper smart cart passing the bay. */
export interface CaperFrameSignal extends SignalEnvelope<'caper_frame'> {
  readonly productId: ProductId;
  readonly productVisible: boolean;
  readonly gapWidthCm: number;
}

/** The authored shelf plan: what *should* be here, and whether it is still carried. */
export interface PlanogramRecordSignal extends SignalEnvelope<'planogram_record'> {
  readonly planogramVersion: string;
  readonly expectedProductId: ProductId;
  readonly expectedFacings: number;
  readonly assortmentStatus: 'active' | 'discontinued' | 'seasonal_out';
}

/** Carrot Tags electronic label health and the lane its LED is currently driving. */
export interface CarrotTagLabelSignal extends SignalEnvelope<'carrot_tag_label'> {
  readonly tagId: CarrotTagId;
  readonly labelState: 'nominal' | 'price_mismatch' | 'unbound' | 'battery_low' | 'offline';
  readonly displayedPriceCents: number;
  /** Lane the tag is lit for right now, or `null` when dark. */
  readonly litLane: LedColor | null;
}

/** POS sell-through over a window — the classic phantom-inventory detector. */
export interface PosMovementSignal extends SignalEnvelope<'pos_movement'> {
  readonly productId: ProductId;
  readonly unitsSold: number;
  /** Forecast units for the same window; a live facing selling nothing is suspicious. */
  readonly expectedUnitsSold: number;
  readonly windowMillis: Millis;
}

export type Signal =
  | ShopperScanSignal
  | ArpalusDetectionSignal
  | CaperFrameSignal
  | PlanogramRecordSignal
  | CarrotTagLabelSignal
  | PosMovementSignal;

/** Maps a source discriminant back to its concrete signal type. */
export type SignalOf<S extends SignalSource> = Extract<Signal, { source: S }>;

/**
 * Latest observation per source, held on the facing. The mapped type over
 * `SignalSource` is what makes the facing "aggregate all six sources into one
 * addressable object" enforceable: a new source cannot be added without every
 * facing gaining a slot for it.
 */
export type SignalSnapshot = {
  readonly [S in SignalSource]: SignalOf<S> | null;
};

export const emptySignalSnapshot = (): SignalSnapshot => ({
  shopper_scan: null,
  arpalus_detection: null,
  caper_frame: null,
  planogram_record: null,
  carrot_tag_label: null,
  pos_movement: null,
});
