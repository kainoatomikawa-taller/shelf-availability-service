import '../components/tokens.css';
import type { ReactNode } from 'react';
import { DataTable, type Column } from '../components/DataTable';
import { MetricCard } from '../components/MetricCard';
import { StatusIndicator } from '../components/StatusIndicator';
import { AsyncBoundary, EmptyState, ErrorPanel, Skeleton } from '../components/AsyncStates';
import { BarChart } from '../components/charts/BarChart';
import { LineChart } from '../components/charts/LineChart';
import type { AvailabilityRecord } from '../models/availability';
import { formatFacingLocation } from '../models/availability';
import type { DepartmentalOutcome } from '../models/departmental';
import { SERVICE_LEVEL_EXCLUSION_LABELS } from '../models/departmental';
import {
  TASK_PRIORITY_LABELS,
  TASK_STATUS_LABELS,
  TASK_TYPE_LABELS,
} from '../models/enums';
import {
  formatCount,
  formatDecimal,
  formatDelta,
  formatDuration,
  formatRatio,
  formatTimeUtc,
  formatWholePercent,
} from '../models/format';
import { STATUS_LEVELS } from '../models/status';
import {
  ACKNOWLEDGEMENT_RATE_THRESHOLDS,
  AVAILABILITY_INDEX_THRESHOLDS,
  COVERAGE_THRESHOLDS,
  RESOLVED_GAP_RATE_THRESHOLDS,
  evaluateStatus,
  worstStatus,
} from '../models/status';
import { LOOP_STAGES, LOOP_STAGE_LABELS, resolvedGapRateDenominator } from '../models/task-performance';
import type { TaskQueueItem } from '../models/task-queue';
import { isBreaching, taskAge } from '../models/task-queue';
import { httpError, decodeError } from '../services/errors';
import { millis } from '../models/time';
import {
  SAMPLE_NOW,
  sampleAdoptionReport,
  sampleAvailabilityIndexReport,
  sampleAvailabilityRecords,
  sampleDepartmentalOutcomes,
  sampleDetectionToResolutionReport,
  sampleResolvedGapRateReport,
  sampleTaskWorkRateReport,
  sampleTaskQueueItems,
  sampleTaskQueues,
} from '../fixtures/sample-data';
import { idle, succeed } from '../models/async-data';

/**
 * Every shared component, rendered against the sample fixtures.
 *
 * This is the isolation harness: each component appears with the data shapes it
 * has to survive in production — a null measurement, a department with no
 * commitment, a task past its due time, a failed request — rather than with the
 * tidy values that make a component look finished and then break on real data.
 */
