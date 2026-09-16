import { useId, useState } from 'react';
import type { MouseEvent } from 'react';
import {
  DEFAULT_MARGIN,
  areaPath,
  extentOf,
  linePath,
  linearScale,
  nearestIndex,
  niceTicks,
  padExtent,
  plotAreaOf,
} from './scale';
import type { ChartMargin, Point } from './scale';
import { useContainerWidth } from './useContainerWidth';

export interface LineSeries {
  readonly key: string;
  readonly label: string;
  /** One value per category, `null` where nothing was measured. */
  readonly values: readonly (number | null)[];
  /** Categorical slot, assigned in fixed order by the caller — never by rank. */
  readonly seriesVar?: string;
}

export interface LineChartProps {
  readonly title: string;
  readonly subtitle?: string;
  /** X-axis labels, one per point. Usually a bucket's start time. */
  readonly categories: readonly string[];
  readonly series: readonly LineSeries[];
  readonly formatValue: (value: number) => string;
  /** Used until the container is measured, and wherever it cannot be. */
  readonly width?: number;
  readonly height?: number;
  readonly margin?: ChartMargin;
  /** Fixes the y-domain, e.g. `{min: 0, max: 1}` for a ratio. */
  readonly yDomain?: { readonly min: number; readonly max: number };
  /** Paint the 10% wash under a single series. Off for multi-series, where washes overlap. */
  readonly showArea?: boolean;
}

/** The fixed slot order. A fourth series folds into "Other" rather than inventing a hue. */
const SLOT_VARS = ['--osa-series-1', '--osa-series-2', '--osa-series-3'] as const;

/**
 * A time series, with a crosshair and a tooltip.
 *
 * Deliberately single-axis: two measures on two scales in one frame is the most
 * common way a dashboard misleads, and every pairing this dashboard needs —
 * availability against coverage, tasks against latency — is two charts or an
 * indexed common base, never two y-axes.
 *
 * Gaps in the data break the line. On this dashboard that is not a nicety: the
 * availability index is `null` for any bucket with no measured facing-time, and
 * a line drawn through those nulls would show a shelf as observed when nobody
 * looked at it.
 */
export const LineChart = ({
  title,
  subtitle,
  categories,
  series,
  formatValue,
  width = 560,
  height = 220,
  margin = DEFAULT_MARGIN,
  yDomain,
  showArea = true,
}: LineChartProps) => {
  const titleId = useId();
  const [hovered, setHovered] = useState<number | null>(null);
  const [containerRef, chartWidth] = useContainerWidth(width);

  const plot = plotAreaOf(chartWidth, height, margin);
  const allValues = series.flatMap((one) => one.values);
  const measured = extentOf(allValues);

  if (categories.length === 0 || measured === null) {
    return (
      <figure className="osa-chart">
        <figcaption className="osa-chart__title">{title}</figcaption>
        <p className="osa-empty">Nothing measured in this window.</p>
      </figure>
    );
  }

  const domain = yDomain ?? padExtent(measured);
  const x = linearScale({ min: 0, max: Math.max(1, categories.length - 1) }, plot.x);
  const y = linearScale(domain, plot.y);
  const ticks = niceTicks(domain, 4);
  const xs = categories.map((_, index) => x(index));

  const pointsFor = (one: LineSeries): (Point | null)[] =>
    one.values.map((value, index) => (value === null ? null : { x: x(index), y: y(value) }));

  // A single series needs no legend box — the title already names what is
  // plotted, and a one-swatch legend just restates it.
  const showLegend = series.length > 1;

  const onMove = (event: MouseEvent<SVGRectElement>): void => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width === 0) return;
    const plotWidth = Math.max(1, plot.x.max - plot.x.min);
    const local = plot.x.min + ((event.clientX - bounds.left) / bounds.width) * plotWidth;
    setHovered(nearestIndex(xs, local));
  };

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
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={plot.x.min}
                x2={plot.x.max}
                y1={y(tick)}
                y2={y(tick)}
                stroke="var(--osa-gridline)"
                strokeWidth={1}
              />
              <text className="osa-chart__tick" x={plot.x.min - 8} y={y(tick) + 4} textAnchor="end">
                {formatValue(tick)}
              </text>
            </g>
          ))}

          <line
            x1={plot.x.min}
            x2={plot.x.max}
            y1={plot.y.min}
            y2={plot.y.min}
            stroke="var(--osa-axis)"
            strokeWidth={1}
          />

          {series.map((one, slot) => {
            const colour = one.seriesVar ?? SLOT_VARS[slot % SLOT_VARS.length];
            const points = pointsFor(one);
            return (
              <g key={one.key}>
                {showArea && series.length === 1 ? (
                  <path d={areaPath(points, plot.y.min)} fill={`var(${colour})`} opacity={0.1} />
                ) : null}
                <path
                  d={linePath(points)}
                  fill="none"
                  stroke={`var(${colour})`}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </g>
            );
          })}

          {hovered === null ? null : (
            <g>
              <line
                x1={xs[hovered]}
                x2={xs[hovered]}
                y1={plot.y.max}
                y2={plot.y.min}
                stroke="var(--osa-axis)"
                strokeWidth={1}
              />
              {series.map((one, slot) => {
                const value = one.values[hovered];
                if (value === undefined || value === null) return null;
                return (
                  <circle
                    key={one.key}
                    cx={xs[hovered]}
                    cy={y(value)}
                    r={4}
                    fill={`var(${one.seriesVar ?? SLOT_VARS[slot % SLOT_VARS.length]})`}
                    stroke="var(--osa-surface-1)"
                    strokeWidth={2}
                  />
                );
              })}
            </g>
          )}

          <text className="osa-chart__tick" x={plot.x.min} y={height - 6} textAnchor="start">
            {categories[0]}
          </text>
          <text className="osa-chart__tick" x={plot.x.max} y={height - 6} textAnchor="end">
            {categories[categories.length - 1]}
          </text>

          {/* Hit area last so it sits above the marks and catches every pointer. */}
          <rect
            x={plot.x.min}
            y={plot.y.max}
            width={Math.max(0, plot.x.max - plot.x.min)}
            height={Math.max(0, plot.y.min - plot.y.max)}
            fill="transparent"
            onMouseMove={onMove}
            onMouseLeave={() => setHovered(null)}
          />
        </svg>

        {hovered === null ? null : (
          <div
            className="osa-chart__tooltip"
            style={{
              left: `${((xs[hovered] ?? 0) / chartWidth) * 100}%`,
              top: 0,
              transform: 'translate(-50%, -100%)',
            }}
          >
            <strong>{categories[hovered]}</strong>
            <dl>
              {series.map((one) => {
                const value = one.values[hovered];
                return (
                  <div key={one.key} style={{ display: 'contents' }}>
                    <dt>{one.label}</dt>
                    <dd>{value === undefined || value === null ? '—' : formatValue(value)}</dd>
                  </div>
                );
              })}
            </dl>
          </div>
        )}
      </figure>

      {showLegend ? (
        <ul className="osa-chart__legend">
          {series.map((one, slot) => (
            <li className="osa-chart__legend-item" key={one.key}>
              <span
                className="osa-chart__legend-key"
                style={{
                  background: `var(${one.seriesVar ?? SLOT_VARS[slot % SLOT_VARS.length]})`,
                }}
                aria-hidden="true"
              />
              {one.label}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
};
