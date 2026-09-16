import type { AdoptionReport, StoreAdoption } from '../models/adoption';
import type { AsyncData } from '../models/async-data';
import { idle } from '../models/async-data';
import type {
  AvailabilityIndexReport,
  AvailabilityRecord,
  AvailabilityRecordSort,
} from '../models/availability';
import { DEFAULT_AVAILABILITY_RECORD_SORT } from '../models/availability';
import type { DepartmentalOutcome } from '../models/departmental';
import type { QueueId, RetailerId } from '../models/ids';
import type { Page } from '../models/paging';
import type { ReportScope } from '../models/scope';
import type {
  DetectionToResolutionReport,
  ResolvedGapRateReport,
  TaskWorkRateReport,
} from '../models/task-performance';
import type { TaskQueueFilter, TaskQueueItem, TaskQueueSort, TaskQueueSummary } from '../models/task-queue';
import type { Instant } from '../models/time';
import { DAY, minus, timeWindow } from '../models/time';

/**
 * Everything the dashboard fetches, one slice per request.
 *
 * Grouped into its own type so the reducer can act on any slice generically —
 * "this request started", "this request settled" — instead of repeating the same
 * three transitions nine times, once per report.
 */
export interface AsyncSlices {
  readonly availabilityIndex: AsyncData<AvailabilityIndexReport>;
  readonly availabilityRecords: AsyncData<Page<AvailabilityRecord>>;
  readonly taskWorkRate: AsyncData<TaskWorkRateReport>;
  readonly resolvedGapRate: AsyncData<ResolvedGapRateReport>;
  readonly detectionToResolution: AsyncData<DetectionToResolutionReport>;
  readonly adoption: AsyncData<AdoptionReport>;
  readonly storeAdoption: AsyncData<readonly StoreAdoption[]>;
  readonly departmentalOutcomes: AsyncData<readonly DepartmentalOutcome[]>;
  readonly taskQueues: AsyncData<readonly TaskQueueSummary[]>;
  readonly taskQueueItems: AsyncData<Page<TaskQueueItem>>;
}

export type SliceName = keyof AsyncSlices;

export const SLICE_NAMES = [
  'availabilityIndex',
  'availabilityRecords',
  'taskWorkRate',
  'resolvedGapRate',
  'detectionToResolution',
  'adoption',
  'storeAdoption',
  'departmentalOutcomes',
  'taskQueues',
  'taskQueueItems',
] as const satisfies readonly SliceName[];

/** The value a slice carries once it has loaded. */
export type SliceValue<S extends SliceName> = AsyncSlices[S] extends AsyncData<infer T> ? T : never;

export interface DashboardState extends AsyncSlices {
  /**
   * What every report is asked for. Changing it invalidates every slice at
   * once, which is why it lives here and not in each panel: two panels reading
   * different windows would produce a dashboard that quietly contradicts itself.
   */
  readonly scope: ReportScope;

  /**
   * The dashboard's clock, advanced by an explicit tick.
   *
   * Ages ("open 3h", "loaded 40s ago") are computed against this rather than
   * `Date.now()` so the reducer and every selector stay pure, and so a test can
   * assert on an age without waiting for one.
   */
  readonly now: Instant;

  readonly selectedQueueId: QueueId | null;
  readonly queueFilter: TaskQueueFilter;
  readonly queueSort: TaskQueueSort;
  readonly recordSort: AvailabilityRecordSort;

  /** Handed out to the next request so a late response can be told from a current one. */
  readonly nextRequestId: number;
}

export const initialQueueFilter = (retailerId: RetailerId): TaskQueueFilter => ({
  retailerId,
  storeIds: null,
  taskTypes: null,
  statuses: null,
  priorities: null,
  unassignedOnly: false,
});

/** The last 24 hours, hourly, cut by department — the shift a manager is working. */
export const initialScope = (retailerId: RetailerId, now: Instant): ReportScope => ({
  retailerId,
  storeIds: null,
  productIds: null,
  window: timeWindow(minus(now, DAY), now),
  granularity: 'hour',
  breakdownBy: ['department'],
});

export const initialState = (retailerId: RetailerId, now: Instant): DashboardState => ({
  availabilityIndex: idle(),
  availabilityRecords: idle(),
  taskWorkRate: idle(),
  resolvedGapRate: idle(),
  detectionToResolution: idle(),
  adoption: idle(),
  storeAdoption: idle(),
  departmentalOutcomes: idle(),
  taskQueues: idle(),
  taskQueueItems: idle(),
  scope: initialScope(retailerId, now),
  now,
  selectedQueueId: null,
  queueFilter: initialQueueFilter(retailerId),
  queueSort: 'priority_desc',
  recordSort: DEFAULT_AVAILABILITY_RECORD_SORT,
  nextRequestId: 1,
});

/**
 * Slices a scope change invalidates.
 *
 * The live task queues are deliberately absent: they are "what is open right
 * now", not a report over the window, so re-requesting them because someone
 * moved the date range would be work for an identical answer.
 */
export const SCOPED_SLICES = [
  'availabilityIndex',
  'availabilityRecords',
  'taskWorkRate',
  'resolvedGapRate',
  'detectionToResolution',
  'adoption',
  'storeAdoption',
  'departmentalOutcomes',
] as const satisfies readonly SliceName[];
