import { useId, useState } from 'react';
import { DEFAULT_MARGIN, includeZero, linearScale, niceTicks, plotAreaOf } from './scale';
import type { ChartMargin } from './scale';
import { useContainerWidth } from './useContainerWidth';

export interface BarDatum {
  readonly key: string;
  readonly label: string;
  /** `null` renders as an absent bar with a "not measured" tick, never as zero. */
  readonly value: number | null;
  /** Overrides the slot colour — used to paint a status, not a series. */
  readonly colourVar?: string;
}

export interface BarChartProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly data: readonly BarDatum[];
  readonly formatValue: (value: number) => string;
  readonly width?: number;
  readonly height?: number;
  readonly margin?: ChartMargin;
  /** Horizontal reads better for long category names; vertical for a time axis. */
  readonly orientation?: 'horizontal' | 'vertical';
}

/** Bars cap at 24px so the band's leftover stays as air rather than ink. */
const MAX_BAR_THICKNESS = 24;
/** Two pixels of surface between neighbours — the gap separates, not a stroke. */
const BAR_GAP = 2;
/** Rounded at the data end, square at the baseline. */
const END_RADIUS = 4;

/**
 * A magnitude comparison across categories.
 *
 * Always zero-based: a bar's length *is* its value, so a truncated axis turns a
 * two-point difference into a visual chasm. `includeZero` enforces that rather
 * than leaving it to the caller.
 */
export const BarChart = ({
  title,
  subtitle,
  data,
  formatValue,
  width = 560,
  height = 220,
  margin = DEFAULT_MARGIN,
  orientation = 'horizontal',
}: BarChartProps) => {
  const titleId = useId();
  const [hovered, setHovered] = useState<string | null>(null);
  const [containerRef, chartWidth] = useContainerWidth(width);

  const present = data.filter((datum): datum is BarDatum & { value: number } => datum.value !== null);
  if (data.length === 0 || present.length === 0) {
    return (
      <div className="osa-chart">
        <p className="osa-chart__title">{title}</p>
        <p className="osa-empty">Nothing measured in this window.</p>
      </div>
    );
  }

  const horizontal = orientation === 'horizontal';
  const chartMargin: ChartMargin = horizontal
    ? { ...margin, left: categoryGutter(data, chartWidth) }
    : margin;
  const plot = plotAreaOf(chartWidth, height, chartMargin);
  const domain = includeZero({
    min: Math.min(...present.map((datum) => datum.value)),
    max: Math.max(...present.map((datum) => datum.value)),
  });
  const ticks = niceTicks(domain, 4);

  const bandSpan = horizontal ? plot.y.min - plot.y.max : plot.x.max - plot.x.min;
  const band = bandSpan / data.length;
  const thickness = Math.max(2, Math.min(MAX_BAR_THICKNESS, band - BAR_GAP));

  const value = horizontal
    ? linearScale(domain, plot.x)
    : linearScale(domain, plot.y);
  const zero = value(0);

  return (
    <div className="osa-chart">
      <p className="osa-chart__title" id={titleId}>
        {title}
      </p>
      {subtitle === undefined ? null : <p className="osa-chart__subtitle">{subtitle}</p>}

      <figure className="osa-chart__figure" ref={containerRef}>
        <svg
          className="osa-chart__svg"
          width={chartWidth}
          height={height}
          viewBox={`0 0 ${chartWidth} ${height}`}
          role="img"
          aria-labelledby={titleId}
        >
          {ticks.map((tick) =>
            horizontal ? (
              <line
                key={tick}
                x1={value(tick)}
                x2={value(tick)}
                y1={plot.y.max}
                y2={plot.y.min}
                stroke="var(--osa-gridline)"
                strokeWidth={1}
              />
            ) : (
              <g key={tick}>
                <line
                  x1={plot.x.min}
                  x2={plot.x.max}
                  y1={value(tick)}
                  y2={value(tick)}
                  stroke="var(--osa-gridline)"
                  strokeWidth={1}
                />
                <text
                  className="osa-chart__tick"
                  x={plot.x.min - 8}
                  y={value(tick) + 4}
                  textAnchor="end"
                >
                  {formatValue(tick)}
                </text>
              </g>
            ),
          )}

          {data.map((datum, index) => {
            const bandStart = horizontal
              ? plot.y.max + index * band
              : plot.x.min + index * band;
            const offset = bandStart + (band - thickness) / 2;
            const colour = datum.colourVar ?? '--osa-series-1';

            if (datum.value === null) {
              return (
                <text
                  key={datum.key}
                  className="osa-chart__tick"
                  x={horizontal ? zero + 6 : offset + thickness / 2}
                  y={horizontal ? offset + thickness / 2 + 4 : zero - 6}
                  textAnchor={horizontal ? 'start' : 'middle'}
                >
                  not measured
                </text>
              );
            }

            const end = value(datum.value);
            const extent = Math.abs(end - zero);
            const geometry = horizontal
              ? { x: Math.min(zero, end), y: offset, width: extent, height: thickness }
              : { x: offset, y: Math.min(zero, end), width: thickness, height: extent };

            return (
              <g
                key={datum.key}
                onMouseEnter={() => setHovered(datum.key)}
                onMouseLeave={() => setHovered(null)}
              >
                <rect
                  {...geometry}
                  rx={Math.min(END_RADIUS, thickness / 2)}
                  fill={`var(${colour})`}
                  opacity={hovered === null || hovered === datum.key ? 1 : 0.55}
                />
                {/* Square off the baseline end: only the data end is rounded. */}
                <rect
                  x={horizontal ? Math.min(zero, end) : offset}
                  y={horizontal ? offset : Math.min(zero, end) + (end < zero ? 0 : extent - END_RADIUS)}
                  width={horizontal ? Math.min(END_RADIUS, extent) : thickness}
                  height={horizontal ? thickness : Math.min(END_RADIUS, extent)}
                  fill={`var(${colour})`}
                  opacity={hovered === null || hovered === datum.key ? 1 : 0.55}
                />
                {/* Value at the tip — the direct label that removes a whole axis. */}
                <text
                  className="osa-chart__direct-label"
                  x={horizontal ? end + 6 : offset + thickness / 2}
                  y={horizontal ? offset + thickness / 2 + 4 : end - 6}
                  textAnchor={horizontal ? 'start' : 'middle'}
                >
                  {formatValue(datum.value)}
                </text>
                {horizontal ? (
                  <CategoryLabel
                    label={datum.label}
                    available={chartMargin.left - 12}
                    x={plot.x.min - 8}
                    y={offset + thickness / 2 + 4}
                  />
                ) : null}
              </g>
            );
          })}

          <line
            x1={horizontal ? zero : plot.x.min}
            x2={horizontal ? zero : plot.x.max}
            y1={horizontal ? plot.y.max : zero}
            y2={horizontal ? plot.y.min : zero}
            stroke="var(--osa-axis)"
            strokeWidth={1}
          />
        </svg>
      </figure>
    </div>
  );
};

