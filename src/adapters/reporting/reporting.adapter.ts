import type { AuditLogEntry } from '../../domain/audit/audit-log.js';
import type { FacingId, RetailerId, SignalId } from '../../domain/common/ids.js';
import { millis, plus, timeWindow, type Instant, type TimeWindow } from '../../domain/common/time.js';
import { eventsWithin, stateAt } from '../../domain/facing/event-history.js';
import type { SignalSource } from '../../domain/facing/signals.js';
import { TASK_TYPES, type TaskType } from '../../domain/task/task-type.js';
import {
  computeFacingAvailability,
  timelineFor,
} from '../../domain/availability/availability-index.js';
import {
  bucketsFor,
  computeDetectionToResolution,
  computeResolvedGapRate,
  computeTaskWorkRate,
  type OutcomeDimension,
  type OutcomeMetricsInput,
} from '../../application/outcome-metrics.js';
import type { Page } from '../../ports/common/paging.js';
import type { SchemaContract } from '../../ports/common/schema-contract.js';
import {
  AUDIT_EXPORT_SCHEMA_CONTRACT,
  CURRENT_AUDIT_EXPORT_SCHEMA_VERSION,
  type AuditArtifactId,
  type AuditCompleteness,
  type AuditExportArtifact,
  type AuditExportPort,
  type AuditExportRequest,
  type AuditExportScope,
  type AuditRetentionPolicy,
  type AuditTrailQuery,
  type AuditedTransition,
  type FacingStateAuditRecord,
  type FacingStateLogQuery,
} from '../../ports/inbound/audit-export.port.js';
import type {
  AvailabilityIndexReport,
  AvailabilityRecord,
  AvailabilityRecordQuery,
  DetectionToResolutionReport,
  ReportDimension,
  ReportScope,
  ReportingPort,
  ResolvedGapRateReport,
  TaskWorkRateReport,
} from '../../ports/inbound/reporting.port.js';
import {
  availabilityBreakdowns,
  availabilityRecordFor,
  indexPointFor,
  isAvailabilityDimension,
  sortAvailabilityRecords,
  type AvailabilityDimension,
} from './availability.js';
import {
  InMemoryAuditArtifactStore,
  renderArtifactBody,
  sha256,
  sortAuditRecords,
  type AuditArtifactStore,
  type AuditSigner,
} from './artifacts.js';
import { pageOf } from './paging.js';
import type { ReportingFacing, ReportingReadModel } from './read-model.js';

/**
 * The read side of the service: one adapter behind both inbound read ports.
 *
 * It sits on the inbound edge of the hexagon by implementing `ReportingPort` and
 * `AuditExportPort`, and on the outbound edge by reading a `ReportingReadModel`.
 * Everything between those two edges is delegation — to `computeAvailabilityIndex`
 * for the index, to the outcome-metrics module for the loop's own figures, to the
 * domain's own history for the audit log. That is the property worth protecting:
 * **the report and the artifact that substantiates it are computed by the same
 * code from the same retained events**, so an auditor recomputing from an export
 * gets the number the retailer was shown rather than a second opinion.
 */

/** Raised when a caller asks a question the retained read model cannot answer. */
export class ReportingQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportingQueryError';
  }
}

export interface ReportingAdapterDependencies {
  readonly readModel: ReportingReadModel;
  /** Defaults to an in-process store; a deployment supplies object storage. */
  readonly artifacts?: AuditArtifactStore;
  /** `null` when the retailer's plan does not include signed artifacts. */
  readonly signer?: AuditSigner | null;
  /** Clock for `computedAt` and `generatedAt`. */
  readonly now: () => Instant;
  /** How long a sealed artifact stays fetchable through its handle. */
  readonly mintArtifactId?: (scope: AuditExportScope, contentHash: string) => AuditArtifactId;
}

/**
 * Dimensions the outcome metrics can be cut by, narrowed from the port's set.
 *
 * `aisle` is missing on purpose: a loop outcome record knows the facing but not
 * where in the store it sits, and inventing an aisle breakdown by joining back to
 * a facing that may since have been re-merchandised would produce a number nobody
 * could reproduce.
 */
const OUTCOME_DIMENSIONS: readonly ReportDimension[] = [
  'store',
  'product',
  'department',
  'category',
  'task_type',
];

const isOutcomeDimension = (dimension: ReportDimension): dimension is OutcomeDimension =>
  OUTCOME_DIMENSIONS.includes(dimension);

const bucketKey = (window: TimeWindow): string => `${window.from}|${window.to}`;

/** Reports that carry no per-labour-hour figure share one empty table. */
const NO_LABOUR: ReadonlyMap<string, number | null> = new Map();

