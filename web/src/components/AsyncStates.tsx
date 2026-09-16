import type { ReactNode } from 'react';
import type { AsyncData } from '../models/async-data';
import { errorOf, heldValue, isPending, isStale } from '../models/async-data';
import { formatAge } from '../models/format';
import type { Instant } from '../models/time';
import type { ServiceError } from '../services/errors';
import { describeServiceError, isUserVisible } from '../services/errors';

export interface SkeletonProps {
  /** Rendered as a proportion of the container width, so it reads as a real row. */
  readonly width?: string;
  readonly height?: string;
  readonly label?: string;
}

/** A placeholder with the shape of the thing it is standing in for. */
export const Skeleton = ({ width = '100%', height = '1em', label = 'Loading' }: SkeletonProps) => (
  <span className="osa-skeleton" style={{ width, height, display: 'block' }} role="status">
    <span className="osa-visually-hidden">{label}</span>
  </span>
);

export interface ErrorPanelProps {
  readonly error: ServiceError;
  readonly onRetry?: (() => void) | undefined;
}

/**
 * A failure, in words the reader can act on.
 *
 * The retry affordance appears only when retrying could actually work: offering
 * "try again" against a schema mismatch or a 403 invites someone to click it
 * five times and conclude the dashboard is broken, which it is — just not in a
 * way clicking fixes.
 */
export const ErrorPanel = ({ error, onRetry }: ErrorPanelProps) => {
  const presentation = describeServiceError(error);
  return (
    <div className="osa-error" role="alert">
      <p className="osa-error__title">{presentation.title}</p>
      <p className="osa-error__detail">{presentation.detail}</p>
      {presentation.retryable && onRetry !== undefined ? (
        <button type="button" className="osa-button" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
};

export interface EmptyStateProps {
  readonly message: string;
}

export const EmptyState = ({ message }: EmptyStateProps) => (
  <p className="osa-empty">{message}</p>
);

export interface StaleNoticeProps {
  readonly loadedAt: Instant;
  readonly now: Instant;
}

/** Says out loud that the figure on screen is not the latest attempt's. */
export const StaleNotice = ({ loadedAt, now }: StaleNoticeProps) => (
  <span className="osa-stale">
    <span aria-hidden="true">◌</span> Showing data from {formatAge(loadedAt, now)}
  </span>
);

export interface AsyncBoundaryProps<T> {
  readonly data: AsyncData<T>;
  readonly now: Instant;
  readonly children: (value: T) => ReactNode;
  /** Shown while loading with nothing to keep on screen. */
  readonly fallback?: ReactNode;
  readonly empty?: ReactNode;
  readonly onRetry?: (() => void) | undefined;
  /** Treat a loaded-but-empty value as the empty state. */
  readonly isEmpty?: (value: T) => boolean;
}

/**
 * The one place the async states are branched on.
 *
 * The ordering is the whole design: a held value wins over a pending request, so
 * a refresh never blanks the panel, and a failure that has a previous value
 * keeps showing it with a stale notice rather than replacing a real number with
 * an error box. A panel that has nothing yet gets the skeleton; a panel that has
 * nothing and failed gets the error.
 */
export const AsyncBoundary = <T,>({
  data,
  now,
  children,
  fallback,
  empty,
  onRetry,
  isEmpty,
}: AsyncBoundaryProps<T>) => {
  const held = heldValue(data);
  const error = errorOf(data);

  if (held === null) {
    if (error !== null && isUserVisible(error)) {
      return <ErrorPanel error={error} onRetry={onRetry} />;
    }
    if (isPending(data)) return <>{fallback ?? <Skeleton height="4em" />}</>;
    return <>{empty ?? <EmptyState message="Nothing to show yet." />}</>;
  }

  if (isEmpty?.(held.value) === true) {
    return <>{empty ?? <EmptyState message="No rows for this scope." />}</>;
  }

  return (
    <>
      {children(held.value)}
      {isStale(data) ? <StaleNotice loadedAt={held.loadedAt} now={now} /> : null}
      {error !== null && isUserVisible(error) ? (
        <ErrorPanel error={error} onRetry={onRetry} />
      ) : null}
    </>
  );
};
