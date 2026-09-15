import { describe, expect, it } from 'vitest';
import {
  CrossRetailerAccessError,
  DAY,
  HOUR,
  applyTaskCommand,
  bucketsFor,
  computeOutcomeMetrics,
  computeResolvedGapRate,
  computeDetectionToResolution,
  createTask,
  distributionOf,
  escalateTask,
  gapId,
  instant,
  millis,
  openOutcome,
  resolveColorLaneMap,
  taskId,
  timeWindow,
  unwrap,
  withBackInStock,
  withTask,
  withTransition,
  type Instant,
  type LoopOutcomeRecord,
  type Millis,
} from '../src/index.js';
import {
  ACME,
  CEREAL_GROCERY,
  DAIRY_FRESH,
  EMPLOYEE,
  FRESH,
  GROCERY,
  RIVAL,
  gap,
  hour,
} from './support/fixtures.js';

const LANES = unwrap(resolveColorLaneMap(ACME));

/** Hours from the window anchor, unbounded — `h(30)` is 6am the next day. */
const h = (hours: number): Instant => instant(hour(0) + hours * HOUR);

const WINDOW = timeWindow(h(0), h(24));

const spans = (values: readonly number[]): readonly Millis[] => values.map((value) => millis(value));

/**
 * One gap taken all the way round the loop, stamping each stage as the domain
 * says it happened — the same folds the live loop performs.
 */
const roundTrip = (options: {
  readonly id: string;
  readonly facing: string;
  readonly classification: typeof DAIRY_FRESH;
  readonly detectedAt: Instant;
  readonly createdAt?: Instant;
  readonly assignedAt?: Instant;
  readonly acknowledgedAt?: Instant;
  readonly resolvedAt?: Instant;
}): LoopOutcomeRecord => {
  const detected = gap(options.id, options.facing, options.classification, options.detectedAt);
  let record = openOutcome(detected);
  if (options.createdAt === undefined) return record;

  const task = createTask({
    retailerId: ACME,
    storeId: detected.storeId,
    taskId: taskId(`task-${options.id}`),
    facingId: detected.facingId,
    productId: detected.productId,
    type: 'restock_out_of_stock',
    priority: 'high',
    lanes: LANES,
    createdAt: options.createdAt,
  });
  record = withTask(record, task);

  const commands = [
    options.assignedAt !== undefined
      ? ({ kind: 'assign', at: options.assignedAt, assigneeId: EMPLOYEE } as const)
      : null,
    options.acknowledgedAt !== undefined
      ? ({ kind: 'acknowledge', at: options.acknowledgedAt } as const)
      : null,
    options.resolvedAt !== undefined ? ({ kind: 'start', at: options.acknowledgedAt ?? options.createdAt } as const) : null,
    options.resolvedAt !== undefined ? ({ kind: 'resolve', at: options.resolvedAt } as const) : null,
  ].filter((command): command is NonNullable<typeof command> => command !== null);

  let current = task;
  for (const command of commands) {
    const transition = unwrap(applyTaskCommand(current, command));
    current = transition.task;
    record = withTransition(record, transition);
  }
  return record;
};

const verify = (record: LoopOutcomeRecord, at: Instant): LoopOutcomeRecord => ({
  ...record,
  verifiedAt: at,
  terminal: 'verified',
  backInStockAt: record.backInStockAt ?? at,
});

