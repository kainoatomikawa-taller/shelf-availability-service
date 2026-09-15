import { assertNever } from '../common/exhaustive.js';
import type {
  CarrotTagId,
  FacingId,
  GapId,
  ProductId,
  RetailerId,
  StoreId,
} from '../common/ids.js';
import type { RetailerPartitioned } from '../common/partition.js';
import type { Instant } from '../common/time.js';
import type { Facing } from '../facing/facing.js';
import type { SignalSource } from '../facing/signals.js';
import type { MerchandisingClassification } from '../merchandising/classification.js';
import type { TaskType } from '../task/task-type.js';

/**
 * The three things the closed loop finds wrong at a facing.
 *
 * They are one union rather than three parallel pipelines because they compete
 * for the same scarce resource — an employee's next ten minutes — and a ranking
 * that cannot compare a hot-selling void against a mispriced tag just pushes the
 * comparison onto whoever reads the list.
 */
export type GapKind = 'availability_gap' | 'price_mismatch' | 'planogram_drift';

export const GAP_KINDS = [
  'availability_gap',
  'price_mismatch',
  'planogram_drift',
] as const satisfies readonly GapKind[];

/** What the shelf is doing wrong, carried with the evidence that says so. */
export type GapDetail =
  | {
      readonly kind: 'availability_gap';
      /** When the facing entered `out_of_stock` — the gap's age, not its detection time. */
      readonly since: Instant;
      /** The signal that called the void. `null` only for a facing opened straight into the state. */
      readonly source: SignalSource | null;
    }
  | {
      readonly kind: 'price_mismatch';
      readonly tagId: CarrotTagId;
      readonly displayedPriceCents: number;
    }
  | {
      readonly kind: 'planogram_drift';
      /** `wrong_product`: the slot holds a SKU the plan does not put here. */
      /** `under_faced`: the right SKU, fewer facings than the plan calls for. */
      readonly drift: 'wrong_product' | 'under_faced';
      readonly planogramVersion: string;
      readonly expectedProductId: ProductId;
      readonly expectedFacings: number;
      /** `null` when no vision run has counted the slot yet. */
      readonly detectedFacings: number | null;
    };

export interface DetectedGap extends RetailerPartitioned {
  readonly gapId: GapId;
  /** Partition key. A gap is always *a retailer's* gap. */
  readonly retailerId: RetailerId;
  readonly storeId: StoreId;
  readonly facingId: FacingId;
  readonly productId: ProductId;
  /** Resolved alongside the facing — see `MerchandisingClassification`. */
  readonly classification: MerchandisingClassification;
  readonly detectedAt: Instant;
  readonly detail: GapDetail;
}

export const gapKindOf = (gap: DetectedGap): GapKind => gap.detail.kind;

/** The work a gap of this kind dispatches. Total, so a new kind cannot go unlit. */
export function taskTypeForGap(kind: GapKind): TaskType {
  switch (kind) {
    case 'availability_gap':
      return 'restock_out_of_stock';
    case 'price_mismatch':
      return 'price_label_correction';
    case 'planogram_drift':
      return 'planogram_correction';
    default:
      return assertNever(kind, 'taskTypeForGap');
  }
}

export interface DetectGapsInput {
  readonly facing: Facing;
  readonly classification: MerchandisingClassification;
  /** Evaluation instant — when this read of the facing was taken. */
  readonly at: Instant;
  /** Supplies gap identity. Injected so the domain stays free of clocks and uuids. */
  readonly nextGapId: (facing: Facing, kind: GapKind) => GapId;
}

/**
 * Reads the current gaps off a facing.
 *
 * Pure projection of the aggregate as it stands: the facing's state supplies the
 * availability gap, the Carrot Tag slot the price mismatch, and the planogram
 * slot compared against the vision slot the drift. Nothing here re-interprets
 * signals — `recordSignal` has already done that — so a gap can never disagree
 * with the history it was read from.
 *
 * A facing can carry more than one gap at once; an empty slot with a stale price
 * is two pieces of work, in two lanes, and collapsing them would lose one.
 */
export function detectGaps(input: DetectGapsInput): readonly DetectedGap[] {
  const { facing, classification, at, nextGapId } = input;

  const base = {
    retailerId: facing.retailerId,
    storeId: facing.storeId,
    facingId: facing.facingId,
    productId: facing.productId,
    classification,
    detectedAt: at,
  } as const;

  const gaps: DetectedGap[] = [];

  if (facing.state === 'out_of_stock') {
    const cause = facing.history.events.at(-1)?.cause.source ?? null;
    gaps.push({
      ...base,
      gapId: nextGapId(facing, 'availability_gap'),
      // A facing reaches out_of_stock through a transition, so the last event is
      // its cause — except for one opened directly into the state, which has no
      // signal behind it and says so rather than borrowing one.
      detail: { kind: 'availability_gap', since: facing.stateSince, source: cause },
    });
  }

  const tag = facing.signals.carrot_tag_label;
  if (tag !== null && tag.labelState === 'price_mismatch') {
    gaps.push({
      ...base,
      gapId: nextGapId(facing, 'price_mismatch'),
      detail: {
        kind: 'price_mismatch',
        tagId: tag.tagId,
        displayedPriceCents: tag.displayedPriceCents,
      },
    });
  }

  const plan = facing.signals.planogram_record;
  // A delisted or seasonally-out facing is *supposed* to look wrong. Raising
  // drift against a plan that no longer carries the product would dispatch an
  // employee to restore a SKU the retailer deliberately walked away from.
  if (plan !== null && plan.assortmentStatus === 'active') {
    const detected = facing.signals.arpalus_detection;
    const detectedFacings = detected?.detectedFacings ?? null;

    if (plan.expectedProductId !== facing.productId) {
      gaps.push({
        ...base,
        gapId: nextGapId(facing, 'planogram_drift'),
        detail: {
          kind: 'planogram_drift',
          drift: 'wrong_product',
          planogramVersion: plan.planogramVersion,
          expectedProductId: plan.expectedProductId,
          expectedFacings: plan.expectedFacings,
          detectedFacings,
        },
      });
    } else if (detectedFacings !== null && detectedFacings < plan.expectedFacings) {
      gaps.push({
        ...base,
        gapId: nextGapId(facing, 'planogram_drift'),
        detail: {
          kind: 'planogram_drift',
          drift: 'under_faced',
          planogramVersion: plan.planogramVersion,
          expectedProductId: plan.expectedProductId,
          expectedFacings: plan.expectedFacings,
          detectedFacings,
        },
      });
    }
  }

  return gaps;
}
