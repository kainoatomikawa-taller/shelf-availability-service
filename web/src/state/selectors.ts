import type { AdoptionPoint } from '../models/adoption';
import type { AsyncData } from '../models/async-data';
import { errorOf, isPending, isStale, valueOf } from '../models/async-data';
import type { AvailabilityIndexPoint } from '../models/availability';
import type { DepartmentalOutcome } from '../models/departmental';
import { compareOutcomesByIndex } from '../models/departmental';
import type { StatusLevel } from '../models/status';
import {
  ACKNOWLEDGEMENT_RATE_THRESHOLDS,
  AVAILABILITY_INDEX_THRESHOLDS,
  COVERAGE_THRESHOLDS,
  DETECTION_TO_VERIFICATION_THRESHOLDS,
  RESOLVED_GAP_RATE_THRESHOLDS,
  evaluateStatus,
  worstStatus,
} from '../models/status';
import type { DetectionToResolutionPoint, ResolvedGapRatePoint } from '../models/task-performance';
import type { TaskQueueSummary } from '../models/task-queue';
import { compareQueuesByUrgency } from '../models/task-queue';
import type { ServiceError } from '../services/errors';
import { isUserVisible } from '../services/errors';
import type { DashboardState, SliceName } from './dashboard-state';
import { SLICE_NAMES } from './dashboard-state';

/**
 * Reads derived from state, kept out of components.
 *
 * A selector is where a rule about *what a number means* lives — that a null
 * index is `unknown` rather than `good`, that queues sort by urgency rather than
 * size. Putting those in components would mean two panels answering the same
 * question differently, which is precisely how a dashboard loses its authority.
 */

export const selectScope = (state: DashboardState): DashboardState['scope'] => state.scope;

export const selectSlice = <S extends SliceName>(state: DashboardState, slice: S): AsyncData<unknown> =>
  state[slice];

/** The headline availability figure for the whole window, if it has loaded. */
export const selectAvailabilityOverall = (
  state: DashboardState,
): AvailabilityIndexPoint | null => valueOf(state.availabilityIndex)?.overall ?? null;

export const selectAvailabilityStatus = (state: DashboardState): StatusLevel => {
  const overall = selectAvailabilityOverall(state);
  if (overall === null) return 'unknown';
  // Coverage grades the *trust* in the index, not the index itself, so the card
  // reports whichever is worse: a 99% index over 20% of the window is not a 99%
  // index, and showing it as "on target" would be the dashboard's own error.
  return worstStatus([
    evaluateStatus(overall.index, AVAILABILITY_INDEX_THRESHOLDS),
    evaluateStatus(overall.coverage, COVERAGE_THRESHOLDS),
  ]);
};

export const selectAvailabilitySeries = (
  state: DashboardState,
): readonly AvailabilityIndexPoint[] => valueOf(state.availabilityIndex)?.series ?? [];

export const selectResolvedGapOverall = (state: DashboardState): ResolvedGapRatePoint | null =>
  valueOf(state.resolvedGapRate)?.overall ?? null;

export const selectResolvedGapStatus = (state: DashboardState): StatusLevel =>
  evaluateStatus(selectResolvedGapOverall(state)?.resolvedGapRate ?? null, RESOLVED_GAP_RATE_THRESHOLDS);

export const selectLatencyOverall = (state: DashboardState): DetectionToResolutionPoint | null =>
  valueOf(state.detectionToResolution)?.overall ?? null;

export const selectLoopLatencyStatus = (state: DashboardState): StatusLevel =>
  evaluateStatus(
    selectLatencyOverall(state)?.detectionToVerification.p50 ?? null,
    DETECTION_TO_VERIFICATION_THRESHOLDS,
  );

export const selectAdoptionOverall = (state: DashboardState): AdoptionPoint | null =>
  valueOf(state.adoption)?.overall ?? null;

export const selectAdoptionStatus = (state: DashboardState): StatusLevel =>
  evaluateStatus(
    selectAdoptionOverall(state)?.acknowledgementRate ?? null,
    ACKNOWLEDGEMENT_RATE_THRESHOLDS,
  );

/** Queues worst-first. The order a manager should work them in. */
export const selectQueuesByUrgency = (state: DashboardState): readonly TaskQueueSummary[] =>
  [...(valueOf(state.taskQueues) ?? [])].sort(compareQueuesByUrgency);

export const selectSelectedQueue = (state: DashboardState): TaskQueueSummary | null =>
  valueOf(state.taskQueues)?.find((queue) => queue.queueId === state.selectedQueueId) ?? null;

/** Departments worst-first, unmeasured last. */
export const selectDepartmentsByIndex = (
  state: DashboardState,
): readonly DepartmentalOutcome[] =>
  [...(valueOf(state.departmentalOutcomes) ?? [])].sort(compareOutcomesByIndex);

/** Departments excluded from the service-level commitment, and why. */
export const selectExcludedDepartments = (
  state: DashboardState,
): readonly DepartmentalOutcome[] =>
  (valueOf(state.departmentalOutcomes) ?? []).filter((outcome) => !outcome.serviceLevel.inScope);

export const selectIsAnyPending = (state: DashboardState): boolean =>
  SLICE_NAMES.some((slice) => isPending(state[slice]));

export const selectIsAnyStale = (state: DashboardState): boolean =>
  SLICE_NAMES.some((slice) => isStale(state[slice]));

/**
 * Every failure worth telling someone about, with the slice that produced it.
 *
 * Cancellations are filtered out here rather than at each call site: they are
 * this layer's own bookkeeping and have no business appearing in a banner.
 */
export const selectErrors = (
  state: DashboardState,
): readonly { readonly slice: SliceName; readonly error: ServiceError }[] =>
  SLICE_NAMES.flatMap((slice) => {
    const error = errorOf(state[slice]);
    return error !== null && isUserVisible(error) ? [{ slice, error }] : [];
  });
