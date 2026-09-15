import { describe, expect, it } from 'vitest';
import {
  DAY,
  HOUR,
  InMemoryAuditArtifactStore,
  ReportingAdapter,
  ReportingQueryError,
  TASK_TYPES,
  appendEvent,
  auditEntryId,
  canonicalJson,
  categoryId,
  confidence,
  createFacing,
  departmentId,
  eventId,
  facingId,
  gapId,
  instant,
  millis,
  signalId,
  storeId,
  taskId,
  timeWindow,
  toISO,
  type AuditArtifactId,
  type AuditLogEntry,
  type Facing,
  type FacingStateEvent,
  type Instant,
  type LoopOutcomeRecord,
  type ReportScope,
  type ReportingFacing,
  type ShelfState,
  type TimeWindow,
} from '../src/index.js';
import { ACME, CEREAL_GROCERY, DAIRY_FRESH, PRODUCT, STORE, hour } from './support/fixtures.js';
import { InMemoryReadModel } from './support/in-memory-read-model.js';

/**
 * The read side, end to end.
 *
 * The assertions that matter here are not "does it return a number" but "is it
 * the *same* number the domain would compute, and does the artifact substantiate
 * the report". A read side that quietly re-implements the index is the failure
 * mode this suite exists to catch.
 */

const DAY_0 = hour(0);
const DAY_1 = instant(DAY_0 + DAY);

const WINDOW: TimeWindow = timeWindow(DAY_0, DAY_1);

const scope = (overrides: Partial<ReportScope> = {}): ReportScope => ({
  retailerId: ACME,
  storeIds: null,
  productIds: null,
  window: WINDOW,
  granularity: 'period',
  breakdownBy: [],
  ...overrides,
});

let sequence = 0;

/** Appends a transition to a facing, minting the bookkeeping the domain requires. */
const transition = (
  facing: Facing,
  at: Instant,
  to: ShelfState,
  source: FacingStateEvent['cause']['source'] = 'arpalus_detection',
): Facing => {
  sequence += 1;
  const event: FacingStateEvent = {
    eventId: eventId(`evt-${sequence}`),
    retailerId: facing.retailerId,
    storeId: facing.storeId,
    facingId: facing.facingId,
    sequence: facing.history.events.length + 1,
    at,
    from: facing.history.events.at(-1)?.to ?? facing.history.initialState,
    to,
    cause: { source, signalId: signalId(`sig-${sequence}`), confidence: confidence(0.9) },
  };
  return { ...facing, state: to, history: appendEvent(facing.history, event) };
};

const facingRow = (
  id: string,
  aisle: string,
  classification = DAIRY_FRESH,
  initialState: ShelfState = 'in_stock',
  store = STORE,
): ReportingFacing => ({
  retailerId: ACME,
  classification,
  facing: createFacing({
    retailerId: ACME,
    storeId: store,
    facingId: facingId(id),
    productId: PRODUCT,
    location: { aisle, bay: 'B1', shelf: 1, position: 1 },
    capacityUnits: 12,
    createdAt: DAY_0,
    initialState,
  }),
});

const withHistory = (
  row: ReportingFacing,
  ...steps: readonly (readonly [Instant, ShelfState])[]
): ReportingFacing => ({
  ...row,
  facing: steps.reduce((facing, [at, state]) => transition(facing, at, state), row.facing),
});

const adapterOver = (readModel: InMemoryReadModel, now: Instant = DAY_1) =>
  new ReportingAdapter({ readModel, now: () => now });

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