export class ReportingAdapter implements ReportingPort, AuditExportPort {
  private readonly readModel: ReportingReadModel;
  private readonly artifacts: AuditArtifactStore;
  private readonly signer: AuditSigner | null;
  private readonly now: () => Instant;
  private readonly mintArtifactId: (scope: AuditExportScope, contentHash: string) => AuditArtifactId;

  constructor(dependencies: ReportingAdapterDependencies) {
    this.readModel = dependencies.readModel;
    this.artifacts = dependencies.artifacts ?? new InMemoryAuditArtifactStore();
    this.signer = dependencies.signer ?? null;
    this.now = dependencies.now;
    // Addressed by content by default, so re-sealing an unchanged closed period
    // returns the same artifact rather than a second one an auditor has to
    // reconcile against the first.
    this.mintArtifactId =
      dependencies.mintArtifactId ??
      ((scope, contentHash) => `${scope.retailerId}:${contentHash.slice(0, 32)}` as AuditArtifactId);
  }

  // -------------------------------------------------------------------------
  // Availability
  // -------------------------------------------------------------------------

  private async facingsFor(scope: ReportScope): Promise<readonly ReportingFacing[]> {
    const facings = await this.readModel.facings({
      retailerId: scope.retailerId,
      storeIds: scope.storeIds,
      productIds: scope.productIds,
      window: scope.window,
    });
    // The read model is a store, and a store is a place a cross-tenant row can
    // arrive from. The partition rule is re-checked here rather than assumed,
    // because this is the layer where an untyped query result becomes a report.
    for (const entry of facings) {
      if (entry.retailerId !== scope.retailerId || entry.facing.retailerId !== scope.retailerId) {
        throw new ReportingQueryError(
          `Read model returned facing "${entry.facing.facingId}" from partition "${entry.facing.retailerId}" for a query scoped to "${scope.retailerId}"`,
        );
      }
    }
    return facings;
  }

  private availabilityDimensions(scope: ReportScope): readonly AvailabilityDimension[] {
    return scope.breakdownBy.map((dimension) => {
      if (isAvailabilityDimension(dimension)) return dimension;
      throw new ReportingQueryError(
        `Availability cannot be broken down by "${dimension}": it is a property of the work raised at a facing, not of the facing's time in stock`,
      );
    });
  }

  async availabilityIndex(scope: ReportScope): Promise<AvailabilityIndexReport> {
    const facings = await this.facingsFor(scope);
    const dimensions = this.availabilityDimensions(scope);

    return {
      retailerId: scope.retailerId,
      window: scope.window,
      granularity: scope.granularity,
      overall: indexPointFor(scope.retailerId, facings, scope.window),
      series: bucketsFor(scope.window, scope.granularity).map((bucket) =>
        indexPointFor(scope.retailerId, facings, bucket),
      ),
      breakdowns: availabilityBreakdowns(scope.retailerId, facings, dimensions, scope.window),
      computedAt: this.now(),
    };
  }

  async availabilityRecords(query: AvailabilityRecordQuery): Promise<Page<AvailabilityRecord>> {
    const { scope } = query;
    const facings = await this.facingsFor(scope);

    const records = facings
      .map((entry) => availabilityRecordFor(entry, scope.window))
      .filter(
        (record) => query.minGapCount === null || record.gapCount >= query.minGapCount,
      );

    return pageOf(sortAvailabilityRecords(records, query.sort), query.page);
  }

  // -------------------------------------------------------------------------
  // Loop performance
  // -------------------------------------------------------------------------

  private async metricsInput(
    scope: ReportScope,
    labourByBucket: ReadonlyMap<string, number | null>,
  ): Promise<OutcomeMetricsInput> {
    const records = await this.readModel.outcomeRecords(scope.retailerId, scope.window);
    const inScope = records.filter(
      (record) =>
        (scope.storeIds === null || scope.storeIds.includes(record.storeId)) &&
        (scope.productIds === null || scope.productIds.includes(record.productId)),
    );

    return {
      retailerId: scope.retailerId,
      window: scope.window,
      granularity: scope.granularity,
      records: inScope,
      computedAt: this.now(),
      breakdownBy: scope.breakdownBy.map((dimension) => {
        if (isOutcomeDimension(dimension)) return dimension;
        throw new ReportingQueryError(
          `Loop metrics cannot be broken down by "${dimension}": an outcome record carries the facing, not its position in the store`,
        );
      }),
      labourHoursFor: (bucket: TimeWindow) => labourByBucket.get(bucketKey(bucket)) ?? null,
    };
  }

