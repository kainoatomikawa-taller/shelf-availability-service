import type { AdoptionPoint, AdoptionReport, StoreAdoption } from '../models/adoption';
import type {
  AvailabilityIndexPoint,
  AvailabilityIndexReport,
  AvailabilityRecord,
} from '../models/availability';
import type { DepartmentalOutcome } from '../models/departmental';
import {
  categoryId,
  departmentId,
  employeeId,
  facingId,
  productId,
  queueId,
  retailerId,
  storeId,
  taskId,
} from '../models/ids';
import type { RetailerId } from '../models/ids';
import type { Page } from '../models/paging';
import type { ReportBreakdown } from '../models/scope';
import type {
  DetectionToResolutionPoint,
  DetectionToResolutionReport,
  DurationDistribution,
  ResolvedGapRatePoint,
  ResolvedGapRateReport,
  TaskWorkRatePoint,
  TaskWorkRateReport,
} from '../models/task-performance';
import type { TaskQueueItem, TaskQueueSummary } from '../models/task-queue';
import { emptyPriorityCounts } from '../models/task-queue';
import type { Instant, Millis, Ratio, TimeWindow } from '../models/time';
import { HOUR, MINUTE, instant, millis, minus, plus, ratio, timeWindow } from '../models/time';

/**
 * Sample data for rendering every shared component in isolation.
 *
 * Deterministic, so the gallery and the tests show the same numbers on every
 * run, and so a visual change is attributable to the code rather than to the
 * dice. The shapes are built through the same branding constructors the
 * decoders use, which means a fixture cannot drift from the model it stands in
 * for without failing to compile.
 *
 * The values are chosen to exercise the cases that are easy to get wrong, not to
 * look tidy: there are null measurements, a department with no service-level
 * commitment, a retailer with no labour feed, and a bucket where coverage is too
 * thin to trust the index computed from it.
 */

export const SAMPLE_RETAILER: RetailerId = retailerId('rt-northfield');
export const SAMPLE_NOW: Instant = instant(Date.UTC(2026, 8, 15, 18, 0, 0));

/** Deterministic pseudo-random in [0, 1). A small LCG — no dependency, same series every run. */
const sequence = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
};

const hourlyWindows = (end: Instant, count: number): readonly TimeWindow[] =>
  Array.from({ length: count }, (_, index) => {
    const from = minus(end, millis((count - index) * HOUR));
    return timeWindow(from, plus(from, HOUR));
  });

export const SAMPLE_WINDOW: TimeWindow = timeWindow(minus(SAMPLE_NOW, millis(24 * HOUR)), SAMPLE_NOW);

const WINDOWS = hourlyWindows(SAMPLE_NOW, 24);

const clampRatio = (value: number): Ratio => ratio(Math.min(1, Math.max(0, value)));

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

const availabilityPoint = (
  window: TimeWindow,
  index: number | null,
  coverage: number,
): AvailabilityIndexPoint => {
  const measured = millis(Math.round(420 * HOUR * coverage));
  return {
    window,
    index: index === null ? null : clampRatio(index),
    coverage: clampRatio(coverage),
    inStockFacingMillis: millis(Math.round(measured * (index ?? 0))),
    measuredFacingMillis: measured,
    unknownFacingMillis: millis(Math.round(420 * HOUR * (1 - coverage))),
    facingCount: 420,
  };
};

export const sampleAvailabilitySeries = (): readonly AvailabilityIndexPoint[] => {
  const next = sequence(19);
  return WINDOWS.map((window, hour) => {
    // Overnight hours have no shopper traffic and no cart passes, so nothing is
    // measured and the index is null — not zero. This is the case the whole
    // dashboard is built to render honestly.
    const utcHour = new Date(window.from).getUTCHours();
    if (utcHour >= 1 && utcHour <= 4) return availabilityPoint(window, null, 0.04);
    const base = 0.972 - (hour > 14 ? 0.03 : 0) + next() * 0.014;
    return availabilityPoint(window, base, 0.62 + next() * 0.3);
  });
};

export const sampleAvailabilityIndexReport = (): AvailabilityIndexReport => {
  const series = sampleAvailabilitySeries();
  return {
    retailerId: SAMPLE_RETAILER,
    window: SAMPLE_WINDOW,
    granularity: 'hour',
    overall: availabilityPoint(SAMPLE_WINDOW, 0.9683, 0.78),
    series,
    breakdowns: sampleAvailabilityBreakdowns(),
    computedAt: SAMPLE_NOW,
  };
};

