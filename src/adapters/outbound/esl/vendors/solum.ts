import { HOUR, millis } from '../../../../domain/common/time.js';
import { STANDARD_DEGRADATION_LADDER } from '../../../../ports/outbound/esl-actuation.port.js';
import type { EslVendorProfile } from '../fleet-adapter.js';
import type { EslTagModel } from '../tag-model.js';

/**
 * Solum — a white indicator and a good e-paper strip. No lane colour at all.
 *
 * The fleet the fallback clause exists for. Nothing Solum sells can express a
 * lane as a colour, so every task on a Solum shelf lands on the badge rung: the
 * task type as text, blinked by the mono indicator so it is visible from down the
 * aisle rather than only to someone already standing at the facing. The lane is
 * carried in words instead of in light, which is a real loss of glanceability and
 * is reported as a degradation every time.
 *
 * Dialect notes: Solum addresses tags by `labelCode`, numbers its blink patterns,
 * and takes an absolute expiry in **epoch millis**.
 */

const SOLUM_NEWTON_TOUCH: EslTagModel = {
  modelCode: 'NEWTON_TOUCH',
  modes: ['label_badge', 'mono_indicator'],
  colours: [],
  flashPatterns: ['slow', 'fast', 'double_pulse'],
  maxBadgeCharacters: 20,
  minCommandIntervalMillis: millis(3_000),
};

/** No LED at all: e-paper only, so the text has to carry the whole task. */
const SOLUM_NEWTON_PAPER: EslTagModel = {
  modelCode: 'NEWTON_PAPER',
  modes: ['label_badge'],
  colours: [],
  flashPatterns: [],
  maxBadgeCharacters: 20,
  minCommandIntervalMillis: millis(3_000),
};

const SOLUM_PATTERNS: Readonly<Record<string, number>> = {
  slow: 1,
  fast: 2,
  double_pulse: 3,
};

export const solumProfile: EslVendorProfile = {
  vendor: 'solum',
  fleetVendor: 'solum',
  models: { NEWTON_TOUCH: SOLUM_NEWTON_TOUCH, NEWTON_PAPER: SOLUM_NEWTON_PAPER },
  floorModelCode: 'NEWTON_PAPER',
  degradationLadder: STANDARD_DEGRADATION_LADDER,
  defaultBatchLimit: 200,
  defaultLeaseMillis: millis(8 * HOUR),
  minBatteryPercent: 8,
  refusalCodes: {
    E_LABEL_NOT_FOUND: 'tag_unbound',
    E_NO_LABEL: 'facing_has_no_tag',
    E_LABEL_TIMEOUT: 'tag_offline',
    E_BATTERY: 'battery_too_low',
    E_STORE_NOT_FOUND: 'store_not_onboarded',
    E_THROTTLE: 'rate_limited',
    E_AP_DISCONNECTED: 'fleet_unreachable',
  },

  encodeExpression({ command, binding, plan, expiresAt }) {
    return {
      labelCode: binding.tagId,
      articleId: command.facingId,
      // Text and blink go in the same command. The mode names the rung the plan
      // landed on; it does not stop the adapter using everything else the tag has.
      ledCommand:
        plan.flash === null ? null : { pattern: SOLUM_PATTERNS[plan.flash] ?? 1, repeat: 0 },
      templateData:
        plan.badgeHeadline === null
          ? null
          : { TASK_LINE: plan.badgeHeadline, TASK_SUB: plan.badgeDetail ?? '' },
      expireAt: expiresAt,
      trackingId: command.taskId,
    };
  },

  encodeRelease({ command, binding }) {
    return {
      labelCode: binding.tagId,
      articleId: command.facingId,
      ledCommand: null,
      templateData: null,
      expireAt: command.requestedAt,
      trackingId: command.taskId,
      cancelReason: command.reason,
    };
  },
};
