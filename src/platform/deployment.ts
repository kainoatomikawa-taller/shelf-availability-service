import {
  DAY,
  millis,
  toISO,
  windowDuration,
  type Millis,
  type TimeWindow,
} from '../domain/common/time.js';
import type { RetailerId } from '../domain/common/ids.js';
import type { DetectionSource } from '../ports/inbound/detection-ingestion.port.js';
import {
  assertBusRetentionFits,
  assertNoCrossRetailerTopics,
  planBus,
  projectedPeakRecordsPerSecond,
  SOURCE_LOAD,
  subscriptionsOf,
  type BusOptions,
  type RetailerBusTopology,
} from './event-bus.js';
import {
  assertNoCrossRetailerPooling,
  planDataStores,
  renderDataStoreDDL,
  type RetailerDataStore,
} from './data-store.js';
import { horizonOf } from './retention.js';
import {
  namespacesOf,
  TenantRegistry,
  type DataResidency,
  type RetailerTenant,
} from './tenancy.js';
import type { DetectionSubscription } from '../adapters/inbound/detection-stream/topics.js';

/**
 * The deployment plan for a pilot.
 *
 * One function turns a list of retailers into everything a pipeline needs —
 * schemas, roles, DDL, keys, topics, ACLs, consumer groups and sizing — and
 * refuses the list if any of it would be unsafe. Everything is validated at plan
 * time rather than at apply time, because a plan that fails halfway through is a
 * pilot with one retailer provisioned and another half-provisioned, which is a
 * worse state than not having started.
 *
 * The bounds below are the engagement's, not arbitrary ones: two to four
 * retailers, nine to fifteen months. They are enforced rather than documented
 * because both are the sort of number that gets exceeded by one during a
 * hopeful quarter, and the consequences — an unsized cluster, a pilot that
 * outruns its retention horizons — land on whoever is on call rather than on
 * whoever agreed to it.
 */

/** A month as a planning unit; calendar months are not a fixed span and sizing needs one. */
export const MONTH: Millis = millis(30 * DAY);

export const PILOT_MIN_RETAILERS = 2;
export const PILOT_MAX_RETAILERS = 4;
export const PILOT_MIN_DURATION: Millis = millis(9 * MONTH);
export const PILOT_MAX_DURATION: Millis = millis(15 * MONTH);

export class DeploymentConfigError extends Error {
  readonly code = 'DEPLOYMENT_CONFIG' as const;

  constructor(message: string) {
    super(message);
    this.name = 'DeploymentConfigError';
  }
}

/**
 * Fraction of detection events that actually move a shelf state.
 *
 * Most signals confirm what is already believed; only a minority are a
 * transition. Sizing the history store on the detection rate would over-provision
 * it roughly twentyfold, which sounds harmless until it is the number a retailer
 * is quoted.
 */
export const TRANSITION_RATE = 0.05;

/** Bytes for one persisted state transition, index entries included. */
const HISTORY_ROW_BYTES = 300;

export interface TenantSizing {
  readonly retailerId: RetailerId;
  readonly stores: number;
  readonly facings: number;
  readonly peakRecordsPerSecond: number;
  /** Time-series bytes for detection events at their retention horizon. */
  readonly detectionStoreBytes: number;
  /** Time-series bytes for the state log, which outlives the events it came from. */
  readonly historyStoreBytes: number;
  /** Broker bytes held at the topic's own, much shorter, retention. */
  readonly brokerBytes: number;
  /** Ingest processes for this retailer. Two for availability, not for throughput. */
  readonly ingestReplicas: number;
  /** This retailer's own pool. Never shared — a shared pool is a shared role. */
  readonly connectionPoolSize: number;
}

const bytesPerDay = (facings: number, source: DetectionSource): number =>
  facings * SOURCE_LOAD[source].eventsPerFacingPerDay * SOURCE_LOAD[source].bytesPerEvent;

