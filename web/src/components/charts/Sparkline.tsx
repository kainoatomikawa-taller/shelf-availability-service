import { linePath, linearScale, padExtent, extentOf } from './scale';
import type { Point } from './scale';

export interface SparklineProps {
  /** `null` entries break the line rather than being interpolated across. */
  readonly values: readonly (number | null)[];
  readonly width?: number;
  readonly height?: number;
  /** A CSS custom property name, so the colour follows the theme. */
  readonly seriesVar?: string;
  /** Names what is plotted, for a reader who cannot see the shape. */
  readonly label: string;
}

/**
 * A twelve-or-so point trend, for the corner of a stat tile.
 *
 * No axes, no labels, no tooltip: a sparkline's job is shape, and the card's
 * value and delta carry the numbers. The last point is marked so the eye lands
 * on "now" rather than sweeping the whole line.
 */
export const Sparkline = ({
  values,
  width = 96,
  height = 28,
  seriesVar = '--osa-series-1',
  label,
}: SparklineProps) => {
  const extent = extentOf(values);
  if (extent === null || values.length < 2) {
    return <span className="osa-micro">{label}: not enough data</span>;
  }

  const padded = padExtent(extent);
  const x = linearScale({ min: 0, max: values.length - 1 }, { min: 2, max: width - 2 });
  const y = linearScale(padded, { min: height - 3, max: 3 });

  const points: (Point | null)[] = values.map((value, index) =>
    value === null ? null : { x: x(index), y: y(value) },
  );
  const last = [...points].reverse().find((point): point is Point => point !== null);

  return (
    <svg
      className="osa-chart__svg"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
      style={{ width, height }}
    >
      <path
        d={linePath(points)}
        fill="none"
        stroke={`var(${seriesVar})`}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {last === undefined ? null : (
        <circle
          cx={last.x}
          cy={last.y}
          r={3}
          fill={`var(${seriesVar})`}
          stroke="var(--osa-surface-1)"
          strokeWidth={2}
        />
      )}
    </svg>
  );
};
