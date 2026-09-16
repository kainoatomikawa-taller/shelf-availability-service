import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MetricCard } from '../src/components/MetricCard';
import { StatusIndicator } from '../src/components/StatusIndicator';
import { DataTable } from '../src/components/DataTable';
import type { Column } from '../src/components/DataTable';
import { AsyncBoundary } from '../src/components/AsyncStates';
import { LineChart } from '../src/components/charts/LineChart';
import { BarChart } from '../src/components/charts/BarChart';
import { Sparkline } from '../src/components/charts/Sparkline';
import { STATUS_LEVELS } from '../src/models/status';
import {
  formatCount,
  formatDuration,
  formatRatio,
  formatWholePercent,
} from '../src/models/format';
import { LOOP_STAGES, LOOP_STAGE_LABELS } from '../src/models/task-performance';
import type { DepartmentalOutcome } from '../src/models/departmental';
import { beginLoad, failed, idle, requestId, succeed } from '../src/models/async-data';
import { decodeError, httpError } from '../src/services/errors';
import { millis } from '../src/models/time';
import {
  SAMPLE_NOW,
  sampleAvailabilityIndexReport,
  sampleDepartmentalOutcomes,
  sampleDetectionToResolutionReport,
  sampleResolvedGapRateReport,
} from '../src/fixtures/sample-data';

/**
 * Every shared component, rendered on its own against the sample fixtures.
 *
 * The assertions are about what the components refuse to say as much as what
 * they show: an unmeasured figure must not read as zero, a status must not be
 * carried by colour alone, and a failed refresh must not erase the number that
 * was already on screen.
 */