  /**
   * Labour hours per bucket, resolved before the fold runs.
   *
   * `computeTaskWorkRate` folds synchronously — it is arithmetic over records the
   * loop already wrote — so the asynchronous lookup happens up front and is
   * handed in as a table. The table is a local, passed down rather than cached on
   * the adapter: two reports for two retailers can be in flight at once, and an
   * instance field would let one of them read the other's payroll.
   */
  private async labourTable(scope: ReportScope): Promise<ReadonlyMap<string, number | null>> {
    const table = new Map<string, number | null>();
    for (const bucket of [scope.window, ...bucketsFor(scope.window, scope.granularity)]) {
      table.set(
        bucketKey(bucket),
        await this.readModel.labourHours(scope.retailerId, scope.storeIds, bucket),
      );
    }
    return table;
  }

  async taskWorkRate(scope: ReportScope): Promise<TaskWorkRateReport> {
    return computeTaskWorkRate(await this.metricsInput(scope, await this.labourTable(scope)));
  }

  async resolvedGapRate(scope: ReportScope): Promise<ResolvedGapRateReport> {
    return computeResolvedGapRate(await this.metricsInput(scope, NO_LABOUR));
  }

  async detectionToResolution(scope: ReportScope): Promise<DetectionToResolutionReport> {
    return computeDetectionToResolution(await this.metricsInput(scope, NO_LABOUR));
  }

  /**
   * Task types worth offering as a breakdown filter.
   *
   * Every type the platform defines, not only the ones this retailer has happened
   * to raise. A filter list that shrinks when a week was quiet would have a store
   * manager conclude spoilage removal is not configured, when the truth is that
   * nothing spoiled.
   */
  async reportableTaskTypes(_retailerId: RetailerId): Promise<readonly TaskType[]> {
    return TASK_TYPES;
  }

  // -------------------------------------------------------------------------
  // Audit export
  // -------------------------------------------------------------------------

  /**
   * Clamps a requested period to what is still retained.
   *
   * Truncated rather than refused, and the truncation is visible in the
   * artifact's own `scope`: an auditor asking for thirteen months against a
   * twelve-month retention gets twelve months clearly labelled as twelve, not an
   * error and not thirteen months with one silently empty.
   */
  private async retainedPeriod(scope: AuditExportScope): Promise<TimeWindow> {
    const retention = await this.readModel.retention(scope.retailerId);
    const from =
      scope.period.from < retention.retainedFrom ? retention.retainedFrom : scope.period.from;
    return timeWindow(from > scope.period.to ? scope.period.to : from, scope.period.to);
  }

  private async auditRecordsFor(
    scope: AuditExportScope,
  ): Promise<readonly FacingStateAuditRecord[]> {
    const period = await this.retainedPeriod(scope);
    const facings = await this.readModel.facings({
      retailerId: scope.retailerId,
      storeIds: scope.storeIds,
      productIds: scope.productIds,
      window: period,
    });

    const signalIds = facings.flatMap((entry) =>
      eventsWithin(entry.facing.history, period).map((event) => event.cause.signalId),
    );
    const provenance = await this.readModel.signalProvenance(scope.retailerId, signalIds);

    return sortAuditRecords(
      facings.map((entry) => this.auditRecordFor(entry, period, provenance)),
    );
  }

  private auditRecordFor(
    entry: ReportingFacing,
    period: TimeWindow,
    provenance: ReadonlyMap<SignalId, { instanceId: string | null; softwareVersion: string | null }>,
  ): FacingStateAuditRecord {
    const { facing } = entry;
    const availability = computeFacingAvailability(timelineFor(facing, period), period);

    const transitions: readonly AuditedTransition[] = eventsWithin(facing.history, period).map(
      (event) => {
        const producer = provenance.get(event.cause.signalId);
        return {
          eventId: event.eventId,
          sequence: event.sequence,
          at: event.at,
          from: event.from,
          to: event.to,
          source: event.cause.source,
          signalId: event.cause.signalId,
          confidence: event.cause.confidence,
          producerInstanceId: producer?.instanceId ?? null,
          producerSoftwareVersion: producer?.softwareVersion ?? null,
        };
      },
    );

    return {
      retailerId: facing.retailerId,
      storeId: facing.storeId,
      facingId: facing.facingId,
      productId: facing.productId,
      location: facing.location,
      period,
      // Carry-in state. Without it the first segment of the period is
      // unaccountable and the auditor's recomputation cannot start.
      stateAtPeriodStart: stateAt(facing.history, period.from),
      transitions,
      reportedInStockMillis: availability.inStockMillis,
      reportedOutOfStockMillis: availability.outOfStockMillis,
      reportedUnknownMillis: availability.unknownMillis,
      reportedMeasuredMillis: availability.measuredMillis,
      reportedIndex: availability.index,
    };
  }

