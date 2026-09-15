import { HOUR, millis, SECOND } from '../../../../domain/common/time.js';
import { toISO } from '../../../../domain/common/time.js';
import { STANDARD_DEGRADATION_LADDER } from '../../../../ports/outbound/esl-actuation.port.js';
import type { EslVendorProfile } from '../fleet-adapter.js';
import type { EslTagModel } from '../tag-model.js';

/**
 * Aperion — colour, but no flash control anywhere in the catalogue.
 *
 * The fleet that makes the case for the ladder having more than two rungs.
 * Aperion's tags light a lane in the right colour and hold it steady; there is
 * no flash primitive in their API at all. So a critical task on an Aperion shelf
 * is the right colour and no more urgent-looking than a low one, which the result
 * reports as a degradation rather than hiding — the urgency the ranking decided
 * on did not survive the hardware, and the store's dispatcher should know.
 *
 * Its older Classic tags have no LED whatsoever and are e-paper only.
 *
 * Dialect notes: Aperion is snake_case throughout, addresses tags by `tag_uid`,
 * and takes an absolute ISO-8601 expiry rather than a duration.
 */

const APERION_LUMINA: EslTagModel = {
  modelCode: 'lumina-2',
  modes: ['lane_colour_steady', 'label_badge', 'mono_indicator'],
  colours: ['red', 'amber', 'blue', 'white', 'green'],
  flashPatterns: [],
  maxBadgeCharacters: 32,
  minCommandIntervalMillis: SECOND,
};

const APERION_CLASSIC: EslTagModel = {
  modelCode: 'classic-1',
  modes: ['label_badge'],
  colours: [],
  flashPatterns: [],
  maxBadgeCharacters: 24,
  minCommandIntervalMillis: millis(10_000),
};

const APERION_COLOURS: Readonly<Record<string, string>> = {
  red: 'red',
  amber: 'amber',
  green: 'green',
  blue: 'blue',
  white: 'white',
};

export const aperionProfile: EslVendorProfile = {
  vendor: 'aperion',
  fleetVendor: 'aperion',
  models: { 'lumina-2': APERION_LUMINA, 'classic-1': APERION_CLASSIC },
  floorModelCode: 'classic-1',
  degradationLadder: STANDARD_DEGRADATION_LADDER,
  defaultBatchLimit: 25,
  defaultLeaseMillis: millis(2 * HOUR),
  minBatteryPercent: 12,
  refusalCodes: {
    tag_unknown: 'tag_unbound',
    tag_not_associated: 'tag_unbound',
    no_tag_for_facing: 'facing_has_no_tag',
    tag_unreachable: 'tag_offline',
    battery_critical: 'battery_too_low',
    site_not_provisioned: 'store_not_onboarded',
    rate_limit: 'rate_limited',
    hub_offline: 'fleet_unreachable',
  },

  encodeExpression({ command, binding, plan, expiresAt }) {
    return {
      tag_uid: binding.tagId,
      task_ref: command.taskId,
      facing_ref: command.facingId,
      // Aperion has no flash primitive, so `mode` is only ever solid. The plan
      // never asks for one either — `lumina-2` declares no flash patterns, so the
      // ladder has already dropped pick-to-light before reaching this encoder.
      led:
        plan.colour === null
          ? null
          : { colour: APERION_COLOURS[plan.colour] ?? 'white', mode: 'solid' },
      indicator: plan.colour === null && plan.flash !== null ? { mode: 'blink' } : null,
      epaper:
        plan.badgeHeadline === null
          ? null
          : { banner: plan.badgeHeadline, sub_banner: plan.badgeDetail },
      expires_at: toISO(expiresAt),
      requested_at: toISO(command.requestedAt),
    };
  },

  encodeRelease({ command, binding }) {
    return {
      tag_uid: binding.tagId,
      task_ref: command.taskId,
      facing_ref: command.facingId,
      led: null,
      indicator: null,
      epaper: null,
      clear_reason: command.reason,
      requested_at: toISO(command.requestedAt),
    };
  },
};