export const sizeTenant = (
  tenant: RetailerTenant,
  topology: RetailerBusTopology,
): TenantSizing => {
  const { facings } = tenant.scale;
  const detectionDays = horizonOf(tenant.retention, 'detection_event') / DAY;
  const historyDays = horizonOf(tenant.retention, 'facing_history') / DAY;

  let detectionStoreBytes = 0;
  let historyStoreBytes = 0;
  let peakRecordsPerSecond = 0;

  for (const source of tenant.sources) {
    const daily = bytesPerDay(facings, source);
    detectionStoreBytes += daily * detectionDays;
    historyStoreBytes +=
      facings *
      SOURCE_LOAD[source].eventsPerFacingPerDay *
      TRANSITION_RATE *
      HISTORY_ROW_BYTES *
      historyDays;
    peakRecordsPerSecond += projectedPeakRecordsPerSecond(facings, source);
  }

  let brokerBytes = 0;
  for (const topic of topology.topics) {
    if (topic.purpose !== 'detection') continue;
    brokerBytes += bytesPerDay(facings, topic.source) * (topic.retention / DAY) * topic.replicationFactor;
  }

  return {
    retailerId: tenant.retailerId,
    stores: tenant.scale.stores,
    facings,
    peakRecordsPerSecond,
    detectionStoreBytes: Math.round(detectionStoreBytes),
    historyStoreBytes: Math.round(historyStoreBytes),
    brokerBytes: Math.round(brokerBytes),
    // The detection topics have one partition each, so a second replica adds no
    // throughput — it is there so a rolling restart is not an ingestion gap.
    ingestReplicas: 2,
    connectionPoolSize: Math.min(20, Math.max(4, Math.ceil(peakRecordsPerSecond / 200))),
  };
};

/** Stores and brokers are per region; residency is the retailer's, not the pilot's. */
export interface RegionPlan {
  readonly residency: DataResidency;
  readonly retailerIds: readonly RetailerId[];
}

export type DeploymentEnvironment = 'pilot' | 'staging' | 'production';

export interface PilotDeploymentInput {
  readonly environment: DeploymentEnvironment;
  readonly tenants: readonly RetailerTenant[];
  /** The contracted pilot window; every retailer is onboarded inside it. */
  readonly window: TimeWindow;
  readonly bus?: BusOptions;
}

export interface PilotDeployment {
  readonly environment: DeploymentEnvironment;
  readonly window: TimeWindow;
  readonly registry: TenantRegistry;
  readonly dataStores: readonly RetailerDataStore[];
  readonly bus: readonly RetailerBusTopology[];
  /** Every subscription in the deployment; each consumer is given only its own. */
  readonly subscriptions: readonly DetectionSubscription[];
  readonly sizing: readonly TenantSizing[];
  readonly regions: readonly RegionPlan[];
}

const assertPilotSize = (tenants: readonly RetailerTenant[]): void => {
  if (tenants.length < PILOT_MIN_RETAILERS) {
    throw new DeploymentConfigError(
      `A pilot runs ${PILOT_MIN_RETAILERS}–${PILOT_MAX_RETAILERS} retailers; ${tenants.length} was configured. One retailer cannot tell an isolation failure from a working system, because there is nothing to leak into`,
    );
  }
  if (tenants.length > PILOT_MAX_RETAILERS) {
    throw new DeploymentConfigError(
      `A pilot runs ${PILOT_MIN_RETAILERS}–${PILOT_MAX_RETAILERS} retailers; ${tenants.length} was configured. Past four, the per-retailer isolation this design buys costs more in clusters and keys than a pilot can staff`,
    );
  }
};

const assertPilotWindow = (window: TimeWindow, tenants: readonly RetailerTenant[]): void => {
  const duration = windowDuration(window);
  if (duration < PILOT_MIN_DURATION || duration > PILOT_MAX_DURATION) {
    throw new DeploymentConfigError(
      `A pilot window is 9–15 months; ${Math.round(duration / MONTH)} months was configured (${toISO(window.from)} .. ${toISO(window.to)})`,
    );
  }

  for (const tenant of tenants) {
    if (tenant.onboardedAt < window.from || tenant.onboardedAt >= window.to) {
      throw new DeploymentConfigError(
        `Retailer "${tenant.retailerId}" is onboarded at ${toISO(tenant.onboardedAt)}, outside the pilot window ${toISO(window.from)} .. ${toISO(window.to)}`,
      );
    }
  }
};

