import { isReservedLane, RESERVED_LANES, type LedColor } from '../../../domain/task/color-lane.js';
import {
  STANDARD_DEGRADATION_LADDER,
  type EslExpressionMode,
  type EslFlashPattern,
  type ExpressTaskCommand,
} from '../../../ports/outbound/esl-actuation.port.js';
import { modelSupports, type EslTagModel } from './tag-model.js';

/**
 * Walking the degradation ladder — the one piece of judgement every vendor
 * adapter shares, so it lives here and is tested once.
 *
 * The rule the whole package turns on: **a task that cannot be expressed the way
 * the caller asked is expressed the best way the tag can manage, and the result
 * says so.** A shelf-edge task the employee cannot see is a task that did not
 * happen, so dropping to text or to a blink is always preferable to refusing —
 * and always worth reporting, because `degraded` is the signal a retailer uses to
 * decide whether the refresh is worth funding.
 */

/** How one command will actually be rendered on one tag. */
export interface ExpressionPlan {
  /** The rung landed on. */
  readonly mode: EslExpressionMode;
  /** True when `mode` is not the caller's first preference. */
  readonly degraded: boolean;
  /** The lane, when a colour mode was used. Never a substituted colour — see below. */
  readonly colour: LedColor | null;
  /** The flash or blink pattern actually driven. */
  readonly flash: EslFlashPattern | null;
  /** Text for the tag's e-paper area, already truncated to the model's width. */
  readonly badgeHeadline: string | null;
  readonly badgeDetail: string | null;
  /** Why the caller's first preference was not used, for the dispatch log. */
  readonly reason: string | null;
}

/**
 * Truncates to the tag's width.
 *
 * Hard truncation with no ellipsis: an ellipsis costs a character on a fourteen
 * character e-paper strip, and `RESTOCK OAT MI` tells an employee more than
 * `RESTOCK OAT M…` does.
 */
const fit = (text: string, max: number): string | null => {
  const trimmed = text.trim();
  if (trimmed === '' || max <= 0) return null;
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max).trimEnd();
};

/**
 * Whether this tag may be driven to the task's lane colour.
 *
 * Two separate refusals, and the second is the interesting one. A reserved lane
 * — green, which means "pick this for an order" on every tag in the estate — is
 * never driven for staff work, no matter how capable the tag is. One light
 * meaning two things on the same shelf is worse than a task expressed as text,
 * so a reserved lane degrades the expression rather than lighting an ambiguous
 * colour. The use case rejects reserved lanes when a task is planned; this is the
 * same rule at the hardware boundary, where a lane map read back from storage
 * would otherwise get its one chance to reach a shelf.
 */
const laneUsable = (model: EslTagModel, lane: LedColor): boolean =>
  !isReservedLane(lane) && model.colours.includes(lane);

/** The pattern a mono indicator blinks at: the caller's, else whatever the tag has. */
const blinkFor = (
  model: EslTagModel,
  requested: EslFlashPattern | null,
): EslFlashPattern | null => {
  if (requested !== null && model.flashPatterns.includes(requested)) return requested;
  return model.flashPatterns[0] ?? null;
};

/** The plan for one rung, or `null` when this tag cannot manage that rung. */
type Rung = Omit<ExpressionPlan, 'mode' | 'degraded'>;

