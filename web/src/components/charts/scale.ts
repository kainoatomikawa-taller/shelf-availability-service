/**
 * The geometry every chart here shares.
 *
 * Small and hand-written rather than a charting library: these charts plot
 * between six and forty points from a report envelope, and the parts that
 * usually justify a library — scales, ticks, a tooltip — are the parts this
 * domain needs to control anyway. A null availability index has to leave a gap
 * in the line rather than plot at zero, and that is a decision no generic chart
 * component makes for us.
 */

export interface Extent {
  readonly min: number;
  readonly max: number;
}

export interface LinearScale {
  readonly domain: Extent;
  readonly range: Extent;
  (value: number): number;
}

export const linearScale = (domain: Extent, range: Extent): LinearScale => {
  const span = domain.max - domain.min;
  const project = (value: number): number =>
    span === 0
      ? (range.min + range.max) / 2
      : range.min + ((value - domain.min) / span) * (range.max - range.min);
  return Object.assign(project, { domain, range });
};

/** Extent over the values that exist. `null` when every value is missing. */
export const extentOf = (values: readonly (number | null)[]): Extent | null => {
  const present = values.filter((value): value is number => value !== null);
  if (present.length === 0) return null;
  return {
    min: Math.min(...present),
    max: Math.max(...present),
  };
};

/**
 * Pad an extent so marks do not touch the frame, and so a flat series still has
 * a band to sit in rather than collapsing onto a single pixel row.
 */
export const padExtent = (extent: Extent, fraction = 0.08): Extent => {
  if (extent.min === extent.max) {
    const nudge = Math.abs(extent.min) * fraction || 1;
    return { min: extent.min - nudge, max: extent.max + nudge };
  }
  const padding = (extent.max - extent.min) * fraction;
  return { min: extent.min - padding, max: extent.max + padding };
};

/** A count axis always includes zero — a bar that does not start at zero lies. */
export const includeZero = (extent: Extent): Extent => ({
  min: Math.min(0, extent.min),
  max: Math.max(0, extent.max),
});

const STEPS = [1, 2, 2.5, 5, 10];

/**
 * Round tick values: 0 / 250 / 500, never 0 / 237 / 474.
 *
 * Ticks carry the values that are not directly labelled, so they have to be
 * numbers a reader can hold in their head and interpolate between.
 */
export const niceTicks = (extent: Extent, count = 4): readonly number[] => {
  const span = extent.max - extent.min;
  if (span <= 0 || !Number.isFinite(span)) return [extent.min];

  const rough = span / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = (STEPS.find((candidate) => candidate * magnitude >= rough) ?? 10) * magnitude;

  const first = Math.ceil(extent.min / step) * step;
  const ticks: number[] = [];
  for (let value = first; value <= extent.max + step / 1000; value += step) {
    // Re-round each tick: repeated addition of a fractional step accumulates
    // float error, and a 0.30000000000000004 on an axis is unforgivable.
    ticks.push(Number((Math.round(value / step) * step).toPrecision(12)));
  }
  return ticks;
};

export interface ChartMargin {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export const DEFAULT_MARGIN: ChartMargin = { top: 12, right: 44, bottom: 24, left: 44 };

export interface PlotArea {
  readonly width: number;
  readonly height: number;
  readonly x: Extent;
  readonly y: Extent;
}

export const plotAreaOf = (
  width: number,
  height: number,
  margin: ChartMargin = DEFAULT_MARGIN,
): PlotArea => ({
  width,
  height,
  x: { min: margin.left, max: Math.max(margin.left, width - margin.right) },
  // Inverted: SVG's y grows downward, the data's does not.
  y: { min: Math.max(margin.top, height - margin.bottom), max: margin.top },
});

export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * An SVG path with breaks where the data is missing.
 *
 * Missing points break the line rather than being skipped over, because a line
 * drawn straight across a gap asserts a measurement that was never taken. This
 * is the single most important rule in this file for this domain: `index` is
 * `null` whenever nothing was measured, and it is `null` often.
 */
export const linePath = (points: readonly (Point | null)[]): string => {
  const commands: string[] = [];
  let penUp = true;
  for (const point of points) {
    if (point === null) {
      penUp = true;
      continue;
    }
    commands.push(`${penUp ? 'M' : 'L'}${round(point.x)} ${round(point.y)}`);
    penUp = false;
  }
  return commands.join(' ');
};

/** The same path closed down to the baseline, for the 10% area wash. */
export const areaPath = (points: readonly (Point | null)[], baseline: number): string => {
  const segments: string[] = [];
  let run: Point[] = [];

  const flush = (): void => {
    if (run.length < 2) {
      run = [];
      return;
    }
    const first = run[0] as Point;
    const last = run[run.length - 1] as Point;
    const body = run.map((point) => `L${round(point.x)} ${round(point.y)}`).join(' ');
    segments.push(
      `M${round(first.x)} ${round(baseline)} ${body} L${round(last.x)} ${round(baseline)} Z`,
    );
    run = [];
  };

  for (const point of points) {
    if (point === null) flush();
    else run.push(point);
  }
  flush();
  return segments.join(' ');
};

const round = (value: number): number => Math.round(value * 100) / 100;

/** Index of the plotted point nearest a pointer position, for the crosshair. */
export const nearestIndex = (xs: readonly number[], target: number): number | null => {
  if (xs.length === 0) return null;
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  xs.forEach((x, index) => {
    const distance = Math.abs(x - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
};
