import type { EventId, RetailerId, StoreId } from '../domain/common/ids.js';
import type { Instant } from '../domain/common/time.js';
import type { Facing } from '../domain/facing/facing.js';
import type { InterpretationPolicy } from '../domain/facing/interpretation.js';
import type { Signal } from '../domain/facing/signals.js';
import type { AuditExportPort } from '../ports/inbound/audit-export.port.js';
import type { DetectionIngestionPort } from '../ports/inbound/detection-ingestion.port.js';
import type {
  AvailabilityQueryPort,
  ReportingPort,
  TaskPerformanceQueryPort,
} from '../ports/inbound/reporting.port.js';
import type { DeadLetterSinkPort } from '../ports/outbound/dead-letter.port.js';
import type { EslActuationPort } from '../ports/outbound/esl-actuation.port.js';
import type { EventStreamConsumerPort } from '../ports/outbound/event-stream.port.js';
import type { FacingRepositoryPort } from '../ports/outbound/facing-repository.port.js';
import type { IngestionLedgerPort } from '../ports/outbound/ingestion-ledger.port.js';
import { DetectionIngestionService } from '../application/detection-ingestion.service.js';
import type { NormalizationContext } from '../application/signal-normalization.js';
import { ReportingAdapter } from '../adapters/reporting/reporting.adapter.js';
import type { AuditArtifactStore, AuditSigner } from '../adapters/reporting/artifacts.js';
import type { ReportingReadModel } from '../adapters/reporting/read-model.js';
import { createEslAdapter } from '../adapters/outbound/esl/registry.js';
import type { EslFleetGateway } from '../adapters/outbound/esl/gateway.js';
import { DetectionStreamConsumer } from '../adapters/inbound/detection-stream/consumer.js';
import type { DetectionSubscription } from '../adapters/inbound/detection-stream/topics.js';
import type { RetailerTenant } from './tenancy.js';

/**
 * The composition root: where ports meet the adapters that implement them.
 *
 * ### One container per retailer
 *
 * The container is scoped to a tenant, not to the process. That is the same
 * isolation argument made one layer further out than usual: a single container
 * holding one connection pool and one consumer would be a component that can, by
 * construction, see two retailers' data, and every control below it would be
 * spent making sure it never did. A container per retailer means the pool is
 * bound to that tenant's role and schema, the consumer runs under that tenant's
 * group and reads only that tenant's topics, and there is no object anywhere in
 * the wiring that holds two tenants' state at once.
 *
 * ### Bindings are checked by the compiler
 *
 * `PortProviders` is a mapped type over `PortName`, so a port added to
 * `ServicePorts` is a type error in `standardProviders` until it is bound. The
 * alternative — a registration list checked at startup — moves "did we wire
 * everything" from compile time to whenever the first request happens to reach
 * the port nobody registered.
 *
 * ### What the container builds, and what it is given
 *
 * It builds everything that is this service's own code: the ingestion service,
 * the reporting adapter, the stream consumer, the ESL fleet adapters. It is
 * *given* the handful of things that genuinely need a driver this package does
 * not depend on — a store, a broker, a clock, a vendor gateway. That line is the
 * same one the rest of the package draws, and it is why a deployment can swap
 * Postgres for anything else without a line changing inward of here.
 */

/** A fleet adapter is per store, because the vendor installed there is. */
export type EslActuationFactory = (retailerId: RetailerId, storeId: StoreId) => EslActuationPort;

/** Every port this service exposes or consumes, and the type each one is bound to. */
export interface ServicePorts {
  readonly detectionIngestion: DetectionIngestionPort;
  readonly availabilityQuery: AvailabilityQueryPort;
  readonly taskPerformanceQuery: TaskPerformanceQueryPort;
  /**
   * The read side, typed as the intersection of the three read contracts it
   * serves rather than as `ReportingPort` alone.
   *
   * That is not a convenience. `availabilityQuery`, `taskPerformanceQuery` and
   * `auditExport` all resolve to *this* binding, and the intersection is what
   * makes them the same instance by type rather than by three bindings that
   * happen to construct the same class — which is the property that keeps a
   * figure in a report and the artifact substantiating it computed from one read
   * model by one piece of arithmetic.
   */
  readonly reporting: ReportingPort & AuditExportPort;
  readonly auditExport: AuditExportPort;
  readonly eslActuation: EslActuationFactory;
  readonly facingRepository: FacingRepositoryPort;
  readonly ingestionLedger: IngestionLedgerPort;
  readonly eventStream: EventStreamConsumerPort;
  readonly deadLetterSink: DeadLetterSinkPort;
}

export type PortName = keyof ServicePorts;