  async exportFacingStateLog(query: FacingStateLogQuery): Promise<Page<FacingStateAuditRecord>> {
    return pageOf(await this.auditRecordsFor(query.scope), query.page);
  }

  async exportAuditTrail(query: AuditTrailQuery): Promise<Page<AuditLogEntry>> {
    const period = await this.retainedPeriod(query.scope);
    const entries = await this.readModel.auditEntries(query.scope.retailerId, period);
    const { storeIds } = query.scope;

    const inScope = entries.filter(
      (entry) =>
        // A retailer-level entry — a lane map override, say — belongs in every
        // store-scoped export: it is part of why that store's tasks looked the
        // way they did, and dropping it would leave the trail unexplained.
        storeIds === null || entry.storeId === null || storeIds.includes(entry.storeId),
    );

    return pageOf(inScope, query.page);
  }

  private async completenessOf(
    scope: AuditExportScope,
    period: TimeWindow,
    records: readonly FacingStateAuditRecord[],
  ): Promise<AuditCompleteness> {
    const sources = new Set<SignalSource>();
    let transitionCount = 0;
    for (const record of records) {
      transitionCount += record.transitions.length;
      for (const transition of record.transitions) sources.add(transition.source);
    }

    const incomplete: readonly FacingId[] = await this.readModel.incompleteFacings(
      scope.retailerId,
      scope.storeIds,
      period,
    );

    return {
      facingCount: records.length,
      transitionCount,
      sourcesRepresented: [...sources].sort(),
      unobservedIntervals: await this.readModel.unobservedIntervals(
        scope.retailerId,
        scope.storeIds,
        period,
      ),
      incompleteFacings: incomplete,
    };
  }

  async sealArtifact(request: AuditExportRequest): Promise<AuditExportArtifact> {
    const period = await this.retainedPeriod(request.scope);
    const scope: AuditExportScope = { ...request.scope, period };

    const records = await this.auditRecordsFor(scope);
    const body = renderArtifactBody(records, request.format);
    const contentHash = sha256(body);

    const artifactId = this.mintArtifactId(scope, contentHash);
    const stored = await this.artifacts.put(scope.retailerId, artifactId, body, request.format);
    const retention = await this.readModel.retention(scope.retailerId);
    const generatedAt = this.now();

    // The index the artifact exists to substantiate, summed from the very records
    // in the body rather than re-queried. If the two ever disagreed, the artifact
    // would be evidence against itself.
    const inStock = records.reduce((total, record) => total + record.reportedInStockMillis, 0);
    const measured = records.reduce((total, record) => total + record.reportedMeasuredMillis, 0);
    const observable = (period.to - period.from) * records.length;

    const manifest: AuditExportArtifact = {
      artifactId,
      retailerId: scope.retailerId,
      schemaVersion: CURRENT_AUDIT_EXPORT_SCHEMA_VERSION,
      scope,
      generatedAt,
      reportedIndex: {
        index: measured === 0 ? null : inStock / measured,
        coverage: observable === 0 ? 0 : measured / observable,
        inStockFacingMillis: millis(inStock),
        measuredFacingMillis: millis(measured),
        facingCount: records.length,
      },
      completeness: await this.completenessOf(scope, period, records),
      integrity: {
        algorithm: 'sha-256',
        contentHash,
        signature: this.signer === null ? null : await this.signer.sign(contentHash),
        signedBy: this.signer?.signedBy ?? null,
      },
      retrieval: {
        format: request.format,
        byteSize: stored.byteSize,
        handle: stored.handle,
        availableUntil: plus(generatedAt, retention.artifactRetention),
      },
      retainedUntil: plus(generatedAt, retention.artifactRetention),
    };

    await this.artifacts.putManifest(manifest);
    return manifest;
  }

  async getArtifact(
    retailerId: RetailerId,
    artifactId: AuditArtifactId,
  ): Promise<AuditExportArtifact | null> {
    return this.artifacts.getManifest(retailerId, artifactId);
  }

  async describeRetentionPolicy(retailerId: RetailerId): Promise<AuditRetentionPolicy> {
    const retention = await this.readModel.retention(retailerId);
    return {
      retailerId,
      eventRetention: retention.eventRetention,
      artifactRetention: retention.artifactRetention,
      retainedFrom: retention.retainedFrom,
    };
  }

  async describeSchemaContract(): Promise<SchemaContract> {
    return AUDIT_EXPORT_SCHEMA_CONTRACT;
  }
}