describe('reporting adapter — availability', () => {
  it('scores facing-time in stock, not facings', async () => {
    const model = new InMemoryReadModel(DAY_0).withFacings(
      // Out of stock for the last six hours of the day: 18 of 24 in stock.
      withHistory(facingRow('f-1', 'A1'), [instant(DAY_0 + 18 * HOUR), 'out_of_stock']),
      facingRow('f-2', 'A1'),
    );

    const report = await adapterOver(model).availabilityIndex(scope());

    expect(report.overall.facingCount).toBe(2);
    expect(report.overall.index).toBeCloseTo((18 + 24) / 48, 10);
    expect(report.overall.coverage).toBe(1);
  });

  it('excludes unmeasured time from both sides rather than guessing at it', async () => {
    const model = new InMemoryReadModel(DAY_0).withFacings(
      // Unknown for the first half of the day, in stock for the second.
      withHistory(facingRow('f-1', 'A1', DAIRY_FRESH, 'unknown'), [
        instant(DAY_0 + 12 * HOUR),
        'in_stock',
      ]),
    );

    const report = await adapterOver(model).availabilityIndex(scope());

    // A camera outage is not an empty shelf, and it is not a full one either.
    expect(report.overall.index).toBe(1);
    expect(report.overall.coverage).toBeCloseTo(0.5, 10);
    expect(report.overall.unknownFacingMillis).toBe(millis(12 * HOUR));
  });

  it('reports a null index, never zero, when nothing was measured', async () => {
    const model = new InMemoryReadModel(DAY_0).withFacings(
      facingRow('f-1', 'A1', DAIRY_FRESH, 'unknown'),
    );

    const report = await adapterOver(model).availabilityIndex(scope());
    expect(report.overall.index).toBeNull();
  });

  it('buckets the series at the requested granularity', async () => {
    const model = new InMemoryReadModel(DAY_0).withFacings(
      withHistory(facingRow('f-1', 'A1'), [instant(DAY_0 + 12 * HOUR), 'out_of_stock']),
    );

    const report = await adapterOver(model).availabilityIndex(scope({ granularity: 'hour' }));

    expect(report.series).toHaveLength(24);
    expect(report.series[0]?.index).toBe(1);
    expect(report.series[23]?.index).toBe(0);
  });

  it('cuts by every dimension a facing actually has', async () => {
    const model = new InMemoryReadModel(DAY_0).withFacings(
      withHistory(facingRow('f-1', 'A1', DAIRY_FRESH), [
        instant(DAY_0 + 12 * HOUR),
        'out_of_stock',
      ]),
      facingRow('f-2', 'A2', CEREAL_GROCERY),
    );

    const report = await adapterOver(model).availabilityIndex(
      scope({ breakdownBy: ['department', 'aisle'] }),
    );

    const fresh = report.breakdowns.find(
      (entry) => entry.dimension === 'department' && entry.key === 'fresh',
    );
    expect(fresh?.value.index).toBeCloseTo(0.5, 10);
    expect(report.breakdowns.filter((entry) => entry.dimension === 'aisle')).toHaveLength(2);
  });

  it('refuses a breakdown the read model cannot honestly produce', async () => {
    const model = new InMemoryReadModel(DAY_0).withFacings(facingRow('f-1', 'A1'));

    await expect(
      adapterOver(model).availabilityIndex(scope({ breakdownBy: ['task_type'] })),
    ).rejects.toBeInstanceOf(ReportingQueryError);
  });

  it('narrows to the stores the caller scoped to', async () => {
    const other = storeId('acme-0099');
    const model = new InMemoryReadModel(DAY_0).withFacings(
      facingRow('f-1', 'A1'),
      facingRow('f-2', 'A1', DAIRY_FRESH, 'in_stock', other),
    );

    const report = await adapterOver(model).availabilityIndex(scope({ storeIds: [other] }));
    expect(report.overall.facingCount).toBe(1);
  });

  it('rejects a read model row from another partition instead of pooling it', async () => {
    const model = new InMemoryReadModel(DAY_0);
    model.facingRows.push({
      ...facingRow('f-1', 'A1'),
      retailerId: ACME,
      facing: { ...facingRow('f-1', 'A1').facing, retailerId: 'rival-mart' as typeof ACME },
    });

    await expect(adapterOver(model).availabilityIndex(scope())).rejects.toBeInstanceOf(
      ReportingQueryError,
    );
  });
});