/**
 * Every port name, kept honest in both directions.
 *
 * The mapped type means a port missing from this object is a compile error, and a
 * name that is not a port is one too — so `PORT_NAMES` cannot drift from
 * `ServicePorts` the way a hand-written array would.
 */
const PORT_NAME_MARKERS: { readonly [P in PortName]: true } = {
  detectionIngestion: true,
  availabilityQuery: true,
  taskPerformanceQuery: true,
  reporting: true,
  auditExport: true,
  eslActuation: true,
  facingRepository: true,
  ingestionLedger: true,
  eventStream: true,
  deadLetterSink: true,
};

export const PORT_NAMES = Object.keys(PORT_NAME_MARKERS) as readonly PortName[];

/**
 * What a deployment supplies for one retailer.
 *
 * Everything here needs something this package refuses to depend on: a driver, a
 * socket, a source of randomness or a clock. The pieces are per tenant, and the
 * comments say which of them a deployment must bind to that tenant's namespace.
 */
export interface RetailerInfrastructure {
  /** The platform clock. Injected everywhere in this codebase; here is where it enters. */
  readonly clock: () => Instant;
  /** Bound to this retailer's schema and role — see `renderTenantBootstrapDDL`. */
  readonly facings: FacingRepositoryPort;
  readonly ledger: IngestionLedgerPort;
  /** Subscribed under this retailer's consumer group, to this retailer's topics only. */
  readonly stream: EventStreamConsumerPort;
  readonly deadLetters: DeadLetterSinkPort;
  /** Reads this retailer's relational and time-series schemas. */
  readonly readModel: ReportingReadModel;
  /** The fleet transport for a store; the vendor it declares picks the profile. */
  readonly eslGateway: (retailerId: RetailerId, storeId: StoreId) => EslFleetGateway;
  readonly nextSignalId: NormalizationContext['nextSignalId'];
  readonly nextEventId: (facing: Facing, signal: Signal) => EventId;
  /** Object storage for sealed artifacts; an in-process store when absent. */
  readonly artifacts?: AuditArtifactStore;
  /** `null` when this retailer's plan does not include signed artifacts. */
  readonly signer?: AuditSigner | null;
  /** Retailer-tuned detection thresholds; the standard policy when absent. */
  readonly interpretationPolicy?: InterpretationPolicy;
}

/** What a provider is handed: the tenant it is building for, and the container it can pull from. */
export interface BindingContext {
  readonly tenant: RetailerTenant;
  readonly infrastructure: RetailerInfrastructure;
  /** Resolves another port. Memoized, so two ports sharing a dependency share the instance. */
  readonly resolve: <P extends PortName>(name: P) => ServicePorts[P];
}

export type PortProviders = {
  readonly [P in PortName]: (context: BindingContext) => ServicePorts[P];
};

export class ContainerError extends Error {
  readonly code = 'CONTAINER' as const;

  constructor(message: string) {
    super(message);
    this.name = 'ContainerError';
  }
}

/**
 * A resolved, memoized set of bindings for one retailer.
 *
 * Lazy, so a deployment that only serves reports never constructs a stream
 * consumer, and memoized, so the ingestion service and the reporting adapter see
 * the same repository instance rather than two views of one store.
 */
export class Container {
  private readonly instances = new Map<PortName, unknown>();
  private readonly resolving = new Set<PortName>();

  constructor(
    readonly tenant: RetailerTenant,
    readonly infrastructure: RetailerInfrastructure,
    private readonly providers: PortProviders,
  ) {}

  /** The clock every binding in this container was built with. */
  get clock(): () => Instant {
    return this.infrastructure.clock;
  }

  resolve = <P extends PortName>(name: P): ServicePorts[P] => {
    const existing = this.instances.get(name);
    if (existing !== undefined) return existing as ServicePorts[P];

    // A cycle is a wiring bug that would otherwise present as a stack overflow
    // during startup, with nothing in the trace naming the two ports involved.
    if (this.resolving.has(name)) {
      throw new ContainerError(
        `Port "${name}" is part of a dependency cycle: ${[...this.resolving, name].join(' -> ')}`,
      );
    }

    this.resolving.add(name);
    try {
      const instance = this.providers[name]({
        tenant: this.tenant,
        infrastructure: this.infrastructure,
        resolve: this.resolve,
      });
      this.instances.set(name, instance);
      return instance;
    } finally {
      this.resolving.delete(name);
    }
  };

  /**
   * Resolves every port.
   *
   * Used at startup so that a binding which throws does so while a deployment is
   * still starting, rather than on the first request that happens to need it.
   */
  ports(): ServicePorts {
    const resolved = {} as { -readonly [P in PortName]: ServicePorts[P] };
    for (const name of PORT_NAMES) {
      resolved[name] = this.resolve(name) as never;
    }
    return resolved;
  }
}

