import type { RetailerId } from '../domain/common/ids.js';
import type { DetectionStreamConsumer } from '../adapters/inbound/detection-stream/consumer.js';
import {
  createContainer,
  createDetectionConsumer,
  standardProviders,
  type Container,
  type PortProviders,
  type RetailerInfrastructure,
} from './container.js';
import type { RetailerDataStore } from './data-store.js';
import { subscriptionsForRetailer, type PilotDeployment } from './deployment.js';
import type { RetailerBusTopology } from './event-bus.js';
import type { RetailerTenant } from './tenancy.js';

/**
 * Turning a plan into running objects.
 *
 * The last step of the composition root, and the narrowest: given a validated
 * deployment and a way to open infrastructure for one tenant, build one runtime
 * per retailer. Each runtime is a closed set — its own container, its own
 * consumer, its own topics, its own schemas — and holding them in a map keyed by
 * retailer is the only place in the process where more than one tenant's things
 * are reachable from a single value. That is deliberate and it is one function:
 * `RetailerRuntimes.require` is the one lookup, and everything downstream of it
 * has exactly one tenant in scope.
 */

/** Everything one retailer runs on. */
export interface RetailerRuntime {
  readonly tenant: RetailerTenant;
  readonly container: Container;
  readonly consumer: DetectionStreamConsumer;
  readonly bus: RetailerBusTopology;
  readonly dataStore: RetailerDataStore;
}

/**
 * Opens infrastructure for one tenant.
 *
 * Called once per retailer, and expected to bind the pool to that retailer's role
 * and schemas and the broker client to that retailer's consumer group — the
 * namespaces are on `tenant` via `namespacesOf`, so nothing has to be guessed.
 */
export type InfrastructureFactory = (tenant: RetailerTenant) => RetailerInfrastructure;

export class RetailerRuntimes {
  private readonly byRetailer: ReadonlyMap<RetailerId, RetailerRuntime>;
  readonly all: readonly RetailerRuntime[];

  constructor(runtimes: readonly RetailerRuntime[]) {
    this.all = [...runtimes];
    this.byRetailer = new Map(runtimes.map((runtime) => [runtime.tenant.retailerId, runtime]));
  }

  find(retailerId: RetailerId): RetailerRuntime | null {
    return this.byRetailer.get(retailerId) ?? null;
  }

  /** The runtime, or a named failure — never a silent fall-through to another tenant's. */
  require(retailerId: RetailerId): RetailerRuntime {
    const runtime = this.byRetailer.get(retailerId);
    if (runtime === undefined) {
      throw new Error(`Retailer "${retailerId}" is not running in this deployment`);
    }
    return runtime;
  }
}

/**
 * Wires every retailer in a deployment.
 *
 * The plan is validated before this is called, so nothing here re-checks
 * isolation; what it does guarantee is that a retailer's consumer is constructed
 * with that retailer's subscriptions and no others, which `createDetectionConsumer`
 * asserts again on the way in.
 */
export function startDeployment(
  deployment: PilotDeployment,
  infrastructureFor: InfrastructureFactory,
  providers: PortProviders = standardProviders,
): RetailerRuntimes {
  const busByRetailer = new Map(deployment.bus.map((topology) => [topology.retailerId, topology]));
  const storesByRetailer = new Map(
    deployment.dataStores.map((store) => [store.retailerId, store]),
  );

  const runtimes = deployment.registry.tenants.map((tenant): RetailerRuntime => {
    const bus = busByRetailer.get(tenant.retailerId);
    const dataStore = storesByRetailer.get(tenant.retailerId);
    if (bus === undefined || dataStore === undefined) {
      throw new Error(`Incomplete plan for retailer "${tenant.retailerId}"`);
    }

    const container = createContainer(tenant, infrastructureFor(tenant), providers);
    const consumer = createDetectionConsumer(
      container,
      subscriptionsForRetailer(deployment, tenant.retailerId),
    );

    return { tenant, container, consumer, bus, dataStore };
  });

  return new RetailerRuntimes(runtimes);
}