export const Gallery = () => {
  const availability = sampleAvailabilityIndexReport();
  const gapRate = sampleResolvedGapRateReport();
  const latency = sampleDetectionToResolutionReport();
  const adoption = sampleAdoptionReport();
  const workRate = sampleTaskWorkRateReport();
  const records = sampleAvailabilityRecords();
  const departments = sampleDepartmentalOutcomes();
  const queues = sampleTaskQueues();
  const queueItems = sampleTaskQueueItems();

  const availabilityStatus = worstStatus([
    evaluateStatus(availability.overall.index, AVAILABILITY_INDEX_THRESHOLDS),
    evaluateStatus(availability.overall.coverage, COVERAGE_THRESHOLDS),
  ]);

  return (
    <div className="osa-root" style={{ padding: 24, display: 'grid', gap: 32 }}>
      <header>
        <h1 style={{ margin: 0, fontSize: 20 }}>Store operations · shared components</h1>
        <p className="osa-micro">
          Sample data, {formatTimeUtc(SAMPLE_NOW)} · retailer {availability.retailerId}
        </p>
      </header>

      <Section title="Metric cards" note="Hero figure, delta, trend, and the not-measured case.">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16 }}>
          <MetricCard
            hero
            label="Availability index"
            value={formatRatio(availability.overall.index)}
            status={availabilityStatus}
            delta={{
              formatted: formatDelta(-0.004, 'points'),
              value: -0.004,
              direction: 'higher_is_better',
              comparedTo: 'vs previous 24h',
            }}
            trend={availability.series.map((point) => point.index)}
            footnote={`Measured over ${formatWholePercent(availability.overall.coverage)} of facing-time across ${formatCount(availability.overall.facingCount)} facings`}
          />

          <MetricCard
            label="Resolved-gap rate"
            value={formatRatio(gapRate.overall.resolvedGapRate)}
            status={evaluateStatus(gapRate.overall.resolvedGapRate, RESOLVED_GAP_RATE_THRESHOLDS)}
            trend={gapRate.series.map((point) => point.resolvedGapRate)}
            footnote={`${formatCount(gapRate.overall.verifiedGaps)} verified of ${formatCount(resolvedGapRateDenominator(gapRate.overall))} eligible · ${formatCount(gapRate.overall.awaitingVerification)} still inside the verification window and excluded`}
          />

          <MetricCard
            label="Detection to verified (p50)"
            value={formatDuration(latency.overall.detectionToVerification.p50)}
            status="warning"
            footnote={`p90 ${formatDuration(latency.overall.detectionToVerification.p90)} · ${formatCount(latency.overall.detectionToVerification.sampleSize)} closed loops`}
          />

          <MetricCard
            label="Task acknowledgement rate"
            value={formatRatio(adoption.overall.acknowledgementRate)}
            status={evaluateStatus(
              adoption.overall.acknowledgementRate,
              ACKNOWLEDGEMENT_RATE_THRESHOLDS,
            )}
            trend={adoption.series.map((point) => point.acknowledgementRate)}
            footnote={`${formatCount(adoption.overall.tasksAcknowledged)} of ${formatCount(adoption.overall.tasksDispatched)} dispatched · ${formatCount(adoption.overall.activeStores)} of ${formatCount(adoption.overall.enrolledStores)} enrolled stores active`}
          />

          <MetricCard
            label="Tasks per labour hour"
            value={formatDecimal(workRate.overall.tasksPerLabourHour)}
            status="unknown"
            footnote="No workforce feed connected for this retailer. The service does not estimate labour."
          />
        </div>
      </Section>

      <Section title="Metric card states" note="Loading and error keep the card's footprint.">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16 }}>
          <MetricCard label="Availability index" value="—" loading />
          <MetricCard
            label="Task work rate"
            value="—"
            error={httpError(503, 'Service Unavailable', 'Read replica is catching up', millis(2000))}
            onRetry={() => undefined}
          />
          <MetricCard
            label="Adoption"
            value="—"
            error={decodeError('overall.acknowledgementRate', 'ratio in [0, 1]', 'string')}
          />
        </div>
      </Section>

      <Section title="Status indicators" note="Glyph plus label — colour is never the only channel.">
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
          {STATUS_LEVELS.map((level) => (
            <StatusIndicator key={level} level={level} />
          ))}
          <StatusIndicator level="serious" label="Below revisit threshold" />
          <StatusIndicator level="critical" dotOnly />
        </div>
      </Section>

      <Section
        title="Line chart"
        note="Overnight buckets are unmeasured, so the line breaks rather than plotting zero."
      >
        <div className="osa-panel">
          <LineChart
            title="Availability index by hour"
            subtitle="Half-open hourly buckets, UTC"
            categories={availability.series.map((point) => formatTimeUtc(point.window.from))}
            series={[
              {
                key: 'index',
                label: 'Availability index',
                values: availability.series.map((point) => point.index),
              },
            ]}
            formatValue={formatRatio}
            yDomain={{ min: 0.9, max: 1 }}
          />
        </div>
      </Section>

      <Section title="Line chart · two series" note="Two series get a legend; a single series does not.">
        <div className="osa-panel">
          <LineChart
            title="Gaps detected and verified"
            categories={gapRate.series.map((point) => formatTimeUtc(point.window.from))}
            series={[
              {
                key: 'detected',
                label: 'Detected',
                values: gapRate.series.map((point) => point.detectedGaps),
              },
              {
                key: 'verified',
                label: 'Verified',
                values: gapRate.series.map((point) => point.verifiedGaps),
              },
            ]}
            formatValue={formatCount}
            showArea={false}
          />
        </div>
      </Section>

      <Section title="Bar chart" note="Zero-based, direct labels at the tip, one unmeasured stage.">
        <div className="osa-panel">
          <BarChart
            title="Median latency by loop stage"
            subtitle="Where the time actually goes — four stages, four owners"
            data={LOOP_STAGES.map((stage) => ({
              key: stage,
              label: LOOP_STAGE_LABELS[stage],
              value: latency.overall[stage].p50,
            }))}
            formatValue={(value) => formatDuration(millis(value))}
            height={200}
          />
        </div>
      </Section>

      <Section title="Data table · availability records" note="The drill-down behind the index.">
        <div className="osa-panel">
          <DataTable
            caption="Worst-covered facings"
            columns={recordColumns}
            rows={records.items}
            rowKey={(row) => `${row.storeId}/${row.facingId}`}
            activeSort="index_asc"
            onSort={() => undefined}
            totalEstimate={records.totalEstimate}
          />
        </div>
      </Section>

      <Section title="Data table · departmental outcomes" note="Whose staff to move, and who carries a commitment.">
        <div className="osa-panel">
          <DataTable
            caption="Departments, worst first"
            columns={departmentColumns}
            rows={departments}
            rowKey={(row) => row.departmentId}
          />
        </div>
      </Section>

      <Section title="Data table · task queue" note="A breaching row, a repeat offender, an unverified type.">
        <div className="osa-panel">
          <DataTable
            caption={`${queues[0]?.label ?? 'Queue'} — ${formatCount(queues[0]?.openCount ?? 0)} open`}
            columns={queueColumns}
            rows={queueItems.items}
            rowKey={(row) => row.taskId}
            totalEstimate={queueItems.totalEstimate}
          />
        </div>
      </Section>

      <Section title="Table states" note="Loading rows, empty, and a failure with nothing to fall back to.">
        <div style={{ display: 'grid', gap: 16 }}>
          <div className="osa-panel">
            <DataTable caption="Loading" columns={recordColumns} rows={[]} rowKey={() => ''} loading />
          </div>
          <div className="osa-panel">
            <DataTable caption="Empty" columns={recordColumns} rows={[]} rowKey={() => ''} />
          </div>
          <div className="osa-panel">
            <DataTable
              caption="Failed"
              columns={recordColumns}
              rows={[]}
              rowKey={() => ''}
              error={httpError(403, 'Forbidden', null, null)}
            />
          </div>
        </div>
      </Section>

      <Section title="Async primitives" note="What a panel shows before, during and after a failure.">
        <div style={{ display: 'grid', gap: 16 }}>
          <div className="osa-panel">
            <Skeleton height="2em" width="45%" />
          </div>
          <div className="osa-panel">
            <ErrorPanel
              error={httpError(429, 'Too Many Requests', null, millis(4000))}
              onRetry={() => undefined}
            />
          </div>
          <div className="osa-panel">
            <EmptyState message="No facings matched this scope." />
          </div>
          <div className="osa-panel">
            <AsyncBoundary data={succeed(departments, SAMPLE_NOW)} now={SAMPLE_NOW}>
              {(value) => <p className="osa-label">{formatCount(value.length)} departments loaded</p>}
            </AsyncBoundary>
          </div>
          <div className="osa-panel">
            <AsyncBoundary data={idle<readonly DepartmentalOutcome[]>()} now={SAMPLE_NOW}>
              {() => null}
            </AsyncBoundary>
          </div>
        </div>
      </Section>
    </div>
  );
};