/**
 * The shipped bindings.
 *
 * Read top to bottom, this is the hexagon: four driven ports handed in from
 * infrastructure, and every port this service implements built from them by this
 * service's own code.
 */
export const standardProviders: PortProviders = {
  // --- Driven ports: the four things that need a driver. ---------------------
  facingRepository: ({ infrastructure }) => infrastructure.facings,
  ingestionLedger: ({ infrastructure }) => infrastructure.ledger,
  eventStream: ({ infrastructure }) => infrastructure.stream,
  deadLetterSink: ({ infrastructure }) => infrastructure.deadLetters,

  // --- Driving ports: built here from the two above. -------------------------
  detectionIngestion: ({ infrastructure, resolve }) =>
    new DetectionIngestionService({
      facings: resolve('facingRepository'),
      ledger: resolve('ingestionLedger'),
      now: infrastructure.clock,
      nextSignalId: infrastructure.nextSignalId,
      nextEventId: infrastructure.nextEventId,
      ...(infrastructure.interpretationPolicy === undefined
        ? {}
        : { policy: infrastructure.interpretationPolicy }),
    }),

  // One adapter behind both read ports and the audit export, so the figure in a
  // report and the artifact substantiating it are the same arithmetic over the
  // same events. Binding them to three separate instances would make that a
  // coincidence rather than a guarantee.
  reporting: ({ infrastructure }) =>
    new ReportingAdapter({
      readModel: infrastructure.readModel,
      now: infrastructure.clock,
      ...(infrastructure.artifacts === undefined ? {} : { artifacts: infrastructure.artifacts }),
      ...(infrastructure.signer === undefined ? {} : { signer: infrastructure.signer }),
    }),
  availabilityQuery: ({ resolve }) => resolve('reporting'),
  taskPerformanceQuery: ({ resolve }) => resolve('reporting'),
  auditExport: ({ resolve }) => resolve('reporting'),

  // Per store, because the fleet installed in one of a retailer's stores is not
  // the fleet installed in the next. The gateway declares its own vendor, and
  // `createEslAdapter` is where a mismatched pairing is caught.
  //
  // Memoized per store, and that is not an optimisation: a fleet adapter holds
  // the live expression leases, the expression-id index and the per-tag command
  // interval for its store. A fresh one per call would lose every lease — so a
  // refresh or a clear would not find the expression it was issued for — and
  // would reset the throttle that keeps a fleet from being hammered.
  eslActuation: ({ tenant, infrastructure }) => {
    const byStore = new Map<StoreId, EslActuationPort>();

    return (retailerId, storeId) => {
      // The container is scoped to one tenant, so this can only fire on a caller
      // that reached across containers — which is the one thing the per-retailer
      // scoping exists to prevent, and worth a loud failure rather than a fleet
      // adapter quietly built for the wrong retailer's store.
      if (retailerId !== tenant.retailerId) {
        throw new ContainerError(
          `Retailer "${tenant.retailerId}"'s container was asked for retailer "${retailerId}"'s fleet in store "${storeId}"`,
        );
      }

      const existing = byStore.get(storeId);
      if (existing !== undefined) return existing;

      const adapter = createEslAdapter(infrastructure.eslGateway(retailerId, storeId));
      byStore.set(storeId, adapter);
      return adapter;
    };
  },
};

/**
 * Builds the container for one retailer.
 *
 * `providers` is overridable so a test can substitute one binding without
 * restating the other nine — the mapped type still requires every port to be
 * present in the result, so an override cannot quietly drop one.
 */
export const createContainer = (
  tenant: RetailerTenant,
  infrastructure: RetailerInfrastructure,
  providers: PortProviders = standardProviders,
): Container => new Container(tenant, infrastructure, providers);

/**
 * The detection-stream consumer for one retailer, wired to that retailer's
 * subscriptions and nothing else.
 *
 * Separate from the container because it is not a port: it is the runner that
 * drives one. Built here so the only subscriptions it can ever hold are the ones
 * the bus topology generated for this tenant.
 */
export const createDetectionConsumer = (
  container: Container,
  subscriptions: readonly DetectionSubscription[],
): DetectionStreamConsumer => {
  for (const subscription of subscriptions) {
    if (subscription.retailerId !== container.tenant.retailerId) {
      throw new ContainerError(
        `Retailer "${container.tenant.retailerId}"'s consumer was given a subscription for "${subscription.retailerId}" on topic "${subscription.topic}"`,
      );
    }
  }

  return new DetectionStreamConsumer({
    stream: container.resolve('eventStream'),
    ingestion: container.resolve('detectionIngestion'),
    deadLetters: container.resolve('deadLetterSink'),
    now: container.clock,
    subscriptions,
  });
};
