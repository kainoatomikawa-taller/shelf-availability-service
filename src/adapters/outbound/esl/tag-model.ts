import type { Millis } from '../../../domain/common/time.js';
import type { LedColor } from '../../../domain/task/color-lane.js';
import type {
  EslExpressionMode,
  EslFlashPattern,
} from '../../../ports/outbound/esl-actuation.port.js';

/**
 * The ESL fleets this service can drive.
 *
 * Five vendors, five wire dialects, and — the part that actually matters — five
 * different answers to "can this tag show a coloured, flashing lane?". The union
 * is closed so the registry can be checked by the compiler rather than by memory.
 */
export type EslVendor = 'vusion' | 'aperion' | 'solum' | 'pricer' | 'hashow';

export const ESL_VENDORS = [
  'vusion',
  'aperion',
  'solum',
  'pricer',
  'hashow',
] as const satisfies readonly EslVendor[];

/**
 * What one *tag model* can express — not what the fleet can.
 *
 * Capability lives at the model rather than at the store because a store mid-way
 * through a hardware refresh runs two generations at once, and the fleet-level
 * answer ("we support pick-to-light") is true of the new tags and a lie about the
 * old ones. Every expression is therefore planned against the model of the tag
 * actually bound to the facing, and the store-level `EslFleetCapabilities` is a
 * union reported for planning, not the thing degradation is decided from.
 */
export interface EslTagModel {
  /** The vendor's own spelling of the model code, as the gateway reports it. */
  readonly modelCode: string;
  readonly modes: readonly EslExpressionMode[];
  /** Lane colours the hardware can actually render. Empty for mono and e-paper tags. */
  readonly colours: readonly LedColor[];
  readonly flashPatterns: readonly EslFlashPattern[];
  /** `null` when the tag has no text area the service may write to. */
  readonly maxBadgeCharacters: number | null;
  /** Minimum interval between two *different* commands to one tag of this model. */
  readonly minCommandIntervalMillis: Millis;
}

export const modelSupports = (model: EslTagModel, mode: EslExpressionMode): boolean =>
  model.modes.includes(mode);

/** Union of what a set of deployed models can express, for the fleet-level answer. */
export interface FleetModelUnion {
  readonly supportedModes: readonly EslExpressionMode[];
  readonly renderableColours: readonly LedColor[];
  readonly supportedFlashPatterns: readonly EslFlashPattern[];
  readonly maxBadgeCharacters: number | null;
  readonly minCommandIntervalMillis: Millis;
}

const distinct = <T>(values: readonly T[]): readonly T[] => [...new Set(values)];

/**
 * Folds the models deployed in one store into a single capability declaration.
 *
 * Modes, colours and flash patterns are unioned — some tag in the building can do
 * it — while the badge width and the command interval are taken at their most
 * restrictive. The asymmetry is deliberate: the caller uses the union to decide
 * what is worth *asking* for, and anything it sends has to be safe for the worst
 * tag it might land on, because the caller does not know which tag that is.
 */
export function unionOfModels(models: readonly EslTagModel[]): FleetModelUnion {
  const badgeWidths = models
    .map((model) => model.maxBadgeCharacters)
    .filter((width): width is number => width !== null);

  return {
    supportedModes: distinct(models.flatMap((model) => model.modes)),
    renderableColours: distinct(models.flatMap((model) => model.colours)),
    supportedFlashPatterns: distinct(models.flatMap((model) => model.flashPatterns)),
    maxBadgeCharacters: badgeWidths.length === 0 ? null : Math.min(...badgeWidths),
    minCommandIntervalMillis: models.reduce(
      (slowest, model) =>
        model.minCommandIntervalMillis > slowest ? model.minCommandIntervalMillis : slowest,
      0 as Millis,
    ),
  };
}