/**
 * Width to reserve for the category labels down the left of a horizontal chart.
 *
 * Measured off the longest label rather than fixed, because a fixed gutter
 * either wastes half the plot on short labels or lets a long one run off the
 * edge of the panel. Capped at 40% of the chart so the bars never become a
 * sliver next to their own names — anything that still does not fit is
 * truncated, with the full text on the mark's `<title>`.
 *
 * The per-character estimate stands in for real text measurement: an SVG label
 * cannot be measured before it is drawn, and the alternative is a hidden render
 * pass for something a chart this small does not need.
 */
const APPROX_CHAR_WIDTH = 6.1;

const categoryGutter = (data: readonly BarDatum[], chartWidth: number): number => {
  const longest = data.reduce((width, datum) => Math.max(width, datum.label.length), 0);
  return Math.round(
    Math.min(Math.max(longest * APPROX_CHAR_WIDTH + 16, 96), Math.max(96, chartWidth * 0.4)),
  );
};

/**
 * A category label, shortened only when it has to be.
 *
 * The `<title>` is attached only to a truncated label: on one that fits it would
 * duplicate the text for assistive tech and add a tooltip that says exactly what
 * is already on screen.
 */
const CategoryLabel = ({
  label,
  available,
  x,
  y,
}: {
  readonly label: string;
  readonly available: number;
  readonly x: number;
  readonly y: number;
}) => {
  const fits = Math.floor(available / APPROX_CHAR_WIDTH);
  if (label.length <= fits) {
    return (
      <text className="osa-chart__tick" x={x} y={y} textAnchor="end">
        {label}
      </text>
    );
  }
  return (
    <text className="osa-chart__tick" x={x} y={y} textAnchor="end">
      <title>{label}</title>
      {`${label.slice(0, Math.max(1, fits - 1))}…`}
    </text>
  );
};
