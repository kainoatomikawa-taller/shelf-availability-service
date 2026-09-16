/**
 * Compile-time proof that the dashboard's view models still line up with the
 * service's published read ports.
 *
 * The models in `src/models` are written out explicitly rather than derived from
 * the domain package — the same rule the ports themselves follow for their wire
 * payloads, and for the same reason: a published contract must not shift
 * silently under an internal refactor. The cost of that rule is duplication, and
 * this file is the payment: if the service adds, removes or renames a field on a
 * report, or gains a member in a closed union, the build fails here with the
 * type that moved.
 *
 * The comparison is on *keys and union members*, not full structural identity.
 * The two sides brand their ids and instants independently (the service holds
 * `Instant` as epoch millis, the dashboard parses ISO-8601 into its own brand),
 * so a structural check would fail on every field for reasons that are by
 * design. Keys and members are the part that actually drifts.
 *
 * Nothing here is imported at runtime: the domain types are `import type` only,
 * so no service code is bundled into the dashboard.
 */
import type {
  AvailabilityIndexPoint as PortAvailabilityIndexPoint,
  AvailabilityIndexReport as PortAvailabilityIndexReport,
  AvailabilityRecord as PortAvailabilityRecord,
  AvailabilityRecordQuery as PortAvailabilityRecordQuery,
  AvailabilityRecordSort as PortAvailabilityRecordSort,
  DetectionToResolutionPoint as PortDetectionToResolutionPoint,
  DurationDistribution as PortDurationDistribution,
  ReportBreakdown as PortReportBreakdown,
  ReportDimension as PortReportDimension,
  ReportGranularity as PortReportGranularity,
  ReportScope as PortReportScope,
  ResolvedGapRatePoint as PortResolvedGapRatePoint,
  TaskWorkRatePoint as PortTaskWorkRatePoint,
} from '@osa/ports/inbound/reporting.port.js';
import type { Page as PortPage, PageRequest as PortPageRequest } from '@osa/ports/common/paging.js';
import type { FacingLocation as PortFacingLocation } from '@osa/domain/facing/facing.js';
import type { ShelfState as PortShelfState } from '@osa/domain/facing/shelf-state.js';
import type { SignalSource as PortSignalSource } from '@osa/domain/facing/signals.js';
import type { LedColor as PortLedColor } from '@osa/domain/task/color-lane.js';
import type { TaskStatus as PortTaskStatus } from '@osa/domain/task/task-state.js';
import type { TaskPriority as PortTaskPriority, TaskType as PortTaskType } from '@osa/domain/task/task-type.js';

import type {
  AvailabilityIndexPoint,
  AvailabilityIndexReport,
  AvailabilityRecord,
  AvailabilityRecordQuery,
  AvailabilityRecordSort,
  FacingLocation,
} from '../models/availability';
import type { LedColor, ShelfState, SignalSource, TaskPriority, TaskStatus, TaskType } from '../models/enums';
import type { Page, PageRequest } from '../models/paging';
import type { ReportBreakdown, ReportDimension, ReportGranularity, ReportScope } from '../models/scope';
import type {
  DetectionToResolutionPoint,
  DurationDistribution,
  ResolvedGapRatePoint,
  TaskWorkRatePoint,
} from '../models/task-performance';

/** Fails to satisfy its constraint — and so fails the build — unless `T` is `true`. */
type Assert<T extends true> = T;

type Keys<T> = Extract<keyof T, string>;

/**
 * `true` when both sides carry exactly the same field names, otherwise an object
 * naming what is missing on each side — which is what the compiler prints.
 */
type SameKeys<Port, View> =
  [Exclude<Keys<Port>, Keys<View>>] extends [never]
    ? [Exclude<Keys<View>, Keys<Port>>] extends [never]
      ? true
      : { readonly dashboardHasFieldsTheServiceDoesNot: Exclude<Keys<View>, Keys<Port>> }
    : { readonly serviceHasFieldsTheDashboardDoesNot: Exclude<Keys<Port>, Keys<View>> };

/** The same check for a closed string union. */
type SameMembers<Port extends string, View extends string> =
  [Exclude<Port, View>] extends [never]
    ? [Exclude<View, Port>] extends [never]
      ? true
      : { readonly dashboardHasMembersTheServiceDoesNot: Exclude<View, Port> }
    : { readonly serviceHasMembersTheDashboardDoesNot: Exclude<Port, View> };

// --- Report shapes ---------------------------------------------------------

export type ReportScopeConformance = Assert<SameKeys<PortReportScope, ReportScope>>;
export type ReportBreakdownConformance = Assert<
  SameKeys<PortReportBreakdown<unknown>, ReportBreakdown<unknown>>
>;
export type AvailabilityIndexPointConformance = Assert<
  SameKeys<PortAvailabilityIndexPoint, AvailabilityIndexPoint>
>;
export type AvailabilityIndexReportConformance = Assert<
  SameKeys<PortAvailabilityIndexReport, AvailabilityIndexReport>
>;
export type AvailabilityRecordConformance = Assert<
  SameKeys<PortAvailabilityRecord, AvailabilityRecord>
>;
export type AvailabilityRecordQueryConformance = Assert<
  SameKeys<PortAvailabilityRecordQuery, AvailabilityRecordQuery>
>;
export type TaskWorkRatePointConformance = Assert<
  SameKeys<PortTaskWorkRatePoint, TaskWorkRatePoint>
>;
export type ResolvedGapRatePointConformance = Assert<
  SameKeys<PortResolvedGapRatePoint, ResolvedGapRatePoint>
>;
export type DurationDistributionConformance = Assert<
  SameKeys<PortDurationDistribution, DurationDistribution>
>;
export type DetectionToResolutionPointConformance = Assert<
  SameKeys<PortDetectionToResolutionPoint, DetectionToResolutionPoint>
>;
export type FacingLocationConformance = Assert<SameKeys<PortFacingLocation, FacingLocation>>;
export type PageConformance = Assert<SameKeys<PortPage<unknown>, Page<unknown>>>;
export type PageRequestConformance = Assert<SameKeys<PortPageRequest, PageRequest>>;

// --- Closed unions ---------------------------------------------------------

export type ReportGranularityConformance = Assert<
  SameMembers<PortReportGranularity, ReportGranularity>
>;
export type ReportDimensionConformance = Assert<SameMembers<PortReportDimension, ReportDimension>>;
export type AvailabilityRecordSortConformance = Assert<
  SameMembers<PortAvailabilityRecordSort, AvailabilityRecordSort>
>;
export type ShelfStateConformance = Assert<SameMembers<PortShelfState, ShelfState>>;
export type SignalSourceConformance = Assert<SameMembers<PortSignalSource, SignalSource>>;
export type TaskTypeConformance = Assert<SameMembers<PortTaskType, TaskType>>;
export type TaskPriorityConformance = Assert<SameMembers<PortTaskPriority, TaskPriority>>;
export type TaskStatusConformance = Assert<SameMembers<PortTaskStatus, TaskStatus>>;
export type LedColorConformance = Assert<SameMembers<PortLedColor, LedColor>>;
