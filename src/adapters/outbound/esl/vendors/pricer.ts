import { HOUR, millis } from '../../../../domain/common/time.js';
import { STANDARD_DEGRADATION_LADDER } from '../../../../ports/outbound/esl-actuation.port.js';
import type { LedColor } from '../../../../domain/task/color-lane.js';
import type { EslVendorProfile } from '../fleet-adapter.js';
import type { EslTagModel } from '../tag-model.js';

/**
 * Pricer — pick-to-light on a restricted palette.
 *
 * Pricer's flagship does genuine pick-to-light, but its LED is a fixed set of
 * primaries rather than the full lane palette, and its older Continuum tags have
 * no flash control at all. That makes this the fleet where *colour* is the thing
 * that degrades: a retailer whose spoilage lane is pink finds that lane
 * unrenderable here, and the task lands on the e-paper strip as text instead of
 * being lit in a colour that means something else.
 *
 * Dialect notes: Pricer addresses tags by the item barcode, identifies LED
 * colours by **numeric id**, and states a time-to-live in seconds.
 */

const PRICER_SMARTFLASH: EslTagModel = {
  modelCode: 'SMARTFLASH',
  modes: ['pick_to_light', 'lane_colour_steady', 'label_badge'],
  colours: ['red', 'amber', 'green', 'blue', 'cyan', 'white', 'purple'],
  flashPatterns: ['slow', 'fast'],
  maxBadgeCharacters: 18,
  minCommandIntervalMillis: millis(2_000),
};

/** No flash control and three primaries — colour, but never pick-to-light. */
const PRICER_CONTINUUM: EslTagModel = {
  modelCode: 'CONTINUUM',
  modes: ['lane_colour_steady', 'label_badge'],
  colours: ['red', 'green', 'blue'],
  flashPatterns: [],
  maxBadgeCharacters: 18,
  minCommandIntervalMillis: millis(2_000),
};

/**
 * Pricer's numeric colour ids.
 *
 * A lane absent from this table is one the hardware has no id for, which is the
 * same fact `PRICER_SMARTFLASH.colours` states — but stated twice deliberately:
 * the capability table is what degradation is planned against, and this one is
 * what goes on the wire, and a mismatch would be a lane planned as renderable
 * and then sent as a colour the gateway rejects.
 */
const PRICER_COLOUR_IDS: Readonly<Partial<Record<LedColor, number>>> = {
  red: 1,
  green: 2,
  blue: 3,
  amber: 4,
  cyan: 5,
  white: 6,
  purple: 7,
};

const PRICER_FLASH_RATES: Readonly<Record<string, string>> = {
  slow: 'LOW',
  fast: 'HIGH',
  double_pulse: 'HIGH',
};

export const pricerProfile: EslVendorProfile = {
  vendor: 'pricer',
  fleetVendor: 'pricer',
  models: { SMARTFLASH: PRICER_SMARTFLASH, CONTINUUM: PRICER_CONTINUUM },
  floorModelCode: 'CONTINUUM',
  degradationLadder: STANDARD_DEGRADATION_LADDER,
  defaultBatchLimit: 50,
  defaultLeaseMillis: millis(6 * HOUR),
  minBatteryPercent: 15,
  refusalCodes: {
    UNKNOWN_ITEM: 'tag_unbound',
    NO_LABEL_FOR_ITEM: 'facing_has_no_tag',
    LABEL_OFFLINE: 'tag_offline',
    BATTERY_DEPLETED: 'battery_too_low',
    STORE_NOT_CONFIGURED: 'store_not_onboarded',
    TOO_MANY_REQUESTS: 'rate_limited',
    TRANSCEIVER_OFFLINE: 'fleet_unreachable',
  },

  encodeExpression({ command, binding, plan, expiresAt }) {
    const ttlSeconds = Math.ceil(Math.max(0, expiresAt - command.requestedAt) / 1_000);
    const colourId = plan.colour === null ? null : PRICER_COLOUR_IDS[plan.colour] ?? null;

    return {
      barcode: command.facingId,
      labelId: binding.tagId,
      signMode: plan.flash === null ? 'STEADY' : 'FLASH',
      ledColour: colourId,
      flashRate: plan.flash === null ? null : PRICER_FLASH_RATES[plan.flash] ?? 'LOW',
      textLine: plan.badgeHeadline,
      subTextLine: plan.badgeDetail,
      ttlSeconds,
      externalRef: command.taskId,
    };
  },

  encodeRelease({ command, binding }) {
    return {
      barcode: command.facingId,
      labelId: binding.tagId,
      signMode: 'OFF',
      ledColour: null,
      flashRate: null,
      textLine: null,
      subTextLine: null,
      ttlSeconds: 0,
      externalRef: command.taskId,
      clearReason: command.reason,
    };
  },
};
