import { HOUR, millis } from '../../../../domain/common/time.js';
import { STANDARD_DEGRADATION_LADDER } from '../../../../ports/outbound/esl-actuation.port.js';
import type { EslVendorProfile } from '../fleet-adapter.js';
import type { EslTagModel } from '../tag-model.js';

/**
 * Hashow — the cheapest tags in the estate, and the bottom of the ladder.
 *
 * Hashow is why `mono_indicator` is a rung rather than an afterthought. Their
 * HS-Lite has no text area and no colour: a single blinking dot is the entire
 * vocabulary the tag has, and the only thing it can say is "there is work at this
 * facing". That is still worth saying — an employee walking the aisle sees a
 * blink and opens the handheld list — and it is emphatically not the same as the
 * shelf being lit, so it is reported as the bottom rung it is.
 *
 * Dialect notes: Hashow is snake_case, addresses tags by `esl_id`, dispatches by
 * command verb, and takes a validity in **milliseconds**.
 */

const HASHOW_HS_PLUS: EslTagModel = {
  modelCode: 'HS-PLUS',
  modes: ['lane_colour_steady', 'label_badge', 'mono_indicator'],
  colours: ['red', 'amber', 'blue'],
  flashPatterns: ['slow'],
  maxBadgeCharacters: 14,
  minCommandIntervalMillis: millis(15_000),
};

/** A blinking dot and nothing else. */
const HASHOW_HS_LITE: EslTagModel = {
  modelCode: 'HS-LITE',
  modes: ['mono_indicator'],
  colours: [],
  flashPatterns: ['slow', 'fast'],
  maxBadgeCharacters: null,
  minCommandIntervalMillis: millis(15_000),
};

const HASHOW_COLOURS: Readonly<Record<string, string>> = {
  red: 'R',
  amber: 'Y',
  blue: 'B',
};

const HASHOW_PATTERNS: Readonly<Record<string, string>> = {
  slow: 'BLINK_1HZ',
  fast: 'BLINK_4HZ',
  double_pulse: 'BLINK_4HZ',
};

export const hashowProfile: EslVendorProfile = {
  vendor: 'hashow',
  fleetVendor: 'hashow',
  models: { 'HS-PLUS': HASHOW_HS_PLUS, 'HS-LITE': HASHOW_HS_LITE },
  floorModelCode: 'HS-LITE',
  degradationLadder: STANDARD_DEGRADATION_LADDER,
  defaultBatchLimit: 20,
  defaultLeaseMillis: millis(3 * HOUR),
  minBatteryPercent: 20,
  refusalCodes: {
    esl_not_found: 'tag_unbound',
    esl_not_bound: 'tag_unbound',
    no_esl: 'facing_has_no_tag',
    esl_no_response: 'tag_offline',
    battery_low: 'battery_too_low',
    shop_not_open: 'store_not_onboarded',
    busy: 'rate_limited',
    ap_error: 'fleet_unreachable',
  },

  encodeExpression({ command, binding, plan, expiresAt }) {
    const hasOverlay = plan.badgeHeadline !== null;
    const hasLamp = plan.colour !== null || plan.flash !== null;

    return {
      esl_id: binding.tagId,
      // Hashow's gateway dispatches on a verb rather than on the body's shape,
      // so the rung has to be named here. `LED_ONLY` is the honest verb for a
      // tag that can only blink: nothing is written, nothing is coloured.
      cmd: hasOverlay ? 'DISPLAY_OVERLAY' : hasLamp ? 'LED_ONLY' : 'CLEAR',
      overlay: hasOverlay ? { text: plan.badgeHeadline, sub: plan.badgeDetail ?? '' } : null,
      lamp: hasLamp
        ? {
            colour: plan.colour === null ? null : HASHOW_COLOURS[plan.colour] ?? null,
            mode: plan.flash === null ? 'ON' : HASHOW_PATTERNS[plan.flash] ?? 'BLINK_1HZ',
          }
        : null,
      valid_for_ms: Math.max(0, expiresAt - command.requestedAt),
      ref: command.taskId,
    };
  },

  encodeRelease({ command, binding }) {
    return {
      esl_id: binding.tagId,
      cmd: 'CLEAR',
      overlay: null,
      lamp: null,
      valid_for_ms: 0,
      ref: command.taskId,
      why: command.reason,
    };
  },
};