function rungFor(
  command: ExpressTaskCommand,
  model: EslTagModel,
  mode: EslExpressionMode,
): Rung | null {
  const laneReserved = isReservedLane(command.lane);
  const colourReason = laneReserved
    ? `lane "${command.lane}" is reserved for ${RESERVED_LANES[command.lane]}`
    : `${model.modelCode} cannot render lane "${command.lane}"`;

  switch (mode) {
    case 'pick_to_light': {
      if (!modelSupports(model, 'pick_to_light')) return null;
      if (!laneUsable(model, command.lane)) return null;
      // A caller that named a flash pattern asked for pick-to-light proper. If
      // this tag cannot produce that pattern, lighting the lane steady instead is
      // a real loss of urgency and drops to the next rung so it is reported as
      // one, rather than being silently smoothed over with a different pattern.
      if (command.flashPattern !== null && !model.flashPatterns.includes(command.flashPattern)) {
        return null;
      }
      return {
        colour: command.lane,
        flash: command.flashPattern,
        badgeHeadline: null,
        badgeDetail: null,
        reason: null,
      };
    }

    case 'lane_colour_steady': {
      if (!modelSupports(model, 'lane_colour_steady')) return null;
      if (!laneUsable(model, command.lane)) return null;
      return {
        colour: command.lane,
        flash: null,
        badgeHeadline: null,
        badgeDetail: null,
        reason:
          command.flashPattern === null
            ? null
            : `${model.modelCode} has no "${command.flashPattern}" flash pattern`,
      };
    }

    case 'label_badge': {
      if (!modelSupports(model, 'label_badge')) return null;
      const width = model.maxBadgeCharacters;
      if (width === null || command.badge === null) return null;
      const headline = fit(command.badge.headline, width);
      if (headline === null) return null;
      return {
        colour: null,
        // Text *and* blink where the tag has both. The rung names the most
        // expressive thing the tag can do, not the only thing it is asked to do,
        // and a strip of text nobody looks at is not physically visible.
        flash: modelSupports(model, 'mono_indicator')
          ? blinkFor(model, command.flashPattern)
          : null,
        badgeHeadline: headline,
        badgeDetail: command.badge.detail === null ? null : fit(command.badge.detail, width),
        reason: colourReason,
      };
    }

    case 'mono_indicator': {
      if (!modelSupports(model, 'mono_indicator')) return null;
      return {
        colour: null,
        flash: blinkFor(model, command.flashPattern),
        badgeHeadline: null,
        badgeDetail: null,
        reason: `${colourReason}, and it has no text area`,
      };
    }

    case 'none':
      return {
        colour: null,
        flash: null,
        badgeHeadline: null,
        badgeDetail: null,
        reason: `${model.modelCode} can express nothing on the caller's ladder`,
      };
  }
}

/**
 * Picks the most expressive rung this tag can manage from the caller's ladder.
 *
 * The ladder comes in unfiltered — the caller states what it wants, not what it
 * believes the fleet can do — which is what makes `degraded` mean something. It
 * is measured against the caller's *first* preference, so a fleet running a
 * decade-old mono generation reports differently from a new one even though both
 * lit something.
 *
 * `colour` is only ever the task's own lane. A colour the tag cannot render is
 * dropped, never substituted: the lane *is* the meaning, and an amber task lit
 * red is a worse outcome than the same task shown as text.
 */
export function planExpression(
  command: ExpressTaskCommand,
  model: EslTagModel,
): ExpressionPlan {
  const ladder =
    command.modePreference.length > 0 ? command.modePreference : STANDARD_DEGRADATION_LADDER;
  const wanted = ladder[0] ?? 'none';

  for (const mode of ladder) {
    const rung = rungFor(command, model, mode);
    if (rung === null) continue;
    const degraded = mode !== wanted;
    return { ...rung, mode, degraded, reason: degraded ? rung.reason : null };
  }

  // A ladder that never reached `none` still has a defined answer: nothing.
  return {
    mode: 'none',
    degraded: wanted !== 'none',
    colour: null,
    flash: null,
    badgeHeadline: null,
    badgeDetail: null,
    reason: `${model.modelCode} supports no mode on the caller's ladder`,
  };
}

/**
 * Identity of a rendering, used to tell a re-express from a change.
 *
 * Re-expressing a task that is already lit the same way must renew its lease
 * rather than send the tag a second identical command — the port requires the
 * first, and every one of these gateways rate-limits the second.
 */
export const renderingFingerprint = (plan: ExpressionPlan): string =>
  [plan.mode, plan.colour ?? '-', plan.flash ?? '-', plan.badgeHeadline ?? '-', plan.badgeDetail ?? '-'].join(
    '|',
  );
