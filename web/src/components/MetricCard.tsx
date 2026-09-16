import type { ReactNode } from 'react';
import { NOT_MEASURED } from '../models/format';
import type { MetricDirection, StatusLevel } from '../models/status';
import { deltaIsImprovement } from '../models/status';
import type { ServiceError } from '../services/errors';
import { ErrorPanel, Skeleton } from './AsyncStates';
import { StatusIndicator } from './StatusIndicator';
import { Sparkline } from './charts/Sparkline';

export interface MetricDelta {
  /** Pre-formatted, signed: "+1.2 pts", "−14". */
  readonly formatted: string;
  /** The raw change, used only to decide whether it is an improvement. */
  readonly value: number;
  readonly direction: MetricDirection;
  /** What it is a change against: "vs previous 24h". */
  readonly comparedTo: string;
}

export interface MetricCardProps {
  /** Sentence case, no trailing colon. */
  readonly label: string;
  /** Pre-formatted by the caller, so the card never decides how a measure rounds. */
  readonly value: string;
  readonly delta?: MetricDelta;
  readonly status?: StatusLevel;
  /**
   * The denominator, the coverage, the exclusion — whatever makes the figure
   * honest.
   *
   * Not decoration. A resolved-gap rate without its denominator, or an
   * availability index without its coverage, is a number someone will quote in a
   * meeting without the caveat that makes it true.
   */
  readonly footnote?: ReactNode;
  /** Twelve-or-so points of recent history. */
  readonly trend?: readonly (number | null)[];
  /** The one figure a view leads with. At most one per screen. */
  readonly hero?: boolean;
  readonly loading?: boolean;
  readonly error?: ServiceError | null;
  readonly onRetry?: (() => void) | undefined;
}

/**
 * One measure, with everything needed to read it honestly.
 *
 * The card keeps its footprint across all three states — value, skeleton,
 * error — so a dashboard of ten of these does not reflow every time one of them
 * refreshes.
 */
export const MetricCard = ({
  label,
  value,
  delta,
  status,
  footnote,
  trend,
  hero = false,
  loading = false,
  error = null,
  onRetry,
}: MetricCardProps) => {
  const unmeasured = value === NOT_MEASURED;

  return (
    <section className="osa-panel osa-metric-card" aria-label={label}>
      <div className="osa-metric-card__head">
        <p className="osa-label">{label}</p>
        {status === undefined ? null : <StatusIndicator level={status} />}
      </div>

      {error !== null ? (
        <ErrorPanel error={error} onRetry={onRetry} />
      ) : loading ? (
        <>
          <Skeleton height={hero ? '48px' : '30px'} width="60%" label={`${label} loading`} />
          <Skeleton height="14px" width="40%" label="" />
        </>
      ) : (
        <>
          <div className="osa-metric-card__row">
            <p
              className={[
                'osa-metric-card__value',
                hero ? 'osa-metric-card__value--hero' : '',
                unmeasured ? 'osa-metric-card__value--unmeasured' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              {value}
            </p>
            {trend === undefined || trend.length < 2 ? null : (
              <Sparkline values={trend} label={`${label} trend`} />
            )}
          </div>

          {delta === undefined ? null : <DeltaChip delta={delta} />}
        </>
      )}

      {footnote === undefined ? null : <p className="osa-metric-card__footnote">{footnote}</p>}
    </section>
  );
};

/**
 * A signed change, coloured by whether it is good rather than by its sign.
 *
 * A falling rework rate and a falling availability index are both negative
 * numbers and opposite news, so the direction comes from the measure, never from
 * the arithmetic.
 */
const DeltaChip = ({ delta }: { readonly delta: MetricDelta }) => {
  const tone =
    delta.value === 0
      ? 'flat'
      : deltaIsImprovement(delta.value, delta.direction)
        ? 'good'
        : 'bad';

  return (
    <p className="osa-metric-card__footnote">
      <span className={`osa-metric-card__delta osa-metric-card__delta--${tone}`}>
        {delta.formatted}
      </span>{' '}
      {delta.comparedTo}
    </p>
  );
};