const Section = ({
  title,
  note,
  children,
}: {
  readonly title: string;
  readonly note: string;
  readonly children: ReactNode;
}) => (
  <section style={{ display: 'grid', gap: 12 }}>
    <div>
      <h2 style={{ margin: 0, fontSize: 15 }}>{title}</h2>
      <p className="osa-micro">{note}</p>
    </div>
    {children}
  </section>
);

const recordColumns: readonly Column<AvailabilityRecord>[] = [
  { key: 'product', header: 'Product', render: (row) => row.productId },
  { key: 'location', header: 'Location', render: (row) => formatFacingLocation(row.location) },
  {
    key: 'index',
    header: 'Index',
    numeric: true,
    sortKey: 'index_asc',
    render: (row) => formatRatio(row.index),
  },
  {
    key: 'coverage',
    header: 'Coverage',
    numeric: true,
    sortKey: 'coverage_asc',
    description: 'Share of the window the facing was actually observed for',
    render: (row) => formatWholePercent(row.coverage),
  },
  {
    key: 'oos',
    header: 'Out of stock',
    numeric: true,
    sortKey: 'out_of_stock_millis_desc',
    render: (row) => formatDuration(row.outOfStockMillis),
  },
  {
    key: 'gaps',
    header: 'Gaps',
    numeric: true,
    sortKey: 'gap_count_desc',
    render: (row) => formatCount(row.gapCount),
  },
];