const sampleAvailabilityBreakdowns = (): readonly ReportBreakdown<AvailabilityIndexPoint>[] => [
  {
    dimension: 'department',
    key: 'dp-produce',
    label: 'Produce',
    value: availabilityPoint(SAMPLE_WINDOW, 0.9412, 0.84),
  },
  {
    dimension: 'department',
    key: 'dp-chilled',
    label: 'Chilled',
    value: availabilityPoint(SAMPLE_WINDOW, 0.9771, 0.81),
  },
  {
    dimension: 'department',
    key: 'dp-ambient',
    label: 'Ambient grocery',
    value: availabilityPoint(SAMPLE_WINDOW, 0.9865, 0.74),
  },
  {
    dimension: 'department',
    key: 'dp-bakery',
    label: 'Bakery',
    // Nothing measured: bakery sits outside every camera line in this store.
    value: availabilityPoint(SAMPLE_WINDOW, null, 0.06),
  },
];

export const sampleAvailabilityRecords = (): Page<AvailabilityRecord> => {
  const next = sequence(7);
  const items = SAMPLE_FACINGS.map((facing, position) => {
    const outOfStock = millis(Math.round(next() * 6 * HOUR));
    const unknown = millis(Math.round(next() * 3 * HOUR));
    const measured = millis(24 * HOUR - unknown);
    const inStock = millis(Math.max(0, measured - outOfStock));
    return {
      retailerId: SAMPLE_RETAILER,
      storeId: storeId(facing.store),
      facingId: facingId(facing.facing),
      productId: productId(facing.product),
      location: { aisle: facing.aisle, bay: facing.bay, shelf: 3, position: position + 1 },
      window: SAMPLE_WINDOW,
      stateAtWindowStart: 'in_stock' as const,
      stateAtWindowEnd: outOfStock > 3 * HOUR ? ('out_of_stock' as const) : ('in_stock' as const),
      inStockMillis: inStock,
      outOfStockMillis: outOfStock,
      unknownMillis: unknown,
      measuredMillis: measured,
      coverage: clampRatio(measured / (24 * HOUR)),
      index: measured === 0 ? null : clampRatio(inStock / measured),
      gapCount: Math.round(next() * 4),
      contributingSources: facing.sources,
    } satisfies AvailabilityRecord;
  });

  return { items, nextCursor: null, totalEstimate: 1_240 };
};

const SAMPLE_FACINGS = [
  {
    store: 'st-0142',
    facing: 'fc-88201',
    product: 'sku-4410092',
    aisle: '12',
    bay: 'C',
    sources: ['arpalus_detection', 'shopper_scan'] as const,
  },
  {
    store: 'st-0142',
    facing: 'fc-88214',
    product: 'sku-4410518',
    aisle: '12',
    bay: 'D',
    sources: ['caper_frame', 'pos_movement'] as const,
  },
  {
    store: 'st-0142',
    facing: 'fc-90312',
    product: 'sku-2210044',
    aisle: '04',
    bay: 'A',
    sources: ['arpalus_detection'] as const,
  },
  {
    store: 'st-0287',
    facing: 'fc-11907',
    product: 'sku-7781200',
    aisle: '21',
    bay: 'B',
    sources: ['carrot_tag_label', 'planogram_record'] as const,
  },
  {
    store: 'st-0287',
    facing: 'fc-11955',
    product: 'sku-7781344',
    aisle: '21',
    bay: 'B',
    sources: ['shopper_scan'] as const,
  },
] as const;

// ---------------------------------------------------------------------------
// Task work rate
// ---------------------------------------------------------------------------

const workRatePoint = (window: TimeWindow, created: number, verified: number): TaskWorkRatePoint => ({
  window,
  created,
  assigned: Math.round(created * 0.94),
  acknowledged: Math.round(created * 0.88),
  resolved: Math.round(verified * 1.12),
  verified,
  reopened: Math.max(0, Math.round(verified * 0.07)),
  cancelled: Math.round(created * 0.03),
  expired: Math.round(created * 0.02),
  outstanding: Math.max(0, created - verified),
  // This retailer has no workforce feed connected, so labour is null throughout
  // rather than estimated — and every card reading it has to say so.
  labourHours: null,
  tasksPerLabourHour: null,
  completionRate: created === 0 ? null : clampRatio(verified / created),
  reworkRate: verified === 0 ? null : clampRatio(0.07),
});

