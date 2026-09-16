import { describe, expect, it } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import {
  DashboardProvider,
  useDashboardEffects,
  useDashboardSelector,
} from '../src/state/react/context';
import { MetricCard } from '../src/components/MetricCard';
import { AsyncBoundary } from '../src/components/AsyncStates';
import { DataTable } from '../src/components/DataTable';
import type { Column } from '../src/components/DataTable';
import {
  selectAvailabilityOverall,
  selectAvailabilityStatus,
  selectDepartmentsByIndex,
} from '../src/state/selectors';
import type { DashboardState } from '../src/state/dashboard-state';
import type { DepartmentalOutcome } from '../src/models/departmental';
import { formatRatio, formatWholePercent } from '../src/models/format';
import { retailerId } from '../src/models/ids';
import { createSampleApi } from '../src/fixtures/sample-api';
import { SAMPLE_NOW } from '../src/fixtures/sample-data';
import { httpError } from '../src/services/errors';
import type { DashboardApi } from '../src/services/reporting.client';

/**
 * The state layer, the effects and the shared components wired together against
 * the sample API.
 *
 * This is the isolation harness at full depth: the panels run exactly the code
 * they would against the real service, with only the transport swapped. What it
 * proves is the part that unit tests of either half cannot — that a fetch really
 * does move a card from skeleton to figure, and that a failure really does reach
 * the panel as words rather than as a blank.
 */

const RETAILER = retailerId('rt-northfield');

const AvailabilityPanel = () => {
  const effects = useDashboardEffects();
  const data = useDashboardSelector(selectAvailabilitySlice);
  const overall = useDashboardSelector(selectAvailabilityOverall);
  const status = useDashboardSelector(selectAvailabilityStatus);

  useEffect(() => {
    void effects.loadAvailabilityIndex();
  }, [effects]);

  return (
    <MetricCard
      label="Availability index"
      value={formatRatio(overall?.index ?? null)}
      status={status}
      loading={data.status === 'loading'}
      error={data.status === 'error' ? data.error : null}
      footnote={
        overall === null
          ? undefined
          : `Measured over ${formatWholePercent(overall.coverage)} of facing-time`
      }
    />
  );
};

const selectAvailabilitySlice = (state: DashboardState) => state.availabilityIndex;
const selectDepartmentsSlice = (state: DashboardState) => state.departmentalOutcomes;

const departmentColumns: readonly Column<DepartmentalOutcome>[] = [
  { key: 'name', header: 'Department', render: (row) => row.departmentName },
  { key: 'index', header: 'Index', numeric: true, render: (row) => formatRatio(row.availabilityIndex) },
];

const DepartmentsPanel = () => {
  const effects = useDashboardEffects();
  const data = useDashboardSelector(selectDepartmentsSlice);
  const rows = useDashboardSelector(selectDepartmentsByIndex);

  useEffect(() => {
    void effects.loadDepartmentalOutcomes();
  }, [effects]);

  return (
    <AsyncBoundary data={data} now={SAMPLE_NOW} isEmpty={(value) => value.length === 0}>
      {() => (
        <DataTable
          caption="Departments, worst first"
          columns={departmentColumns}
          rows={rows}
          rowKey={(row) => row.departmentId}
        />
      )}
    </AsyncBoundary>
  );
};

const mount = (api: DashboardApi) =>
  render(
    <DashboardProvider api={api} retailerId={RETAILER} clock={() => SAMPLE_NOW} tickInterval={0}>
      <AvailabilityPanel />
      <DepartmentsPanel />
    </DashboardProvider>,
  );

describe('dashboard integration', () => {
  it('takes a metric card from skeleton to figure', async () => {
    await act(async () => {
      mount(createSampleApi());
    });

    expect(await screen.findByText('96.8%')).toBeInTheDocument();
    expect(screen.getByText(/Measured over 78% of facing-time/)).toBeInTheDocument();
    expect(screen.getByText('Watch')).toBeInTheDocument();
  });

  it('fills a table from the departmental outcomes, worst first', async () => {
    await act(async () => {
      mount(createSampleApi());
    });

    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('Produce');
    // The unmeasured department is ranked last, not first, and shows no zero.
    expect(rows[rows.length - 1]).toHaveTextContent('Bakery');
    expect(rows[rows.length - 1]).toHaveTextContent('—');
  });

  it('puts a service failure in front of the reader as words, not as a blank panel', async () => {
    await act(async () => {
      mount(createSampleApi({ failWith: httpError(503, 'Service Unavailable', 'catching up', null) }));
    });

    const alerts = await screen.findAllByRole('alert');
    expect(alerts[0]).toHaveTextContent('The service failed');
    expect(screen.queryByText('96.8%')).not.toBeInTheDocument();
  });

  it('grades an unloaded card as unknown rather than as on target', () => {
    // A promise that never settles: the card stays in its first-load state.
    const api = createSampleApi({ latency: 10_000 });
    render(
      <DashboardProvider api={api} retailerId={RETAILER} clock={() => SAMPLE_NOW} tickInterval={0}>
        <AvailabilityPanel />
      </DashboardProvider>,
    );

    // The value is still a skeleton, but the status is already reported — and it
    // reports "not measured", not "on target". A card with nothing in it must
    // never look like good news.
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
    expect(screen.getByText('Not measured')).toBeInTheDocument();
    expect(screen.queryByText('96.8%')).not.toBeInTheDocument();
  });
});