/**
 * Checks that the retention horizons outlive the pilot they are for.
 *
 * The one that bites: a pilot runs fifteen months, a retailer asks in month
 * fourteen for the availability index over month one, and the answer is that the
 * history expired. The failure is invisible until it is asked for, so it is
 * checked here, against the window that was actually contracted.
 */
const assertRetentionOutlivesPilot = (
  tenants: readonly RetailerTenant[],
  window: TimeWindow,
): void => {
  const duration = windowDuration(window);
  for (const tenant of tenants) {
    for (const dataClass of ['facing_history', 'audit_trail', 'audit_artifact'] as const) {
      const horizon = horizonOf(tenant.retention, dataClass);
      if (horizon < duration) {
        throw new DeploymentConfigError(
          `Retailer "${tenant.retailerId}" keeps "${dataClass}" for ${Math.round(horizon / MONTH)} months against a ${Math.round(duration / MONTH)}-month pilot; the earliest months would age out before the pilot is reviewed`,
        );
      }
    }
  }
};

const byRetailer = <T extends { readonly retailerId: RetailerId }>(
  items: readonly T[],
): ReadonlyMap<RetailerId, T> => new Map(items.map((item) => [item.retailerId, item]));

const requireFor = <T>(
  index: ReadonlyMap<RetailerId, T>,
  retailerId: RetailerId,
  what: string,
): T => {
  const value = index.get(retailerId);
  if (value === undefined) {
    throw new DeploymentConfigError(`No ${what} was planned for retailer "${retailerId}"`);
  }
  return value;
};

const regionsOf = (tenants: readonly RetailerTenant[]): readonly RegionPlan[] => {
  const grouped = new Map<DataResidency, RetailerId[]>();
  for (const tenant of tenants) {
    const existing = grouped.get(tenant.residency);
    if (existing === undefined) grouped.set(tenant.residency, [tenant.retailerId]);
    else existing.push(tenant.retailerId);
  }
  return [...grouped].map(([residency, retailerIds]) => ({ residency, retailerIds }));
};

/**
 * Plans a pilot, or explains why it cannot be one.
 *
 * Order matters: the cheap structural checks run before anything is built, so the
 * error a misconfiguration produces is the one that names the actual mistake
 * rather than a downstream symptom of it.
 */
export function planPilotDeployment(input: PilotDeploymentInput): PilotDeployment {
  assertPilotSize(input.tenants);
  assertPilotWindow(input.window, input.tenants);
  assertRetentionOutlivesPilot(input.tenants, input.window);

  // Constructing the registry is itself the duplicate-id, duplicate-slug and
  // shared-key check.
  const registry = new TenantRegistry(input.tenants);

  const dataStores = planDataStores(registry.tenants);
  assertNoCrossRetailerPooling(dataStores);

  const bus = planBus(registry.tenants, input.bus ?? {});
  assertNoCrossRetailerTopics(bus);
  assertBusRetentionFits(bus, (retailerId) => registry.require(retailerId).retention);

  // Looked up by retailer rather than by position: three parallel arrays that
  // happen to agree today is exactly the coupling that pairs one retailer's
  // sizing with another's topology the first time one of them is filtered.
  const busByRetailer = byRetailer(bus);
  const sizing = registry.tenants.map((tenant) =>
    sizeTenant(tenant, requireFor(busByRetailer, tenant.retailerId, 'bus topology')),
  );

  return {
    environment: input.environment,
    window: input.window,
    registry,
    dataStores,
    bus,
    subscriptions: subscriptionsOf(bus),
    sizing,
    regions: regionsOf(registry.tenants),
  };
}

/** The subscriptions belonging to one retailer, which is all its consumer may hold. */
export const subscriptionsForRetailer = (
  deployment: PilotDeployment,
  retailerId: RetailerId,
): readonly DetectionSubscription[] =>
  deployment.subscriptions.filter((subscription) => subscription.retailerId === retailerId);