export const sampleTaskWorkRateReport = (): TaskWorkRateReport => {
  const next = sequence(31);
  const series = WINDOWS.map((window) => {
    const created = Math.round(6 + next() * 22);
    return workRatePoint(window, created, Math.round(created * (0.76 + next() * 0.18)));
  });
  return {
    retailerId: SAMPLE_RETAILER,
    window: SAMPLE_WINDOW,
    granularity: 'hour',
    overall: workRatePoint(SAMPLE_WINDOW, 341, 289),
    series,
    breakdowns: [
      {
        dimension: 'task_type',
        key: 'restock_out_of_stock',
        label: 'Restock out of stock',
        value: workRatePoint(SAMPLE_WINDOW, 208, 181),
      },
      {
        dimension: 'task_type',
        key: 'replenish_low_stock',
        label: 'Replenish low stock',
        value: workRatePoint(SAMPLE_WINDOW, 96, 82),
      },
      {
        dimension: 'task_type',
        key: 'price_label_correction',
        label: 'Price label correction',
        value: workRatePoint(SAMPLE_WINDOW, 37, 26),
      },
    ],
    computedAt: SAMPLE_NOW,
  };
};

// ---------------------------------------------------------------------------
// Resolved-gap rate
// ---------------------------------------------------------------------------

const gapRatePoint = (
  window: TimeWindow,
  detected: number,
  verified: number,
  awaiting: number,
): ResolvedGapRatePoint => {
  const denominator = Math.max(0, detected - awaiting);
  return {
    window,
    detectedGaps: detected,
    taskedGaps: Math.round(detected * 0.91),
    resolvedGaps: verified + awaiting,
    verifiedGaps: verified,
    selfResolvedGaps: Math.round(detected * 0.06),
    unresolvedGaps: Math.max(0, denominator - verified),
    awaitingVerification: awaiting,
    taskedGapRate: detected === 0 ? null : clampRatio(0.91),
    // Null when everything detected is still inside its verification window —
    // the case the rate's definition exists to keep from understating it.
    resolvedGapRate: denominator === 0 ? null : clampRatio(verified / denominator),
  };
};

export const sampleResolvedGapRateReport = (): ResolvedGapRateReport => {
  const next = sequence(53);
  const series = WINDOWS.map((window, hour) => {
    const detected = Math.round(4 + next() * 14);
    // The most recent buckets are dominated by gaps still inside the 24h
    // verification window, so their rate is thin or absent by construction.
    const awaiting = hour >= 20 ? Math.round(detected * (0.5 + next() * 0.5)) : Math.round(detected * 0.08);
    const denominator = Math.max(0, detected - awaiting);
    return gapRatePoint(window, detected, Math.round(denominator * (0.8 + next() * 0.15)), awaiting);
  });
  return {
    retailerId: SAMPLE_RETAILER,
    window: SAMPLE_WINDOW,
    granularity: 'hour',
    overall: gapRatePoint(SAMPLE_WINDOW, 214, 161, 32),
    series,
    breakdowns: [],
    computedAt: SAMPLE_NOW,
  };
};

// ---------------------------------------------------------------------------
// Detection to resolution
// ---------------------------------------------------------------------------

const distribution = (p50: number, sampleSize = 180): DurationDistribution => ({
  sampleSize,
  p50: millis(p50),
  p90: millis(Math.round(p50 * 2.4)),
  p99: millis(Math.round(p50 * 5.1)),
  mean: millis(Math.round(p50 * 1.3)),
  max: millis(Math.round(p50 * 9)),
});

const emptyDistribution: DurationDistribution = {
  sampleSize: 0,
  p50: null,
  p90: null,
  p99: null,
  mean: null,
  max: null,
};

const latencyPoint = (window: TimeWindow, acknowledgeLag: Millis): DetectionToResolutionPoint => ({
  window,
  detectionToTask: distribution(4 * MINUTE),
  taskToAssignment: distribution(11 * MINUTE),
  assignmentToAcknowledgement: distribution(acknowledgeLag),
  acknowledgementToResolution: distribution(26 * MINUTE),
  resolutionToVerification: distribution(3 * HOUR + 40 * MINUTE),
  detectionToVerification: distribution(5 * HOUR + 12 * MINUTE),
  detectionToBackInStock: distribution(1 * HOUR + 48 * MINUTE),
});