const departmentColumns: readonly Column<DepartmentalOutcome>[] = [
  { key: 'name', header: 'Department', render: (row) => row.departmentName },
  {
    key: 'index',
    header: 'Index',
    numeric: true,
    render: (row) => formatRatio(row.availabilityIndex),
  },
  {
    key: 'coverage',
    header: 'Coverage',
    numeric: true,
    render: (row) => formatWholePercent(row.coverage),
  },
  {
    key: 'resolved',
    header: 'Resolved-gap rate',
    numeric: true,
    render: (row) => formatRatio(row.resolvedGapRate),
  },
  {
    key: 'awaiting',
    header: 'Awaiting verification',
    numeric: true,
    description: 'Excluded from the resolved-gap rate',
    render: (row) => formatCount(row.awaitingVerification),
  },
  {
    key: 'p50',
    header: 'Detection → verified',
    numeric: true,
    render: (row) => formatDuration(row.medianDetectionToVerification),
  },
  {
    key: 'commitment',
    header: 'Service level',
    render: (row) =>
      row.serviceLevel.inScope ? (
        <StatusIndicator level="good" label="In scope" />
      ) : (
        <StatusIndicator
          level={row.serviceLevel.reason === 'unmeasured' ? 'unknown' : 'serious'}
          label={SERVICE_LEVEL_EXCLUSION_LABELS[row.serviceLevel.reason]}
        />
      ),
  },
];

const queueColumns: readonly Column<TaskQueueItem>[] = [
  { key: 'product', header: 'Product', render: (row) => row.productName },
  { key: 'location', header: 'Location', render: (row) => formatFacingLocation(row.location) },
  { key: 'type', header: 'Work', render: (row) => TASK_TYPE_LABELS[row.type] },
  { key: 'priority', header: 'Priority', render: (row) => TASK_PRIORITY_LABELS[row.priority] },
  { key: 'status', header: 'Status', render: (row) => TASK_STATUS_LABELS[row.status] },
  {
    key: 'age',
    header: 'Open for',
    numeric: true,
    render: (row) => formatDuration(taskAge(row, SAMPLE_NOW)),
  },
  { key: 'assignee', header: 'Assignee', render: (row) => row.assigneeName ?? 'Unassigned' },
  {
    key: 'flag',
    header: 'Flag',
    render: (row) =>
      isBreaching(row, SAMPLE_NOW) ? (
        <StatusIndicator level="critical" label="Past due" />
      ) : row.failedVerifications > 0 ? (
        <StatusIndicator
          level="serious"
          label={`Failed verification ×${row.failedVerifications}`}
        />
      ) : (
        <StatusIndicator level="good" label="On track" />
      ),
  },
];
