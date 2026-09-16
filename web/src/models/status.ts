import { assertNever } from './exhaustive';

/**
 * The severity a status indicator can report.
 *
 * `unknown` is first class for the same reason `ShelfState.unknown` is: this
 * service measures shelves it cannot always see, and "no evidence" must never
 * render as "fine". A null availability index is `unknown`, not `good`.
 */
export type StatusLevel = 'good' | 'warning' | 'serious' | 'critical' | 'unknown';

export const STATUS_LEVELS = [
  'good',
  'warning',
  'serious',
  'critical',
  'unknown',
] as const satisfies readonly StatusLevel[];

export const STATUS_LEVEL_LABELS: Readonly<Record<StatusLevel, string>> = {
  good: 'On target',
  warning: 'Watch',
  serious: 'Off target',
  critical: 'Critical',
  unknown: 'Not measured',
};

/**
 * The glyph paired with every status colour.
 *
 * Status is never carried by hue alone — on the light surface `warning` and
 * `serious` sit below 3:1 against it, and a colourblind reader cannot separate
 * `critical` from a red series mark. The icon plus the label is the mitigation,
 * so these travel with the level rather than being a component's choice.
 */
export const STATUS_LEVEL_GLYPHS: Readonly<Record<StatusLevel, string>> = {
  good: '●',
  warning: '▲',
  serious: '◆',
  critical: '■',
  unknown: '○',
};

const SEVERITY_ORDER: Readonly<Record<StatusLevel, number>> = {
  unknown: 0,
  good: 1,
  warning: 2,
  serious: 3,
  critical: 4,
};

/** The worst level in a set — what a rolled-up card reports for its children. */
export const worstStatus = (levels: readonly StatusLevel[]): StatusLevel =>
  levels.reduce<StatusLevel>(
    (worst, level) => (SEVERITY_ORDER[level] > SEVERITY_ORDER[worst] ? level : worst),
    'unknown',
  );

/** Which way is good. A rework rate and an availability index read in opposite directions. */
export type MetricDirection = 'higher_is_better' | 'lower_is_better';

/**
 * Bands for grading a measure, given as the boundaries between levels rather
 * than as a level per range, so a threshold set cannot leave a gap or overlap.
 *
 * Read as: anything at least as good as `good` is good; past `warning` it is a
 * watch; past `serious` it is off target; past `critical` it is critical. The
 * comparison flips with `direction`.
 */
export interface StatusThresholds {
  readonly direction: MetricDirection;
  readonly good: number;
  readonly warning: number;
  readonly serious: number;
}

/** Grade a measure. `null` in, `unknown` out — never a default of `good`. */
export const evaluateStatus = (
  value: number | null,
  thresholds: StatusThresholds,
): StatusLevel => {
  if (value === null || !Number.isFinite(value)) return 'unknown';
  switch (thresholds.direction) {
    case 'higher_is_better':
      if (value >= thresholds.good) return 'good';
      if (value >= thresholds.warning) return 'warning';
      if (value >= thresholds.serious) return 'serious';
      return 'critical';
    case 'lower_is_better':
      if (value <= thresholds.good) return 'good';
      if (value <= thresholds.warning) return 'warning';
      if (value <= thresholds.serious) return 'serious';
      return 'critical';
    default:
      return assertNever(thresholds.direction, 'evaluateStatus');
  }
};

/**
 * Whether a delta is a good delta.
 *
 * Kept apart from the colour decision so a component can show "down 3 points" in
 * success green when down is the goal, without each call site re-deriving the
 * sign convention.
 */
export const deltaIsImprovement = (delta: number, direction: MetricDirection): boolean =>
  direction === 'higher_is_better' ? delta > 0 : delta < 0;

/**
 * The pilot's default bands.
 *
 * Central rather than inlined per card: these are the numbers the pilot is
 * reported against, and two panels grading the same measure differently is the
 * fastest way to lose a retailer's trust in the whole dashboard.
 */
export const AVAILABILITY_INDEX_THRESHOLDS: StatusThresholds = {
  direction: 'higher_is_better',
  good: 0.98,
  warning: 0.96,
  serious: 0.93,
};

export const RESOLVED_GAP_RATE_THRESHOLDS: StatusThresholds = {
  direction: 'higher_is_better',
  good: 0.9,
  warning: 0.8,
  serious: 0.65,
};

export const REWORK_RATE_THRESHOLDS: StatusThresholds = {
  direction: 'lower_is_better',
  good: 0.05,
  warning: 0.1,
  serious: 0.2,
};

export const ACKNOWLEDGEMENT_RATE_THRESHOLDS: StatusThresholds = {
  direction: 'higher_is_better',
  good: 0.9,
  warning: 0.75,
  serious: 0.5,
};

/**
 * Coverage bands — how much of the window the shelf was actually observed for.
 *
 * Graded separately from the index it qualifies, because a 99% index measured
 * over 20% of the window is not a 99% index, and the card needs to be able to
 * say so without downgrading the index itself.
 */
export const COVERAGE_THRESHOLDS: StatusThresholds = {
  direction: 'higher_is_better',
  good: 0.8,
  warning: 0.6,
  serious: 0.4,
};

/** End-to-end detection-to-verification p50, in millis. */
export const DETECTION_TO_VERIFICATION_THRESHOLDS: StatusThresholds = {
  direction: 'lower_is_better',
  good: 4 * 60 * 60 * 1_000,
  warning: 8 * 60 * 60 * 1_000,
  serious: 24 * 60 * 60 * 1_000,
};