describe('folding the loop into outcome records', () => {
  it('stamps each stage from the transition that caused it', () => {
    const record = roundTrip({
      id: 'g1',
      facing: 'dairy-0',
      classification: DAIRY_FRESH,
      detectedAt: h(6),
      createdAt: h(6),
      assignedAt: h(7),
      acknowledgedAt: h(8),
      resolvedAt: h(9),
    });

    expect(record.departmentId).toBe(FRESH);
    expect(record.taskId).toBe(taskId('task-g1'));
    expect(record.taskType).toBe('restock_out_of_stock');
    expect(record.assignedAt).toBe(h(7));
    expect(record.acknowledgedAt).toBe(h(8));
    expect(record.resolvedAt).toBe(h(9));
    expect(record.verifiedAt).toBeNull();
  });

  it('keeps the first dispatch and the attempt that held, counting rework separately', () => {
    let record = roundTrip({
      id: 'g1',
      facing: 'dairy-0',
      classification: DAIRY_FRESH,
      detectedAt: h(6),
      createdAt: h(6),
      assignedAt: h(7),
      acknowledgedAt: h(8),
      resolvedAt: h(9),
    });

    const task = createTask({
      retailerId: ACME,
      storeId: (gap('g1', 'dairy-0', DAIRY_FRESH, h(6))).storeId,
      taskId: taskId('task-g1'),
      facingId: gap('g1', 'dairy-0', DAIRY_FRESH, h(6)).facingId,
      productId: gap('g1', 'dairy-0', DAIRY_FRESH, h(6)).productId,
      type: 'restock_out_of_stock',
      priority: 'high',
      lanes: LANES,
      createdAt: h(6),
    });
    let current = unwrap(applyTaskCommand(task, { kind: 'assign', at: h(7), assigneeId: EMPLOYEE })).task;
    current = unwrap(applyTaskCommand(current, { kind: 'acknowledge', at: h(8) })).task;
    current = unwrap(applyTaskCommand(current, { kind: 'start', at: h(8) })).task;
    current = unwrap(applyTaskCommand(current, { kind: 'resolve', at: h(9) })).task;

    // Second trip round the loop after a failed verification.
    for (const transition of [
      unwrap(escalateTask(current, h(12), 'verification_regressed')),
    ]) {
      record = withTransition(record, transition);
      current = transition.task;
    }
    for (const command of [
      { kind: 'assign', at: h(13), assigneeId: EMPLOYEE } as const,
      { kind: 'acknowledge', at: h(14) } as const,
      { kind: 'start', at: h(14) } as const,
      { kind: 'resolve', at: h(15) } as const,
    ]) {
      const transition = unwrap(applyTaskCommand(current, command));
      current = transition.task;
      record = withTransition(record, transition);
    }

    expect(record.reopenCount).toBe(1);
    // Dispatch and response lag are about the first time somebody picked it up.
    expect(record.assignedAt).toBe(h(7));
    expect(record.acknowledgedAt).toBe(h(8));
    // Resolution lag is about the attempt that actually held.
    expect(record.lastAcknowledgedAt).toBe(h(14));
    expect(record.resolvedAt).toBe(h(15));
  });

  it('records a facing that came back without anybody being dispatched', () => {
    const record = withBackInStock(
      openOutcome(gap('g2', 'dairy-1', DAIRY_FRESH, h(6))),
      h(7),
    );

    expect(record.taskId).toBeNull();
    expect(record.backInStockAt).toBe(h(7));
  });
});

describe('duration distributions', () => {
  it('reports nothing rather than zero when there are no samples', () => {
    expect(distributionOf([])).toEqual({
      sampleSize: 0,
      p50: null,
      p90: null,
      p99: null,
      mean: null,
      max: null,
    });
  });

  it('reports percentiles a gap actually had, by nearest rank', () => {
    const distribution = distributionOf(spans([10, 20, 30, 40, 100]));

    expect(distribution.sampleSize).toBe(5);
    expect(distribution.p50).toBe(30);
    expect(distribution.p90).toBe(100);
    expect(distribution.p99).toBe(100);
    expect(distribution.mean).toBe(40);
    expect(distribution.max).toBe(100);
  });
});

describe('detection-to-resolution', () => {
  const records = [
    verify(
      roundTrip({
        id: 'g1',
        facing: 'dairy-0',
        classification: DAIRY_FRESH,
        detectedAt: h(6),
        createdAt: h(6),
        assignedAt: h(7),
        acknowledgedAt: h(8),
        resolvedAt: h(9),
      }),
      h(10),
    ),
    verify(
      roundTrip({
        id: 'g2',
        facing: 'cereal-0',
        classification: CEREAL_GROCERY,
        detectedAt: h(6),
        createdAt: h(8),
        assignedAt: h(9),
        acknowledgedAt: h(10),
        resolvedAt: h(12),
      }),
      h(18),
    ),
  ];

  const report = computeDetectionToResolution({
    retailerId: ACME,
    window: WINDOW,
    granularity: 'period',
    records,
    computedAt: h(24),
  });

  it('attributes the lag stage by stage rather than as one number', () => {
    // Nearest rank over two samples puts p50 on the faster of the pair.
    expect(report.overall.detectionToTask.p50).toBe(0);
    expect(report.overall.detectionToTask.max).toBe(2 * HOUR);
    expect(report.overall.taskToAssignment.max).toBe(HOUR);
    expect(report.overall.acknowledgementToResolution.max).toBe(2 * HOUR);
    expect(report.overall.resolutionToVerification.max).toBe(6 * HOUR);
    expect(report.overall.detectionToVerification.p50).toBe(4 * HOUR);
    expect(report.overall.detectionToVerification.max).toBe(12 * HOUR);
  });

  it('cuts the same stages by department', () => {
    const fresh = report.breakdowns.find((entry) => entry.key === FRESH);
    const grocery = report.breakdowns.find((entry) => entry.key === GROCERY);

    expect(report.breakdowns.every((entry) => entry.dimension === 'department')).toBe(true);
    expect(fresh?.value.detectionToVerification.p50).toBe(4 * HOUR);
    expect(grocery?.value.detectionToVerification.p50).toBe(12 * HOUR);
  });

  it('buckets the series against the caller’s window, not the epoch', () => {
    const series = computeDetectionToResolution({
      retailerId: ACME,
      window: timeWindow(h(5), h(9)),
      granularity: 'hour',
      records,
      computedAt: h(24),
    }).series;

    expect(series).toHaveLength(4);
    expect(series[0]?.window.from).toBe(h(5));
    // Both gaps were detected in hour 6; nothing lands in the other buckets.
    expect(series[1]?.detectionToVerification.sampleSize).toBe(2);
    expect(series[2]?.detectionToVerification.sampleSize).toBe(0);
  });

  it('tiles a window that does not divide evenly, clipping the last bucket', () => {
    const buckets = bucketsFor(timeWindow(h(0), h(5)), 'day');

    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.to).toBe(h(5));
  });
});