export const sampleDetectionToResolutionReport = (): DetectionToResolutionReport => {
  const next = sequence(71);
  const series = WINDOWS.map((window, hour) =>
    // Nothing completes the loop overnight: no staff on the floor, so no
    // acknowledgements and no percentiles at all.
    hour >= 6 && hour <= 10
      ? { ...latencyPoint(window, millis(0)), assignmentToAcknowledgement: emptyDistribution }
      : latencyPoint(window, millis(Math.round((18 + next() * 40) * MINUTE))),
  );
  return {
    retailerId: SAMPLE_RETAILER,
    window: SAMPLE_WINDOW,
    granularity: 'hour',
    overall: latencyPoint(SAMPLE_WINDOW, millis(34 * MINUTE)),
    series,
    breakdowns: [],
    computedAt: SAMPLE_NOW,
  };
};

// ---------------------------------------------------------------------------
// Adoption
// ---------------------------------------------------------------------------

const adoptionPoint = (
  window: TimeWindow,
  activeStores: number,
  acknowledgementRate: number,
): AdoptionPoint => ({
  window,
  enrolledStores: 12,
  activeStores,
  enrolledEmployees: 486,
  activeEmployees: Math.round(486 * (activeStores / 12) * 0.42),
  storeActivationRate: clampRatio(activeStores / 12),
  employeeActivationRate: clampRatio((activeStores / 12) * 0.42),
  tasksAcknowledged: Math.round(341 * acknowledgementRate),
  tasksDispatched: 341,
  acknowledgementRate: clampRatio(acknowledgementRate),
  medianAcknowledgementLag: millis(34 * MINUTE),
  tasksClosedInApp: Math.round(341 * acknowledgementRate * 0.83),
  appSessions: Math.round(activeStores * 21),
});

export const sampleAdoptionReport = (): AdoptionReport => {
  const next = sequence(97);
  return {
    retailerId: SAMPLE_RETAILER,
    window: SAMPLE_WINDOW,
    granularity: 'hour',
    overall: adoptionPoint(SAMPLE_WINDOW, 9, 0.812),
    series: WINDOWS.map((window) => adoptionPoint(window, 7 + Math.round(next() * 5), 0.74 + next() * 0.2)),
    breakdowns: [],
    computedAt: SAMPLE_NOW,
  };
};

export const sampleStoreAdoption = (): readonly StoreAdoption[] => [
  {
    storeId: storeId('st-0142'),
    storeName: 'Northfield Central',
    stage: 'active',
    enrolledEmployees: 62,
    activeEmployees: 41,
    acknowledgementRate: ratio(0.93),
    tasksAcknowledged: 118,
    medianAcknowledgementLag: millis(17 * MINUTE),
    lastActivityAt: minus(SAMPLE_NOW, millis(12 * MINUTE)),
  },
  {
    storeId: storeId('st-0287'),
    storeName: 'Northfield Riverside',
    stage: 'active',
    enrolledEmployees: 48,
    activeEmployees: 22,
    acknowledgementRate: ratio(0.78),
    tasksAcknowledged: 74,
    medianAcknowledgementLag: millis(41 * MINUTE),
    lastActivityAt: minus(SAMPLE_NOW, millis(2 * HOUR)),
  },
  {
    storeId: storeId('st-0311'),
    storeName: 'Eastgate',
    stage: 'onboarding',
    enrolledEmployees: 39,
    activeEmployees: 6,
    acknowledgementRate: ratio(0.31),
    tasksAcknowledged: 12,
    medianAcknowledgementLag: millis(3 * HOUR),
    lastActivityAt: minus(SAMPLE_NOW, millis(19 * HOUR)),
  },
  {
    storeId: storeId('st-0355'),
    storeName: 'Harbour Point',
    // Was working tasks, then stopped — the case that must never be collapsed
    // with "provisioned but never started", since the fix is the opposite.
    stage: 'dormant',
    enrolledEmployees: 44,
    activeEmployees: 0,
    acknowledgementRate: ratio(0),
    tasksAcknowledged: 0,
    medianAcknowledgementLag: null,
    lastActivityAt: minus(SAMPLE_NOW, millis(9 * 24 * HOUR)),
  },
  {
    storeId: storeId('st-0402'),
    storeName: 'Kingsway',
    stage: 'provisioned',
    enrolledEmployees: 51,
    activeEmployees: 0,
    acknowledgementRate: null,
    tasksAcknowledged: 0,
    medianAcknowledgementLag: null,
    lastActivityAt: null,
  },
];