describe('MetricCard', () => {
  const availability = sampleAvailabilityIndexReport();

  it('renders a sample measure with its status and denominator', () => {
    render(
      <MetricCard
        label="Availability index"
        value={formatRatio(availability.overall.index)}
        status="warning"
        footnote={`Measured over ${formatWholePercent(availability.overall.coverage)} of facing-time`}
        trend={availability.series.map((point) => point.index)}
      />,
    );

    expect(screen.getByText('96.8%')).toBeInTheDocument();
    expect(screen.getByText('Watch')).toBeInTheDocument();
    expect(screen.getByText(/Measured over 78% of facing-time/)).toBeInTheDocument();
    expect(screen.getByLabelText('Availability index trend')).toBeInTheDocument();
  });

  it('shows an unmeasured value as the placeholder, not as zero', () => {
    render(<MetricCard label="Tasks per labour hour" value={formatRatio(null)} status="unknown" />);

    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText('0.0%')).not.toBeInTheDocument();
    expect(screen.getByText('Not measured')).toBeInTheDocument();
  });

  it('colours a delta by whether it is an improvement, not by its sign', () => {
    const { rerender } = render(
      <MetricCard
        label="Rework rate"
        value="4.0%"
        delta={{ formatted: '−1.2 pts', value: -0.012, direction: 'lower_is_better', comparedTo: 'vs previous 24h' }}
      />,
    );
    expect(screen.getByText('−1.2 pts')).toHaveClass('osa-metric-card__delta--good');

    rerender(
      <MetricCard
        label="Availability index"
        value="96.8%"
        delta={{ formatted: '−1.2 pts', value: -0.012, direction: 'higher_is_better', comparedTo: 'vs previous 24h' }}
      />,
    );
    expect(screen.getByText('−1.2 pts')).toHaveClass('osa-metric-card__delta--bad');
  });

  it('shows a skeleton while loading and an error when the request failed', () => {
    const { rerender } = render(<MetricCard label="Adoption" value="—" loading />);
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);

    rerender(
      <MetricCard
        label="Adoption"
        value="—"
        error={httpError(503, 'Service Unavailable', 'catching up', null)}
        onRetry={() => undefined}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('The service failed');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('offers no retry for a failure retrying cannot fix', () => {
    render(
      <MetricCard
        label="Adoption"
        value="—"
        error={decodeError('overall.acknowledgementRate', 'ratio in [0, 1]', 'string')}
        onRetry={() => undefined}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('unexpected response');
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });
});

describe('StatusIndicator', () => {
  it('renders every level with a glyph and a label', () => {
    render(
      <>
        {STATUS_LEVELS.map((level) => (
          <StatusIndicator key={level} level={level} />
        ))}
      </>,
    );

    for (const label of ['On target', 'Watch', 'Off target', 'Critical', 'Not measured']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('never relies on colour alone — the glyph differs per level', () => {
    const { container } = render(
      <>
        {STATUS_LEVELS.map((level) => (
          <StatusIndicator key={level} level={level} />
        ))}
      </>,
    );

    const glyphs = Array.from(container.querySelectorAll('.osa-status__glyph')).map(
      (node) => node.textContent,
    );
    expect(new Set(glyphs).size).toBe(STATUS_LEVELS.length);
  });

  it('keeps the label available to assistive tech when it is visually dropped', () => {
    render(<StatusIndicator level="critical" dotOnly />);
    expect(screen.getByText('Critical')).toHaveClass('osa-visually-hidden');
  });

  it('takes a domain-specific label over the default wording for the level', () => {
    render(<StatusIndicator level="serious" label="Below revisit threshold" />);
    expect(screen.getByText('Below revisit threshold')).toBeInTheDocument();
  });
});

describe('DataTable', () => {
  const departments = sampleDepartmentalOutcomes();
  const columns: readonly Column<DepartmentalOutcome>[] = [
    { key: 'name', header: 'Department', render: (row) => row.departmentName },
    {
      key: 'index',
      header: 'Index',
      numeric: true,
      sortKey: 'index_asc',
      render: (row) => formatRatio(row.availabilityIndex),
    },
    {
      key: 'awaiting',
      header: 'Awaiting verification',
      numeric: true,
      render: (row) => formatCount(row.awaitingVerification),
    },
  ];

  const table = (overrides = {}) =>
    render(
      <DataTable
        caption="Departments"
        columns={columns}
        rows={departments}
        rowKey={(row) => row.departmentId}
        {...overrides}
      />,
    );

  it('renders a row per sample department', () => {
    table();
    expect(screen.getAllByRole('row')).toHaveLength(departments.length + 1);
    expect(screen.getByText('Produce')).toBeInTheDocument();
  });

  it('shows an unmeasured index as the placeholder rather than zero', () => {
    table();
    const bakery = screen.getByText('Bakery').closest('tr');
    expect(bakery).not.toBeNull();
    expect(within(bakery!).getByText('—')).toBeInTheDocument();
  });

  it('right-aligns and tabularises the numeric columns', () => {
    const { container } = table();
    const numeric = container.querySelectorAll('td.osa-table__cell--numeric');
    expect(numeric.length).toBe(departments.length * 2);
  });

  it('reports the active sort and its direction to assistive tech', () => {
    table({ activeSort: 'index_asc', onSort: () => undefined });
    expect(screen.getByRole('columnheader', { name: /Index/ })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );
  });

  it('asks for a new sort when a sortable header is clicked', () => {
    const onSort = vi.fn();
    table({ activeSort: 'index_asc', onSort });

    fireEvent.click(screen.getByRole('button', { name: /Index/ }));
    expect(onSort).toHaveBeenCalledWith('index_asc');
  });

  it('shows skeleton rows while loading so the table keeps its shape', () => {
    render(
      <DataTable caption="Departments" columns={columns} rows={[]} rowKey={() => ''} loading />,
    );
    expect(screen.getAllByRole('row').length).toBeGreaterThan(1);
  });

  it('shows the empty message when the scope matched nothing', () => {
    render(<DataTable caption="Departments" columns={columns} rows={[]} rowKey={() => ''} />);
    expect(screen.getByText('No rows for this scope.')).toBeInTheDocument();
  });

  it('replaces the table with the error when there is nothing to fall back to', () => {
    render(
      <DataTable
        caption="Departments"
        columns={columns}
        rows={[]}
        rowKey={() => ''}
        error={httpError(403, 'Forbidden', null, null)}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Not available for this retailer');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('keeps the rows and adds the error beneath when a refresh failed', () => {
    table({ error: httpError(503, 'Service Unavailable', null, null) });
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('shows how many of the estimated total are on screen', () => {
    table({ totalEstimate: 1240 });
    expect(screen.getByText(/Showing 5 of ~1,240/)).toBeInTheDocument();
  });
});

describe('LineChart', () => {
  const availability = sampleAvailabilityIndexReport();

  const chart = (overrides = {}) =>
    render(
      <LineChart
        title="Availability index by hour"
        categories={availability.series.map((_, index) => `${index}:00`)}
        series={[
          {
            key: 'index',
            label: 'Availability index',
            values: availability.series.map((point) => point.index),
          },
        ]}
        formatValue={formatRatio}
        {...overrides}
      />,
    );

  it('renders the sample series', () => {
    chart();
    expect(screen.getByRole('img', { name: 'Availability index by hour' })).toBeInTheDocument();
  });

  it('breaks the line where nothing was measured instead of plotting zero', () => {
    const { container } = chart();
    const path = container.querySelector('path[stroke]');
    expect(path).not.toBeNull();
    // A second `M` command is a pen-up: the line restarts after the gap.
    expect((path!.getAttribute('d') ?? '').match(/M/g)?.length).toBeGreaterThan(1);
  });

  it('shows no legend for a single series and one for two', () => {
    const { container, rerender } = chart();
    expect(container.querySelector('.osa-chart__legend')).toBeNull();

    rerender(
      <LineChart
        title="Gaps"
        categories={['00:00', '01:00']}
        series={[
          { key: 'detected', label: 'Detected', values: [4, 6] },
          { key: 'verified', label: 'Verified', values: [3, 5] },
        ]}
        formatValue={formatCount}
      />,
    );
    expect(screen.getByText('Detected')).toBeInTheDocument();
    expect(screen.getByText('Verified')).toBeInTheDocument();
  });

  it('says so plainly when the whole window is unmeasured', () => {
    render(
      <LineChart
        title="Availability index"
        categories={['00:00', '01:00']}
        series={[{ key: 'index', label: 'Index', values: [null, null] }]}
        formatValue={formatRatio}
      />,
    );
    expect(screen.getByText('Nothing measured in this window.')).toBeInTheDocument();
  });

  it('shows a tooltip naming the bucket when the plot is hovered', () => {
    const gapRate = sampleResolvedGapRateReport();
    const { container } = render(
      <LineChart
        title="Gaps detected"
        categories={gapRate.series.map((_, index) => `bucket-${index}`)}
        series={[
          {
            key: 'detected',
            label: 'Detected',
            values: gapRate.series.map((point) => point.detectedGaps),
          },
        ]}
        formatValue={formatCount}
      />,
    );

    const hitArea = container.querySelector('rect[fill="transparent"]');
    expect(hitArea).not.toBeNull();
    // jsdom lays nothing out, so the hit area has no width and the crosshair
    // would have no coordinate space to map a pointer into. Stubbing the rect is
    // what stands in for a browser having done the layout.
    hitArea!.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 560, height: 220, right: 560, bottom: 220, x: 0, y: 0 }) as DOMRect;
    fireEvent.mouseMove(hitArea!, { clientX: 120 });

    expect(container.querySelector('.osa-chart__tooltip')).not.toBeNull();
  });
});

describe('BarChart', () => {
  const latency = sampleDetectionToResolutionReport();

  it('renders one labelled bar per loop stage with a direct value label', () => {
    render(
      <BarChart
        title="Median latency by loop stage"
        data={LOOP_STAGES.map((stage) => ({
          key: stage,
          label: LOOP_STAGE_LABELS[stage],
          value: latency.overall[stage].p50,
        }))}
        formatValue={(value) => formatDuration(millis(value))}
      />,
    );

    expect(screen.getByText('Detection → task')).toBeInTheDocument();
    expect(screen.getByText('4m')).toBeInTheDocument();
    expect(screen.getByText('3h 40m')).toBeInTheDocument();
  });

  it('marks a stage with no sample as not measured rather than drawing a zero bar', () => {
    const { container } = render(
      <BarChart
        title="Median latency"
        data={[
          { key: 'a', label: 'Detection → task', value: 240_000 },
          { key: 'b', label: 'Assignment → acknowledgement', value: null },
        ]}
        formatValue={(value) => formatDuration(millis(value))}
      />,
    );

    expect(screen.getByText('not measured')).toBeInTheDocument();
    expect(container.querySelectorAll('rect').length).toBeGreaterThan(0);
  });
});

describe('Sparkline', () => {
  it('plots a sample trend and says when there is not enough of one', () => {
    const { rerender } = render(<Sparkline values={[1, 2, null, 4]} label="Index trend" />);
    expect(screen.getByRole('img', { name: 'Index trend' })).toBeInTheDocument();

    rerender(<Sparkline values={[null, null]} label="Index trend" />);
    expect(screen.getByText('Index trend: not enough data')).toBeInTheDocument();
  });
});

describe('AsyncBoundary', () => {
  const departments = sampleDepartmentalOutcomes();
  const body = (rows: readonly DepartmentalOutcome[]) => <p>{rows.length} departments</p>;

  it('renders the value once it has loaded', () => {
    render(
      <AsyncBoundary data={succeed(departments, SAMPLE_NOW)} now={SAMPLE_NOW}>
        {body}
      </AsyncBoundary>,
    );
    expect(screen.getByText('5 departments')).toBeInTheDocument();
  });

  it('shows a placeholder while the first load is in flight', () => {
    render(
      <AsyncBoundary
        data={beginLoad(idle<readonly DepartmentalOutcome[]>(), requestId(1), SAMPLE_NOW)}
        now={SAMPLE_NOW}
      >
        {body}
      </AsyncBoundary>,
    );
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('keeps the previous value visible through a refresh, and says it is stale', () => {
    render(
      <AsyncBoundary
        data={beginLoad(succeed(departments, SAMPLE_NOW), requestId(2), SAMPLE_NOW)}
        now={SAMPLE_NOW}
      >
        {body}
      </AsyncBoundary>,
    );
    expect(screen.getByText('5 departments')).toBeInTheDocument();
    expect(screen.getByText(/Showing data from/)).toBeInTheDocument();
  });

  it('keeps the last good value when a refresh fails, with the error beneath it', () => {
    const refreshing = beginLoad(succeed(departments, SAMPLE_NOW), requestId(2), SAMPLE_NOW);
    render(
      <AsyncBoundary
        data={failed(refreshing, httpError(503, 'Service Unavailable', null, null), SAMPLE_NOW)}
        now={SAMPLE_NOW}
      >
        {body}
      </AsyncBoundary>,
    );
    expect(screen.getByText('5 departments')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('shows only the error when the first load failed with nothing to keep', () => {
    const loading = beginLoad(idle<readonly DepartmentalOutcome[]>(), requestId(1), SAMPLE_NOW);
    render(
      <AsyncBoundary
        data={failed(loading, httpError(500, 'Internal Server Error', null, null), SAMPLE_NOW)}
        now={SAMPLE_NOW}
      >
        {body}
      </AsyncBoundary>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('5 departments')).not.toBeInTheDocument();
  });

  it('treats a loaded-but-empty result as empty, not as a value', () => {
    render(
      <AsyncBoundary
        data={succeed<readonly DepartmentalOutcome[]>([], SAMPLE_NOW)}
        now={SAMPLE_NOW}
        isEmpty={(rows) => rows.length === 0}
      >
        {body}
      </AsyncBoundary>,
    );
    expect(screen.getByText('No rows for this scope.')).toBeInTheDocument();
  });
});