describe('resolved-gap rate', () => {
  const detected = (id: string, facing: string, classification: typeof DAIRY_FRESH) =>
    roundTrip({ id, facing, classification, detectedAt: h(2) });

  const tasked = (id: string, facing: string, classification: typeof DAIRY_FRESH) =>
    roundTrip({
      id,
      facing,
      classification,
      detectedAt: h(2),
      createdAt: h(2),
      assignedAt: h(3),
      acknowledgedAt: h(3),
      resolvedAt: h(4),
    });

  const rate = (records: readonly LoopOutcomeRecord[], to = h(48)) =>
    computeResolvedGapRate({
      retailerId: ACME,
      window: timeWindow(h(0), to),
      granularity: 'period',
      records,
      computedAt: to,
    });

  it('counts what was seen, tasked, resolved and verified', () => {
    const report = rate([
      verify(tasked('g1', 'dairy-0', DAIRY_FRESH), h(6)),
      tasked('g2', 'dairy-1', DAIRY_FRESH),
      withBackInStock(detected('g3', 'dairy-2', DAIRY_FRESH), h(3)),
      detected('g4', 'dairy-3', DAIRY_FRESH),
    ], h(48));

    expect(report.overall.detectedGaps).toBe(4);
    expect(report.overall.taskedGaps).toBe(2);
    expect(report.overall.resolvedGaps).toBe(2);
    expect(report.overall.verifiedGaps).toBe(1);
    expect(report.overall.selfResolvedGaps).toBe(1);
    expect(report.overall.unresolvedGaps).toBe(2);
    expect(report.overall.taskedGapRate).toBe(0.5);
    expect(report.overall.resolvedGapRate).toBe(0.25);
  });

  it('excludes gaps whose verification window is still open from the denominator', () => {
    // Resolved at hour 4, cut at hour 12: the two clean passes a day apart
    // cannot have landed yet, so counting it unresolved would understate the rate.
    const report = rate(
      [verify(tasked('g1', 'dairy-0', DAIRY_FRESH), h(6)), tasked('g2', 'dairy-1', DAIRY_FRESH)],
      h(12),
    );

    expect(report.overall.awaitingVerification).toBe(1);
    expect(report.overall.unresolvedGaps).toBe(0);
    expect(report.overall.resolvedGapRate).toBe(1);
  });

  it('reports no rate at all rather than zero when nothing was detected', () => {
    const report = rate([]);

    expect(report.overall.detectedGaps).toBe(0);
    expect(report.overall.taskedGapRate).toBeNull();
    expect(report.overall.resolvedGapRate).toBeNull();
  });

  it('cuts the rate by department', () => {
    const report = rate([
      verify(tasked('g1', 'dairy-0', DAIRY_FRESH), h(6)),
      verify(tasked('g2', 'dairy-1', DAIRY_FRESH), h(6)),
      tasked('g3', 'cereal-0', CEREAL_GROCERY),
      detected('g4', 'cereal-1', CEREAL_GROCERY),
    ]);

    const fresh = report.breakdowns.find((entry) => entry.key === FRESH);
    const grocery = report.breakdowns.find((entry) => entry.key === GROCERY);

    expect(fresh?.value.resolvedGapRate).toBe(1);
    expect(grocery?.value.resolvedGapRate).toBe(0);
    expect(grocery?.value.detectedGaps).toBe(2);
  });

  it('refuses to pool another retailer’s records into the figure', () => {
    const foreign: LoopOutcomeRecord = {
      ...detected('g9', 'dairy-9', DAIRY_FRESH),
      retailerId: RIVAL,
      gapId: gapId('g-rival'),
    };

    expect(() => rate([foreign])).toThrow(CrossRetailerAccessError);
  });
});

describe('both metrics over one population', () => {
  it('reports latency and rate from the same records and the same cohort', () => {
    const records = [
      verify(
        roundTrip({
          id: 'g1',
          facing: 'dairy-0',
          classification: DAIRY_FRESH,
          detectedAt: h(2),
          createdAt: h(2),
          assignedAt: h(3),
          acknowledgedAt: h(3),
          resolvedAt: h(4),
        }),
        h(8),
      ),
    ];

    const metrics = computeOutcomeMetrics({
      retailerId: ACME,
      window: timeWindow(h(0), h(48)),
      granularity: 'day',
      records,
      computedAt: h(48),
    });

    expect(metrics.resolvedGapRate.overall.detectedGaps).toBe(1);
    expect(metrics.detectionToResolution.overall.detectionToVerification.sampleSize).toBe(1);
    expect(metrics.detectionToResolution.series).toHaveLength(2);
    expect(metrics.resolvedGapRate.series[0]?.window.to).toBe(h(24));
    expect(DAY).toBe(24 * HOUR);
  });
});