// ---------------------------------------------------------------------------
// Departmental outcomes
// ---------------------------------------------------------------------------

export const sampleDepartmentalOutcomes = (): readonly DepartmentalOutcome[] => [
  {
    departmentId: departmentId('dp-produce'),
    departmentName: 'Produce',
    storeId: null,
    window: SAMPLE_WINDOW,
    availabilityIndex: ratio(0.9412),
    coverage: ratio(0.84),
    facingCount: 96,
    availabilityIndexDelta: -0.021,
    detectedGaps: 88,
    resolvedGapRate: ratio(0.71),
    awaitingVerification: 14,
    tasksCreated: 132,
    tasksVerified: 94,
    tasksOutstanding: 26,
    tasksPerLabourHour: null,
    reworkRate: ratio(0.11),
    medianDetectionToVerification: millis(6 * HOUR + 20 * MINUTE),
    serviceLevel: { inScope: true, density: 4.1 },
    computedAt: SAMPLE_NOW,
  },
  {
    departmentId: departmentId('dp-chilled'),
    departmentName: 'Chilled',
    storeId: null,
    window: SAMPLE_WINDOW,
    availabilityIndex: ratio(0.9771),
    coverage: ratio(0.81),
    facingCount: 128,
    availabilityIndexDelta: 0.006,
    detectedGaps: 54,
    resolvedGapRate: ratio(0.88),
    awaitingVerification: 9,
    tasksCreated: 78,
    tasksVerified: 66,
    tasksOutstanding: 8,
    tasksPerLabourHour: null,
    reworkRate: ratio(0.05),
    medianDetectionToVerification: millis(4 * HOUR + 5 * MINUTE),
    serviceLevel: { inScope: true, density: 3.4 },
    computedAt: SAMPLE_NOW,
  },
  {
    departmentId: departmentId('dp-ambient'),
    departmentName: 'Ambient grocery',
    storeId: null,
    window: SAMPLE_WINDOW,
    availabilityIndex: ratio(0.9865),
    coverage: ratio(0.74),
    facingCount: 164,
    availabilityIndexDelta: 0.002,
    detectedGaps: 61,
    resolvedGapRate: ratio(0.92),
    awaitingVerification: 7,
    tasksCreated: 89,
    tasksVerified: 79,
    tasksOutstanding: 6,
    tasksPerLabourHour: null,
    reworkRate: ratio(0.04),
    medianDetectionToVerification: millis(3 * HOUR + 50 * MINUTE),
    serviceLevel: { inScope: true, density: 2.9 },
    computedAt: SAMPLE_NOW,
  },
  {
    departmentId: departmentId('dp-homeware'),
    departmentName: 'Homeware',
    storeId: null,
    window: SAMPLE_WINDOW,
    availabilityIndex: ratio(0.9932),
    coverage: ratio(0.22),
    facingCount: 74,
    availabilityIndexDelta: null,
    detectedGaps: 4,
    resolvedGapRate: null,
    awaitingVerification: 4,
    tasksCreated: 5,
    tasksVerified: 0,
    tasksOutstanding: 5,
    tasksPerLabourHour: null,
    reworkRate: null,
    medianDetectionToVerification: null,
    // Measured, and it missed the two-passes-a-day bar: the loop physically
    // cannot close here, so it carries no commitment.
    serviceLevel: {
      inScope: false,
      reason: 'below_revisit_threshold',
      density: 0.8,
      required: 2,
    },
    computedAt: SAMPLE_NOW,
  },
  {
    departmentId: departmentId('dp-bakery'),
    departmentName: 'Bakery',
    storeId: null,
    window: SAMPLE_WINDOW,
    availabilityIndex: null,
    coverage: ratio(0.06),
    facingCount: 38,
    availabilityIndexDelta: null,
    detectedGaps: 0,
    resolvedGapRate: null,
    awaitingVerification: 0,
    tasksCreated: 0,
    tasksVerified: 0,
    tasksOutstanding: 0,
    tasksPerLabourHour: null,
    reworkRate: null,
    medianDetectionToVerification: null,
    // Not weighed at all — a different fact from failing the bar, and the row
    // has to say which.
    serviceLevel: { inScope: false, reason: 'unmeasured', density: null, required: 2 },
    computedAt: SAMPLE_NOW,
  },
];