/**
 * The plan as something a pipeline can apply.
 *
 * Plain JSON-serializable data, with the DDL rendered per retailer. Deliberately
 * not a Terraform or Helm document: this package knows what must be true, and the
 * deployment repository knows what dialect says so. Keeping the two apart is what
 * lets the rules be unit-tested at all.
 */
export interface DeploymentManifest {
  readonly environment: DeploymentEnvironment;
  readonly window: { readonly from: string; readonly to: string };
  readonly regions: readonly RegionPlan[];
  readonly retailers: readonly {
    readonly retailerId: string;
    readonly slug: string;
    readonly residency: DataResidency;
    readonly schemas: readonly string[];
    readonly role: string;
    readonly keys: readonly string[];
    readonly consumerGroup: string;
    readonly topics: readonly {
      readonly name: string;
      readonly partitions: number;
      readonly replicationFactor: number;
      readonly minInSyncReplicas: number;
      readonly retentionMillis: number;
      readonly encryptionKeyRef: string;
      readonly acls: readonly { principal: string; operation: string; resource: string }[];
    }[];
    readonly retentionJobs: readonly {
      readonly schema: string;
      readonly table: string;
      readonly horizonMillis: number;
      readonly strategy: string;
    }[];
    readonly sizing: TenantSizing;
    readonly ddl: string;
  }[];
}

export function deploymentManifest(deployment: PilotDeployment): DeploymentManifest {
  const stores = byRetailer(deployment.dataStores);
  const topologies = byRetailer(deployment.bus);
  const sizings = byRetailer(deployment.sizing);

  return {
    environment: deployment.environment,
    window: { from: toISO(deployment.window.from), to: toISO(deployment.window.to) },
    regions: deployment.regions,
    retailers: deployment.registry.tenants.map((tenant) => {
      const store = requireFor(stores, tenant.retailerId, 'data store');
      const topology = requireFor(topologies, tenant.retailerId, 'bus topology');
      const sizing = requireFor(sizings, tenant.retailerId, 'sizing');
      const namespaces = namespacesOf(tenant);

      return {
        retailerId: tenant.retailerId,
        slug: tenant.slug,
        residency: tenant.residency,
        schemas: [namespaces.relationalSchema, namespaces.timeseriesSchema],
        role: namespaces.role,
        keys: [tenant.encryption.dataKeyRef, tenant.encryption.backupKeyRef],
        consumerGroup: namespaces.consumerGroup,
        topics: topology.topics.map((topic) => ({
          name: topic.name,
          partitions: topic.partitions,
          replicationFactor: topic.replicationFactor,
          minInSyncReplicas: topic.minInSyncReplicas,
          retentionMillis: topic.retention,
          encryptionKeyRef: topic.encryptionKeyRef,
          acls: topic.acls.map((acl) => ({
            principal: acl.principal,
            operation: acl.operation,
            resource: acl.resource,
          })),
        })),
        retentionJobs: store.retentionJobs.map((job) => ({
          schema: job.schema,
          table: job.table,
          horizonMillis: job.horizon,
          strategy: job.strategy,
        })),
        sizing,
        ddl: renderDataStoreDDL(store),
      };
    }),
  };
}

/** The plan in the handful of numbers a review actually argues about. */
export const describeDeployment = (deployment: PilotDeployment): string => {
  const lines = [
    `${deployment.environment}: ${deployment.registry.size} retailers, ${Math.round(windowDuration(deployment.window) / MONTH)} months`,
  ];
  for (const sizing of deployment.sizing) {
    lines.push(
      `  ${sizing.retailerId}: ${sizing.stores} stores, ${sizing.facings} facings, ` +
        `${sizing.peakRecordsPerSecond.toFixed(1)} rec/s peak, ` +
        `${(sizing.detectionStoreBytes / 1e9).toFixed(1)}GB detections + ` +
        `${(sizing.historyStoreBytes / 1e9).toFixed(1)}GB history + ` +
        `${(sizing.brokerBytes / 1e9).toFixed(1)}GB broker`,
    );
  }
  return lines.join('\n');
};