describe('reporting adapter — per-facing records', () => {
  const populated = () =>
    new InMemoryReadModel(DAY_0).withFacings(
      withHistory(
        facingRow('f-bad', 'A1'),
        [instant(DAY_0 + 2 * HOUR), 'out_of_stock'],
        [instant(DAY_0 + 4 * HOUR), 'in_stock'],
        [instant(DAY_0 + 6 * HOUR), 'out_of_stock'],
      ),
      withHistory(facingRow('f-ok', 'A2'), [instant(DAY_0 + 23 * HOUR), 'out_of_stock']),
      facingRow('f-unknown', 'A3', DAIRY_FRESH, 'unknown'),
    );

  it('counts every out-of-stock transition, not every empty facing', async () => {
    const page = await adapterOver(populated()).availabilityRecords({
      scope: scope(),
      sort: 'gap_count_desc',
      minGapCount: null,
      page: { limit: 10, cursor: null },
    });

    expect(page.items[0]?.facingId).toBe('f-bad');
    expect(page.items[0]?.gapCount).toBe(2);
  });

  it('sorts unmeasured facings last even when ordering worst-first', async () => {
    const page = await adapterOver(populated()).availabilityRecords({
      scope: scope(),
      sort: 'index_asc',
      minGapCount: null,
      page: { limit: 10, cursor: null },
    });

    // "We could not see this shelf" is not the worst availability in the store.
    expect(page.items.map((record) => record.facingId)).toEqual(['f-bad', 'f-ok', 'f-unknown']);
    expect(page.items.at(-1)?.index).toBeNull();
  });

  it('carries the sources that contributed, for judging how well observed a facing was', async () => {
    const page = await adapterOver(populated()).availabilityRecords({
      scope: scope(),
      sort: 'gap_count_desc',
      minGapCount: 1,
      page: { limit: 10, cursor: null },
    });

    expect(page.items).toHaveLength(2);
    expect(page.items[0]?.contributingSources).toEqual(['arpalus_detection']);
  });

  it('pages through an opaque cursor without dropping or repeating a row', async () => {
    const adapter = adapterOver(populated());
    const first = await adapter.availabilityRecords({
      scope: scope(),
      sort: 'index_asc',
      minGapCount: null,
      page: { limit: 2, cursor: null },
    });
    const second = await adapter.availabilityRecords({
      scope: scope(),
      sort: 'index_asc',
      minGapCount: null,
      page: { limit: 2, cursor: first.nextCursor },
    });

    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((r) => r.facingId)).size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Loop metrics
// ---------------------------------------------------------------------------

const outcome = (overrides: Partial<LoopOutcomeRecord>): LoopOutcomeRecord => ({
  retailerId: ACME,
  storeId: STORE,
  facingId: facingId('f-1'),
  productId: PRODUCT,
  departmentId: departmentId('fresh'),
  categoryId: categoryId('dairy'),
  gapId: gapId('gap-1'),
  kind: 'availability_gap',
  taskId: taskId('task-1'),
  taskType: 'restock_out_of_stock',
  detectedAt: instant(DAY_0 + HOUR),
  taskCreatedAt: instant(DAY_0 + HOUR + 60_000),
  assignedAt: instant(DAY_0 + HOUR + 5 * 60_000),
  acknowledgedAt: instant(DAY_0 + HOUR + 7 * 60_000),
  lastAcknowledgedAt: instant(DAY_0 + HOUR + 7 * 60_000),
  resolvedAt: instant(DAY_0 + HOUR + 20 * 60_000),
  verifiedAt: instant(DAY_0 + 2 * HOUR),
  backInStockAt: instant(DAY_0 + HOUR + 20 * 60_000),
  reopenCount: 0,
  terminal: 'verified',
  ...overrides,
});

describe('reporting adapter — loop metrics', () => {
  it('reports throughput, completion and rework over the detection cohort', async () => {
    const model = new InMemoryReadModel(DAY_0).withOutcomes(
      outcome({}),
      outcome({ gapId: gapId('gap-2'), verifiedAt: null, terminal: null, reopenCount: 1 }),
      outcome({ gapId: gapId('gap-3'), terminal: 'cancelled', verifiedAt: null }),
    );

    const report = await adapterOver(model).taskWorkRate(scope());

    expect(report.overall.created).toBe(3);
    expect(report.overall.verified).toBe(1);
    expect(report.overall.reopened).toBe(1);
    expect(report.overall.cancelled).toBe(1);
    expect(report.overall.outstanding).toBe(1);
    expect(report.overall.completionRate).toBeCloseTo(1 / 3, 10);
    expect(report.overall.reworkRate).toBeCloseTo(1 / 3, 10);
  });

  it('leaves the per-labour-hour rate null rather than estimating it', async () => {
    const model = new InMemoryReadModel(DAY_0).withOutcomes(outcome({}));

    const withoutFeed = await adapterOver(model).taskWorkRate(scope());
    expect(withoutFeed.overall.labourHours).toBeNull();
    expect(withoutFeed.overall.tasksPerLabourHour).toBeNull();

    model.labour = 40;
    const withFeed = await adapterOver(model).taskWorkRate(scope());
    expect(withFeed.overall.tasksPerLabourHour).toBeCloseTo(1 / 40, 10);
  });

  it('keeps gaps still inside their verification window out of the resolved rate', async () => {
    const model = new InMemoryReadModel(DAY_0).withOutcomes(
      outcome({}),
      // Resolved twenty minutes before the report was cut: it cannot have
      // produced two clean passes yet, so it is not counted against the rate.
      outcome({
        gapId: gapId('gap-2'),
        detectedAt: instant(DAY_1 - HOUR),
        resolvedAt: instant(DAY_1 - 20 * 60_000),
        verifiedAt: null,
        terminal: null,
      }),
    );

    const report = await adapterOver(model).resolvedGapRate(scope());

    expect(report.overall.detectedGaps).toBe(2);
    expect(report.overall.awaitingVerification).toBe(1);
    expect(report.overall.resolvedGapRate).toBe(1);
  });

  it('attributes latency stage by stage rather than as one total', async () => {
    const model = new InMemoryReadModel(DAY_0).withOutcomes(outcome({}));

    const report = await adapterOver(model).detectionToResolution(scope());

    expect(report.overall.detectionToTask.p50).toBe(millis(60_000));
    expect(report.overall.detectionToVerification.p50).toBe(millis(HOUR));
    expect(report.overall.resolutionToVerification.p50).toBe(millis(40 * 60_000));
  });

  it('offers every task type as a filter, not only the ones recently raised', async () => {
    const types = await adapterOver(new InMemoryReadModel(DAY_0)).reportableTaskTypes(ACME);
    expect(types).toEqual(TASK_TYPES);
  });
});

// ---------------------------------------------------------------------------
// Audit export
// ---------------------------------------------------------------------------

const auditEntry = (id: string, at: Instant, store = STORE): AuditLogEntry => ({
  entryId: auditEntryId(id),
  retailerId: ACME,
  storeId: store,
  at,
  actor: { kind: 'system', component: 'verification-loop' },
  action: 'task.verified',
  subject: { kind: 'task', taskId: taskId('task-1') },
  before: null,
  after: 'verified',
  correlationId: 'corr-1',
});

describe('reporting adapter — audit export', () => {
  const exportable = () => {
    const row = withHistory(
      facingRow('f-1', 'A1'),
      [instant(DAY_0 + 6 * HOUR), 'out_of_stock'],
      [instant(DAY_0 + 9 * HOUR), 'in_stock'],
    );
    const model = new InMemoryReadModel(DAY_0).withFacings(row);

    // Provenance for the first transition only, so the export has to report the
    // second one's as absent rather than inheriting the first's camera.
    const first = row.facing.history.events[0];
    if (first !== undefined) {
      model.provenance.set(first.cause.signalId, {
        instanceId: 'camera-7',
        softwareVersion: 'arpalus-4.2.1',
      });
    }
    return model;
  };

  it('carries the carry-in state and every transition, so the index can be recomputed', async () => {
    const page = await adapterOver(exportable()).exportFacingStateLog({
      scope: { retailerId: ACME, period: WINDOW, productIds: null, storeIds: null },
      page: { limit: 10, cursor: null },
    });

    const record = page.items[0];
    expect(record?.stateAtPeriodStart).toBe('in_stock');
    expect(record?.transitions).toHaveLength(2);
    expect(record?.reportedOutOfStockMillis).toBe(millis(3 * HOUR));
    expect(record?.reportedIndex).toBeCloseTo(21 / 24, 10);
  });

  it('recomputes to the figure the report published, from the export alone', async () => {
    const model = exportable();
    const adapter = adapterOver(model);

    const report = await adapter.availabilityIndex(scope());
    const page = await adapter.exportFacingStateLog({
      scope: { retailerId: ACME, period: WINDOW, productIds: null, storeIds: null },
      page: { limit: 100, cursor: null },
    });

    const inStock = page.items.reduce((total, r) => total + r.reportedInStockMillis, 0);
    const measured = page.items.reduce((total, r) => total + r.reportedMeasuredMillis, 0);

    // This is the whole contract: an auditor holding the export arrives at the
    // number the retailer was shown.
    expect(inStock / measured).toBeCloseTo(report.overall.index ?? Number.NaN, 12);
  });

  it('names which camera and which build stood behind a transition', async () => {
    const page = await adapterOver(exportable()).exportFacingStateLog({
      scope: { retailerId: ACME, period: WINDOW, productIds: null, storeIds: null },
      page: { limit: 10, cursor: null },
    });

    const transitions = page.items[0]?.transitions ?? [];
    const firstWithProvenance = transitions.find((entry) => entry.producerInstanceId !== null);
    expect(firstWithProvenance?.producerInstanceId).toBe('camera-7');
    expect(firstWithProvenance?.producerSoftwareVersion).toBe('arpalus-4.2.1');
    // A transition whose provenance aged out says so, rather than inventing one.
    expect(transitions.some((entry) => entry.producerInstanceId === null)).toBe(true);
  });

  it('keeps retailer-level trail entries in a store-scoped export', async () => {
    const model = exportable();
    model.audit.push(auditEntry('a-1', instant(DAY_0 + HOUR)), {
      ...auditEntry('a-2', instant(DAY_0 + 2 * HOUR)),
      storeId: null,
      action: 'lane_map.overridden',
      subject: { kind: 'retailer' },
    });

    const page = await adapterOver(model).exportAuditTrail({
      scope: { retailerId: ACME, period: WINDOW, productIds: null, storeIds: [STORE] },
      page: { limit: 10, cursor: null },
    });

    expect(page.items.map((entry) => entry.entryId)).toEqual(['a-1', 'a-2']);
  });

  it('seals a deterministic artifact: same scope, same bytes, same hash', async () => {
    const store = new InMemoryAuditArtifactStore();
    const adapter = new ReportingAdapter({
      readModel: exportable(),
      artifacts: store,
      now: () => DAY_1,
    });
    const request = {
      scope: { retailerId: ACME, period: WINDOW, productIds: null, storeIds: null },
      format: 'application/json' as const,
      includeActionTrail: false,
    };

    const first = await adapter.sealArtifact(request);
    const second = await adapter.sealArtifact(request);

    expect(second.integrity.contentHash).toBe(first.integrity.contentHash);
    expect(second.artifactId).toBe(first.artifactId);
    expect(first.integrity.algorithm).toBe('sha-256');
    expect(store.body(ACME, first.artifactId)).toBe(store.body(ACME, second.artifactId));
  });

  it('substantiates its own reported index from the records in its body', async () => {
    const adapter = adapterOver(exportable());
    const sealed = await adapter.sealArtifact({
      scope: { retailerId: ACME, period: WINDOW, productIds: null, storeIds: null },
      format: 'application/json',
      includeActionTrail: false,
    });

    expect(sealed.reportedIndex.index).toBeCloseTo(21 / 24, 10);
    expect(sealed.reportedIndex.facingCount).toBe(1);
    expect(sealed.completeness.transitionCount).toBe(2);
    expect(sealed.completeness.sourcesRepresented).toEqual(['arpalus_detection']);
  });

  it('declares the gaps it knows about rather than exporting around them', async () => {
    const model = exportable();
    const outage = timeWindow(instant(DAY_0 + 3 * HOUR), instant(DAY_0 + 4 * HOUR));
    model.outages = [outage];
    model.incomplete = [facingId('f-truncated')];

    const sealed = await adapterOver(model).sealArtifact({
      scope: { retailerId: ACME, period: WINDOW, productIds: null, storeIds: null },
      format: 'application/json',
      includeActionTrail: false,
    });

    expect(sealed.completeness.unobservedIntervals).toEqual([outage]);
    expect(sealed.completeness.incompleteFacings).toEqual(['f-truncated']);
  });

  it('truncates a scope reaching past retention, and labels the truncation', async () => {
    const model = exportable();
    model.retainedFrom = instant(DAY_0 + 6 * HOUR);

    const sealed = await adapterOver(model).sealArtifact({
      scope: {
        retailerId: ACME,
        period: WINDOW,
        productIds: null,
        storeIds: null,
      },
      format: 'application/json',
      includeActionTrail: false,
    });

    // Twelve months asked for, what is retained returned — clearly labelled.
    expect(sealed.scope.period.from).toBe(instant(DAY_0 + 6 * HOUR));
    expect(sealed.scope.period.to).toBe(DAY_1);
  });

  it('renders NDJSON and CSV bodies that hash differently from the JSON one', async () => {
    const store = new InMemoryAuditArtifactStore();
    const adapter = new ReportingAdapter({
      readModel: exportable(),
      artifacts: store,
      now: () => DAY_1,
    });
    const base = {
      scope: { retailerId: ACME, period: WINDOW, productIds: null, storeIds: null },
      includeActionTrail: false,
    };

    const json = await adapter.sealArtifact({ ...base, format: 'application/json' });
    const ndjson = await adapter.sealArtifact({ ...base, format: 'application/x-ndjson' });
    const csv = await adapter.sealArtifact({ ...base, format: 'text/csv' });

    const hashes = [json, ndjson, csv].map((artifact) => artifact.integrity.contentHash);
    expect(new Set(hashes).size).toBe(3);
    expect(store.body(ACME, csv.artifactId)?.split('\n')[0]).toContain('facingId');
    expect(store.body(ACME, csv.artifactId)).toContain(toISO(WINDOW.from));
  });

  it('re-reads a sealed manifest, and nothing from another partition', async () => {
    const adapter = adapterOver(exportable());
    const sealed = await adapter.sealArtifact({
      scope: { retailerId: ACME, period: WINDOW, productIds: null, storeIds: null },
      format: 'application/json',
      includeActionTrail: false,
    });

    expect((await adapter.getArtifact(ACME, sealed.artifactId))?.artifactId).toBe(sealed.artifactId);
    expect(await adapter.getArtifact('rival-mart' as typeof ACME, sealed.artifactId)).toBeNull();
    expect(await adapter.getArtifact(ACME, 'no-such-artifact' as AuditArtifactId)).toBeNull();
  });

  it('signs the content hash when the retailer’s plan includes signing', async () => {
    const adapter = new ReportingAdapter({
      readModel: exportable(),
      now: () => DAY_1,
      signer: {
        signedBy: 'osa-attestation-key-1',
        sign: async (contentHash) => `sig:${contentHash.slice(0, 8)}`,
      },
    });

    const sealed = await adapter.sealArtifact({
      scope: { retailerId: ACME, period: WINDOW, productIds: null, storeIds: null },
      format: 'application/json',
      includeActionTrail: false,
    });

    expect(sealed.integrity.signedBy).toBe('osa-attestation-key-1');
    expect(sealed.integrity.signature).toBe(`sig:${sealed.integrity.contentHash.slice(0, 8)}`);
  });

  it('publishes what is still exportable and the schema it is exported under', async () => {
    const adapter = adapterOver(exportable());

    expect(await adapter.describeRetentionPolicy(ACME)).toMatchObject({
      retailerId: ACME,
      retainedFrom: DAY_0,
    });
    expect((await adapter.describeSchemaContract()).schemaName).toBe('osa.audit-export');
  });

  it('canonicalises JSON so a re-ordered object hashes the same', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] })).toBe(
      canonicalJson({ a: [2, { c: 3, d: 4 }], b: 1 }),
    );
  });
});