export const SAMPLE_CATEGORY = categoryId('ct-salad');

// ---------------------------------------------------------------------------
// Task queues
// ---------------------------------------------------------------------------

export const sampleTaskQueues = (): readonly TaskQueueSummary[] => [
  {
    retailerId: SAMPLE_RETAILER,
    queueId: queueId('q-0142-restock'),
    storeId: storeId('st-0142'),
    label: 'Northfield Central · Restock',
    taskType: 'restock_out_of_stock',
    openCount: 34,
    unassignedCount: 11,
    breachingCount: 4,
    awaitingVerificationCount: 7,
    countsByPriority: { ...emptyPriorityCounts(), critical: 4, high: 12, normal: 15, low: 3 },
    countsByStatus: {
      created: 11,
      assigned: 9,
      acknowledged: 4,
      in_progress: 3,
      awaiting_verification: 7,
      verified: 128,
      reopened: 2,
      cancelled: 3,
      expired: 1,
    },
    oldestOpenAt: minus(SAMPLE_NOW, millis(5 * HOUR + 10 * MINUTE)),
    updatedAt: minus(SAMPLE_NOW, millis(2 * MINUTE)),
  },
  {
    retailerId: SAMPLE_RETAILER,
    queueId: queueId('q-0142-labels'),
    storeId: storeId('st-0142'),
    label: 'Northfield Central · Labels',
    taskType: 'price_label_correction',
    openCount: 19,
    unassignedCount: 19,
    breachingCount: 0,
    awaitingVerificationCount: 0,
    countsByPriority: { ...emptyPriorityCounts(), normal: 14, low: 5 },
    countsByStatus: {
      created: 19,
      assigned: 0,
      acknowledged: 0,
      in_progress: 0,
      awaiting_verification: 0,
      verified: 41,
      reopened: 0,
      cancelled: 0,
      expired: 0,
    },
    oldestOpenAt: minus(SAMPLE_NOW, millis(90 * MINUTE)),
    updatedAt: minus(SAMPLE_NOW, millis(6 * MINUTE)),
  },
  {
    retailerId: SAMPLE_RETAILER,
    queueId: queueId('q-0287-mixed'),
    storeId: storeId('st-0287'),
    label: 'Riverside · All work',
    taskType: null,
    openCount: 8,
    unassignedCount: 2,
    breachingCount: 0,
    awaitingVerificationCount: 3,
    countsByPriority: { ...emptyPriorityCounts(), high: 2, normal: 6 },
    countsByStatus: {
      created: 2,
      assigned: 2,
      acknowledged: 1,
      in_progress: 0,
      awaiting_verification: 3,
      verified: 57,
      reopened: 1,
      cancelled: 0,
      expired: 0,
    },
    oldestOpenAt: minus(SAMPLE_NOW, millis(40 * MINUTE)),
    updatedAt: minus(SAMPLE_NOW, millis(1 * MINUTE)),
  },
];

