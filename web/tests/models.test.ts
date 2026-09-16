import { describe, expect, it } from 'vitest';
import {
  AVAILABILITY_INDEX_THRESHOLDS,
  REWORK_RATE_THRESHOLDS,
  deltaIsImprovement,
  evaluateStatus,
  worstStatus,
} from '../src/models/status';
import {
  NOT_MEASURED,
  formatCompactCount,
  formatDelta,
  formatDuration,
  formatRatio,
  formatWholePercent,
} from '../src/models/format';
import { compareOutcomesByIndex } from '../src/models/departmental';
import { resolvedGapRateDenominator, slowestStage } from '../src/models/task-performance';
import { compareQueuesByUrgency, isBreaching, queueHeadAge } from '../src/models/task-queue';
import { appendPage } from '../src/models/paging';
import { instant, millis } from '../src/models/time';
import {
  SAMPLE_NOW,
  sampleDepartmentalOutcomes,
  sampleDetectionToResolutionReport,
  sampleResolvedGapRateReport,
  sampleTaskQueueItems,
  sampleTaskQueues,
} from '../src/fixtures/sample-data';

describe('status grading', () => {
  it('grades a missing measurement as unknown, never as good', () => {
    expect(evaluateStatus(null, AVAILABILITY_INDEX_THRESHOLDS)).toBe('unknown');
    expect(evaluateStatus(Number.NaN, AVAILABILITY_INDEX_THRESHOLDS)).toBe('unknown');
  });

  it('flips the comparison for a measure where lower is better', () => {
    expect(evaluateStatus(0.03, REWORK_RATE_THRESHOLDS)).toBe('good');
    expect(evaluateStatus(0.3, REWORK_RATE_THRESHOLDS)).toBe('critical');
    expect(evaluateStatus(0.99, AVAILABILITY_INDEX_THRESHOLDS)).toBe('good');
    expect(evaluateStatus(0.5, AVAILABILITY_INDEX_THRESHOLDS)).toBe('critical');
  });

  it('rolls a set up to its worst member, with unknown ranking below good', () => {
    expect(worstStatus(['good', 'warning', 'critical'])).toBe('critical');
    expect(worstStatus(['unknown', 'good'])).toBe('good');
    expect(worstStatus([])).toBe('unknown');
  });

  it('reads a delta against the measure, not against its sign', () => {
    expect(deltaIsImprovement(-0.02, 'lower_is_better')).toBe(true);
    expect(deltaIsImprovement(-0.02, 'higher_is_better')).toBe(false);
  });
});

describe('formatting', () => {
  it('renders a null measurement as the placeholder, never as zero', () => {
    expect(formatRatio(null)).toBe(NOT_MEASURED);
    expect(formatWholePercent(null)).toBe(NOT_MEASURED);
    expect(formatDuration(null)).toBe(NOT_MEASURED);
    expect(formatCompactCount(null)).toBe(NOT_MEASURED);
    expect(formatDelta(null, 'points')).toBe(NOT_MEASURED);
  });

  it('writes durations at the coarsest grain that still says something', () => {
    expect(formatDuration(millis(45_000))).toBe('45s');
    expect(formatDuration(millis(9 * 60_000))).toBe('9m');
    expect(formatDuration(millis(2 * 3_600_000 + 15 * 60_000))).toBe('2h 15m');
    expect(formatDuration(millis(50 * 3_600_000))).toBe('2d 2h');
  });

  it('signs a delta and states its unit', () => {
    expect(formatDelta(0.012, 'points')).toBe('+1.2 pts');
    expect(formatDelta(-0.012, 'points')).toBe('−1.2 pts');
    expect(formatDelta(-14, 'count')).toBe('−14');
  });
});

describe('resolved-gap rate', () => {
  it('excludes gaps still inside the verification window from the denominator', () => {
    const overall = sampleResolvedGapRateReport().overall;
    expect(resolvedGapRateDenominator(overall)).toBe(
      overall.detectedGaps - overall.awaitingVerification,
    );
    expect(resolvedGapRateDenominator(overall)).toBeLessThan(overall.detectedGaps);
  });
});

describe('loop stages', () => {
  it('attributes the slowest stage, skipping stages with no sample', () => {
    const point = sampleDetectionToResolutionReport().overall;
    expect(slowestStage(point)?.stage).toBe('resolutionToVerification');
  });

  it('attributes nothing when no stage has a p50', () => {
    const empty = { sampleSize: 0, p50: null, p90: null, p99: null, mean: null, max: null };
    const point = sampleDetectionToResolutionReport().overall;
    expect(
      slowestStage({
        ...point,
        detectionToTask: empty,
        taskToAssignment: empty,
        assignmentToAcknowledgement: empty,
        acknowledgementToResolution: empty,
        resolutionToVerification: empty,
      }),
    ).toBeNull();
  });
});

describe('departmental ordering', () => {
  it('ranks worst-first and puts unmeasured departments last', () => {
    const ordered = [...sampleDepartmentalOutcomes()].sort(compareOutcomesByIndex);
    expect(ordered[0]?.departmentName).toBe('Produce');
    expect(ordered[ordered.length - 1]?.availabilityIndex).toBeNull();
  });
});

describe('task queues', () => {
  it('orders queues by breach, then criticals, then the oldest head', () => {
    const ordered = [...sampleTaskQueues()].sort(compareQueuesByUrgency);
    expect(ordered[0]?.breachingCount).toBeGreaterThan(0);
    expect(ordered.map((queue) => queue.queueId)).toEqual([
      'q-0142-restock',
      'q-0142-labels',
      'q-0287-mixed',
    ]);
  });

  it('measures the head age against the dashboard clock', () => {
    const queue = sampleTaskQueues()[0];
    expect(queue).toBeDefined();
    expect(queueHeadAge(queue!, SAMPLE_NOW)).toBe(5 * 3_600_000 + 10 * 60_000);
  });

  it('flags an overdue open task and leaves a finished one alone', () => {
    const items = sampleTaskQueueItems().items;
    const overdue = items.find((item) => item.taskId === 'tk-99120');
    const inProgress = items.find((item) => item.taskId === 'tk-99154');

    expect(isBreaching(overdue!, SAMPLE_NOW)).toBe(true);
    expect(isBreaching(inProgress!, SAMPLE_NOW)).toBe(false);
    expect(isBreaching({ ...overdue!, status: 'verified' }, SAMPLE_NOW)).toBe(false);
  });
});

describe('paging', () => {
  it('drops a row a keyset cursor re-emitted at the page boundary', () => {
    const first = { items: [{ id: 'a' }, { id: 'b' }], nextCursor: null, totalEstimate: 4 };
    const second = { items: [{ id: 'b' }, { id: 'c' }], nextCursor: null, totalEstimate: 4 };
    const merged = appendPage(first, second, (row) => row.id);
    expect(merged.items.map((row) => row.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps a previous total when the next page cannot count', () => {
    const first = { items: [{ id: 'a' }], nextCursor: null, totalEstimate: 9 };
    const second = { items: [{ id: 'b' }], nextCursor: null, totalEstimate: null };
    expect(appendPage(first, second, (row) => row.id).totalEstimate).toBe(9);
  });
});

describe('sample clock', () => {
  it('is a fixed instant so fixtures render identically on every run', () => {
    expect(SAMPLE_NOW).toBe(instant(Date.UTC(2026, 8, 15, 18, 0, 0)));
  });
});
