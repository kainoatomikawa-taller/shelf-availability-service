import { HOUR, millis, SECOND } from '../../../../domain/common/time.js';
import { STANDARD_DEGRADATION_LADDER } from '../../../../ports/outbound/esl-actuation.port.js';
import type { EslVendorProfile } from '../fleet-adapter.js';
import type { EslTagModel } from '../tag-model.js';

/**
 * VusionGroup — the full-capability fleet.
 *
 * The reference implementation of what this service was designed around: a
 * current-generation Vusion tag does true pick-to-light, the whole lane palette
 * and a flash pattern, so a ranked task reaches the shelf exactly as the caller
 * asked for it. It is also the clearest case for why degradation is not
 * optional — the same retailer's older Sigma tags are in the same aisles, and
 * they are a mono indicator with a text strip.
 *
 * Dialect notes: Vusion addresses tags by label id, nests the LED under `flash`,
 * the text under `page`, and states durations in **seconds**.
 */

const VUSION_EDGE_3: EslTagModel = {
  modelCode: 'VUSION_EDGE_3',
  modes: ['pick_to_light', 'lane_colour_steady', 'label_badge', 'mono_indicator'],
  colours: ['red', 'amber', 'green', 'blue', 'purple', 'cyan', 'white', 'pink', 'teal'],
  flashPatterns: ['slow', 'fast', 'double_pulse'],
  maxBadgeCharacters: 24,
  minCommandIntervalMillis: SECOND,
};

/**
 * The previous generation, still in perhaps half the estate.
 *
 * No colour LED at all: a single white indicator and an e-paper strip. Every
 * coloured task on one of these degrades, which is exactly the signal a retailer
 * needs when deciding whether the refresh pays for itself.
 */
const VUSION_SIGMA_2: EslTagModel = {
  modelCode: 'VUSION_SIGMA_2',
  modes: ['label_badge', 'mono_indicator'],
  colours: [],
  flashPatterns: ['slow'],
  maxBadgeCharacters: 16,
  minCommandIntervalMillis: millis(5_000),
};

/** Vusion's LED colour names. Only lanes this fleet can render appear here. */
const VUSION_COLOURS: Readonly<Record<string, string>> = {
  red: 'RED',
  amber: 'ORANGE',
  green: 'GREEN',
  blue: 'BLUE',
  purple: 'VIOLET',
  cyan: 'CYAN',
  white: 'WHITE',
  pink: 'MAGENTA',
  teal: 'TURQUOISE',
};

const VUSION_PATTERNS: Readonly<Record<string, string>> = {
  slow: 'FLASH_SLOW',
  fast: 'FLASH_FAST',
  double_pulse: 'FLASH_DOUBLE',
};

export const vusionProfile: EslVendorProfile = {
  vendor: 'vusion',
  fleetVendor: 'vusiongroup',
  models: { VUSION_EDGE_3, VUSION_SIGMA_2 },
  floorModelCode: 'VUSION_SIGMA_2',
  degradationLadder: STANDARD_DEGRADATION_LADDER,
  defaultBatchLimit: 100,
  defaultLeaseMillis: millis(4 * HOUR),
  minBatteryPercent: 10,
  refusalCodes: {
    LABEL_NOT_FOUND: 'tag_unbound',
    LABEL_UNREACHABLE: 'tag_offline',
    LOW_BATTERY: 'battery_too_low',
    STORE_UNKNOWN: 'store_not_onboarded',
    QUOTA_EXCEEDED: 'rate_limited',
    GATEWAY_DOWN: 'fleet_unreachable',
  },

  encodeExpression({ command, binding, plan, expiresAt }) {
    // Vusion takes a lifetime in seconds, not an instant. Rounded up: rounding
    // down would drop the expression a beat before the loop expects to refresh
    // it, and a tag that goes dark early is a task that quietly stops existing.
    const lifetimeSeconds = Math.ceil(Math.max(0, expiresAt - command.requestedAt) / 1_000);

    return {
      labelId: binding.tagId,
      itemId: command.facingId,
      requestId: `${command.taskId}:${command.requestedAt}`,
      lifetimeSeconds,
      flash:
        plan.colour === null && plan.flash === null
          ? null
          : {
              colour: plan.colour === null ? 'WHITE' : VUSION_COLOURS[plan.colour] ?? 'WHITE',
              pattern: plan.flash === null ? 'STEADY' : VUSION_PATTERNS[plan.flash] ?? 'STEADY',
            },
      page:
        plan.badgeHeadline === null
          ? null
          : {
              layout: 'TASK_BADGE',
              fields: { line1: plan.badgeHeadline, line2: plan.badgeDetail ?? '' },
            },
    };
  },

  encodeRelease({ command, binding }) {
    return {
      labelId: binding.tagId,
      requestId: `${command.taskId}:clear:${command.requestedAt}`,
      flash: null,
      page: null,
      reason: command.reason,
    };
  },
};