export const sampleTaskQueueItems = (): Page<TaskQueueItem> => ({
  items: [
    {
      retailerId: SAMPLE_RETAILER,
      storeId: storeId('st-0142'),
      taskId: taskId('tk-99120'),
      facingId: facingId('fc-88201'),
      productId: productId('sku-4410092'),
      productName: 'Organic baby spinach 200g',
      location: { aisle: '12', bay: 'C', shelf: 3, position: 4 },
      type: 'restock_out_of_stock',
      priority: 'critical',
      lane: 'red',
      status: 'created',
      assigneeId: null,
      assigneeName: null,
      createdAt: minus(SAMPLE_NOW, millis(5 * HOUR + 10 * MINUTE)),
      updatedAt: minus(SAMPLE_NOW, millis(5 * HOUR + 10 * MINUTE)),
      acknowledgedAt: null,
      resolvedAt: null,
      failedVerifications: 0,
      requiresVerification: true,
      // Past due and unassigned — the row a manager is meant to act on first.
      dueAt: minus(SAMPLE_NOW, millis(70 * MINUTE)),
    },
    {
      retailerId: SAMPLE_RETAILER,
      storeId: storeId('st-0142'),
      taskId: taskId('tk-99154'),
      facingId: facingId('fc-88214'),
      productId: productId('sku-4410518'),
      productName: 'Vine tomatoes 400g',
      location: { aisle: '12', bay: 'D', shelf: 2, position: 1 },
      type: 'restock_out_of_stock',
      priority: 'high',
      lane: 'red',
      status: 'in_progress',
      assigneeId: employeeId('emp-4471'),
      assigneeName: 'A. Okafor',
      createdAt: minus(SAMPLE_NOW, millis(2 * HOUR)),
      updatedAt: minus(SAMPLE_NOW, millis(18 * MINUTE)),
      acknowledgedAt: minus(SAMPLE_NOW, millis(40 * MINUTE)),
      resolvedAt: null,
      failedVerifications: 0,
      requiresVerification: true,
      dueAt: plus(SAMPLE_NOW, millis(1 * HOUR)),
    },
    {
      retailerId: SAMPLE_RETAILER,
      storeId: storeId('st-0142'),
      taskId: taskId('tk-99188'),
      facingId: facingId('fc-90312'),
      productId: productId('sku-2210044'),
      productName: 'Semi-skimmed milk 2L',
      location: { aisle: '04', bay: 'A', shelf: 1, position: 6 },
      type: 'replenish_low_stock',
      priority: 'normal',
      lane: 'amber',
      status: 'awaiting_verification',
      assigneeId: employeeId('emp-4412'),
      assigneeName: 'D. Meyer',
      createdAt: minus(SAMPLE_NOW, millis(4 * HOUR)),
      updatedAt: minus(SAMPLE_NOW, millis(55 * MINUTE)),
      acknowledgedAt: minus(SAMPLE_NOW, millis(3 * HOUR)),
      resolvedAt: minus(SAMPLE_NOW, millis(55 * MINUTE)),
      // Bounced twice already: a repeat offender, which is why the counter lives
      // on the task rather than on its current state.
      failedVerifications: 2,
      requiresVerification: true,
      dueAt: null,
    },
    {
      retailerId: SAMPLE_RETAILER,
      storeId: storeId('st-0142'),
      taskId: taskId('tk-99201'),
      facingId: facingId('fc-90350'),
      productId: productId('sku-2210311'),
      productName: 'Salted butter 250g',
      location: { aisle: '04', bay: 'B', shelf: 4, position: 2 },
      type: 'price_label_correction',
      priority: 'low',
      lane: 'cyan',
      status: 'created',
      assigneeId: null,
      assigneeName: null,
      createdAt: minus(SAMPLE_NOW, millis(90 * MINUTE)),
      updatedAt: minus(SAMPLE_NOW, millis(90 * MINUTE)),
      acknowledgedAt: null,
      resolvedAt: null,
      failedVerifications: 0,
      // A label correction is confirmed by the tag itself, not by two clean passes.
      requiresVerification: false,
      dueAt: null,
    },
  ],
  nextCursor: null,
  totalEstimate: 34,
});

/** Every report at once — what the gallery and the store tests load. */
export interface SampleDataset {
  readonly availabilityIndex: AvailabilityIndexReport;
  readonly availabilityRecords: Page<AvailabilityRecord>;
  readonly taskWorkRate: TaskWorkRateReport;
  readonly resolvedGapRate: ResolvedGapRateReport;
  readonly detectionToResolution: DetectionToResolutionReport;
  readonly adoption: AdoptionReport;
  readonly storeAdoption: readonly StoreAdoption[];
  readonly departmentalOutcomes: readonly DepartmentalOutcome[];
  readonly taskQueues: readonly TaskQueueSummary[];
  readonly taskQueueItems: Page<TaskQueueItem>;
}

export const sampleDataset = (): SampleDataset => ({
  availabilityIndex: sampleAvailabilityIndexReport(),
  availabilityRecords: sampleAvailabilityRecords(),
  taskWorkRate: sampleTaskWorkRateReport(),
  resolvedGapRate: sampleResolvedGapRateReport(),
  detectionToResolution: sampleDetectionToResolutionReport(),
  adoption: sampleAdoptionReport(),
  storeAdoption: sampleStoreAdoption(),
  departmentalOutcomes: sampleDepartmentalOutcomes(),
  taskQueues: sampleTaskQueues(),
  taskQueueItems: sampleTaskQueueItems(),
});
