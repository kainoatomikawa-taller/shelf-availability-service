import {
  DETECTION_SOURCE_ADAPTERS,
  InMemoryAuditArtifactStore,
  createFacing,
  eventId,
  millis,
  planPilotDeployment,
  startDeployment,
  streamSignalId,
  DAY,
  type AuditLogEntry,
  type AuditExportPort,
  type DetectionSource,
  type EslActuationPort,
  type EslVendor,
  type Facing,
  type FacingId,
  type FacingLocation,
  type FacingSelector,
  type Instant,
  type LoopOutcomeRecord,
  type MerchandisingClassification,
  type Millis,
  type PilotDeployment,
  type ProductId,
  type ReportingFacing,
  type ReportingPort,
  type ReportingReadModel,
  type RetailerId,
  type RetailerInfrastructure,
  type RetailerRuntime,
  type RetailerRuntimes,
  type RetailerTenant,
  type ShelfState,
  type Signal,
  type SignalId,
  type SignalProvenance,
  type StoreId,
  type StreamRecord,
  type TimeWindow,
  type Container,
  type ConsumedBatch,
} from '../../src/index.js';
import { InMemoryFacingRepository, InMemoryIngestionLedger } from './in-memory-ports.js';
import { InMemoryEventStream, RecordingDeadLetterSink, streamBatch, streamRecord } from './in-memory-stream.js';
import { FakeFleetGateway, binding, deployment as storeDeployment } from './esl-gateways.js';
import { PILOT_WINDOW } from './tenancy.js';
import type { Payload } from './producer-wire.js';

/**
 * A running pilot, in process.
 *
 * Every integration test in `tests/integration` is driven through this: a real
 * `planPilotDeployment`, a real `startDeployment`, a real container per retailer,
 * a real detection-stream consumer subscribed to the topics the bus topology
 * actually generated, and the shipped source and vendor adapters behind them. The
 * only things swapped for doubles are the four pieces the package refuses to
 * depend on anyway — a store, a broker, a clock and a vendor's transport.
 *
 * Two properties are what make it worth building rather than hand-wiring each
 * test:
 *
 * **Nothing is shared between tenants.** One repository, one ledger, one stream,
 * one dead-letter sink, one read model and one set of gateways *per retailer*,
 * constructed inside `infrastructureFor`, exactly as a deployment opens one pool
 * and one broker client per retailer. A harness with one store behind two tenants
 * could not observe the isolation the real wiring has, so it would make every
 * partition assertion in the suite worthless.
 *
 * **Reports are read off what ingestion actually wrote.** The read model is
 * backed by the same `InMemoryFacingRepository` the ingestion service saves to,
 * rather than by a second set of rows a test asserted into place. That is the
 * only arrangement in which "recompute the index from the retained log and get
 * the reported number" means anything: with two sources of truth the audit
 * reconstruction would be comparing a fixture to itself.
 */

// ---------------------------------------------------------------------------
// Specifying a pilot
// ---------------------------------------------------------------------------

export interface PilotFacingSpec {
  readonly facingId: FacingId;
  readonly productId: ProductId;
  readonly classification: MerchandisingClassification;
  readonly location: FacingLocation;
  readonly capacityUnits: number;
  readonly initialState: ShelfState;
}

export interface PilotStoreSpec {
  readonly storeId: StoreId;
  /** The shelf-edge fleet installed in this building. */
  readonly vendor: EslVendor;
  /** The vendor's own model codes deployed here — a store mid-refresh runs two. */
  readonly modelCodes: readonly string[];
  readonly facings: readonly PilotFacingSpec[];
  /** False models a gateway that answers but cannot reach its own tags. */
  readonly gatewayReachable?: boolean;
}

export interface PilotRetailerSpec {
  readonly tenant: RetailerTenant;
  readonly stores: readonly PilotStoreSpec[];
}

export interface PilotOptions {
  /** Defaults to the twelve-month window the tenant fixtures are onboarded inside. */
  readonly window?: TimeWindow;
  /** Where the platform clock starts. Movable afterwards through `pilot.clock`. */
  readonly now: Instant;
  /** Signs sealed artifacts for every retailer, when a test is exercising that. */
  readonly signer?: { readonly signedBy: string; sign(hash: string): Promise<string> };
}

/** A clock a test can move, since the loop under test spans hours of shelf time. */
export class MutableClock {
  private at: Instant;

  constructor(at: Instant) {
    this.at = at;
  }

  readonly now = (): Instant => this.at;

  set(at: Instant): this {
    this.at = at;
    return this;
  }
}

// ---------------------------------------------------------------------------
// The retained read model
// ---------------------------------------------------------------------------

const DEFAULT_CLASSIFICATION: MerchandisingClassification = {
  departmentId: 'grocery' as MerchandisingClassification['departmentId'],
  categoryId: 'ambient' as MerchandisingClassification['categoryId'],
};

/**
 * The read side of one retailer, backed by that retailer's own facing store.
 *
 * Faithful on the things a read-side bug hides behind: it partitions by retailer,
 * it narrows by the selector rather than handing everything back, and it answers
 * `signalProvenance` only for signals whose producer was actually retained. What
 * it deliberately does *not* do is summarise: it returns whole facings, so the
 * index, the per-facing records and the audit export are three views of one step
 * function rather than three separately-rolled-up numbers that agree until they
 * do not.
 */
export class RetainedReadModel implements ReportingReadModel {
  /** Which producer instance and build stood behind each signal. */
  readonly provenance = new Map<SignalId, SignalProvenance>();
  readonly outcomes: LoopOutcomeRecord[] = [];
  readonly auditTrail: AuditLogEntry[] = [];
  /**
   * Rows this store hands back regardless of the selector.
   *
   * A seam for the one case a faithful double cannot otherwise produce: a store
   * returning a row from a partition it was never asked about — a view that lost
   * its predicate, a migration that wrote into the wrong schema. The adapter
   * re-checks the partition on the way out precisely because this is possible,
   * and a read model that could never do it would let that check rot.
   */
  readonly foreign: ReportingFacing[] = [];
  outages: readonly TimeWindow[] = [];
  incomplete: readonly FacingId[] = [];
  labour: number | null = null;
  eventRetention: Millis = millis(365 * DAY);
  artifactRetention: Millis = millis(7 * 365 * DAY);

  constructor(
    private readonly repository: InMemoryFacingRepository,
    private readonly classifications: ReadonlyMap<FacingId, MerchandisingClassification>,
    readonly retainedFrom: Instant,
  ) {}

  async facings(selector: FacingSelector): Promise<readonly ReportingFacing[]> {
    const mine = this.repository
      .all(selector.retailerId)
      .filter(
        (facing) =>
          (selector.storeIds === null || selector.storeIds.includes(facing.storeId)) &&
          (selector.productIds === null || selector.productIds.includes(facing.productId)),
      )
      .map((facing) => ({
        retailerId: facing.retailerId,
        facing,
        classification: this.classifications.get(facing.facingId) ?? DEFAULT_CLASSIFICATION,
      }));

    return [...mine, ...this.foreign];
  }

  async outcomeRecords(
    retailerId: RetailerId,
    window: TimeWindow,
  ): Promise<readonly LoopOutcomeRecord[]> {
    return this.outcomes.filter(
      (record) =>
        record.retailerId === retailerId &&
        record.detectedAt >= window.from &&
        record.detectedAt < window.to,
    );
  }

  async auditEntries(
    retailerId: RetailerId,
    window: TimeWindow,
  ): Promise<readonly AuditLogEntry[]> {
    return this.auditTrail.filter(
      (entry) => entry.retailerId === retailerId && entry.at >= window.from && entry.at < window.to,
    );
  }

  async labourHours(): Promise<number | null> {
    return this.labour;
  }

  async signalProvenance(
    _retailerId: RetailerId,
    signalIds: readonly SignalId[],
  ): Promise<ReadonlyMap<SignalId, SignalProvenance>> {
    const found = new Map<SignalId, SignalProvenance>();
    for (const id of signalIds) {
      const entry = this.provenance.get(id);
      if (entry !== undefined) found.set(id, entry);
    }
    return found;
  }

  async unobservedIntervals(): Promise<readonly TimeWindow[]> {
    return this.outages;
  }

  async incompleteFacings(): Promise<readonly FacingId[]> {
    return this.incomplete;
  }

  async retention(): Promise<{
    readonly eventRetention: Millis;
    readonly artifactRetention: Millis;
    readonly retainedFrom: Instant;
  }> {
    return {
      eventRetention: this.eventRetention,
      artifactRetention: this.artifactRetention,
      retainedFrom: this.retainedFrom,
    };
  }
}

// ---------------------------------------------------------------------------
// One retailer's running infrastructure
// ---------------------------------------------------------------------------

interface TenantParts {
  readonly repository: InMemoryFacingRepository;
  readonly ledger: InMemoryIngestionLedger;
  readonly stream: InMemoryEventStream;
  readonly deadLetters: RecordingDeadLetterSink;
  readonly readModel: RetainedReadModel;
  readonly artifacts: InMemoryAuditArtifactStore;
  readonly gateways: Map<StoreId, FakeFleetGateway>;
  readonly infrastructure: RetailerInfrastructure;
}

const facingsOf = (spec: PilotRetailerSpec): readonly Facing[] =>
  spec.stores.flatMap((store) =>
    store.facings.map((facing) =>
      createFacing({
        retailerId: spec.tenant.retailerId,
        storeId: store.storeId,
        facingId: facing.facingId,
        productId: facing.productId,
        location: facing.location,
        capacityUnits: facing.capacityUnits,
        createdAt: spec.tenant.onboardedAt,
        initialState: facing.initialState,
      }),
    ),
  );

const buildTenantParts = (
  spec: PilotRetailerSpec,
  clock: MutableClock,
  options: PilotOptions,
): TenantParts => {
  const repository = new InMemoryFacingRepository(facingsOf(spec));
  const classifications = new Map<FacingId, MerchandisingClassification>(
    spec.stores.flatMap((store) =>
      store.facings.map(
        (facing) => [facing.facingId, facing.classification] as const,
      ),
    ),
  );
  const readModel = new RetainedReadModel(repository, classifications, spec.tenant.onboardedAt);
  const ledger = new InMemoryIngestionLedger();
  const stream = new InMemoryEventStream();
  const deadLetters = new RecordingDeadLetterSink();
  const artifacts = new InMemoryAuditArtifactStore();
  const gateways = new Map<StoreId, FakeFleetGateway>();

  const storesById = new Map(spec.stores.map((store) => [store.storeId, store]));

  const gatewayFor = (retailerId: RetailerId, storeId: StoreId): FakeFleetGateway => {
    const existing = gateways.get(storeId);
    if (existing !== undefined) return existing;

    const store = storesById.get(storeId);
    if (store === undefined) {
      // A gateway answering for a store this retailer does not run is a real
      // vendor outcome, and the adapter's answer to it — `store_not_onboarded` —
      // is worth being able to exercise.
      const empty = new FakeFleetGateway(spec.stores[0]?.vendor ?? 'vusion', null);
      gateways.set(storeId, empty);
      return empty;
    }

    const gateway = new FakeFleetGateway(
      store.vendor,
      storeDeployment(store.modelCodes, {
        retailerId,
        storeId,
        gatewayReachable: store.gatewayReachable ?? true,
        observedAt: clock.now(),
      }),
      store.facings.map((facing, index) =>
        binding(
          facing.facingId,
          `tag-${storeId}-${index}`,
          // The most capable model deployed in the building; a store mid-refresh
          // is modelled by naming the older code first in `modelCodes`.
          store.modelCodes[0] ?? '',
        ),
      ),
    );
    gateways.set(storeId, gateway);
    return gateway;
  };

  const infrastructure: RetailerInfrastructure = {
    clock: clock.now,
    facings: repository,
    ledger,
    stream,
    deadLetters,
    readModel,
    eslGateway: gatewayFor,
    nextSignalId: streamSignalId,
    // Derived from the facing and its own history length, so a replay of the same
    // retained records mints the same event ids and the artifact hashes match.
    nextEventId: (facing: Facing, signal: Signal) =>
      eventId(`${facing.facingId}#${facing.history.events.length + 1}:${signal.signalId}`),
    artifacts,
    signer: options.signer ?? null,
  };

  return {
    repository,
    ledger,
    stream,
    deadLetters,
    readModel,
    artifacts,
    gateways,
    infrastructure,
  };
};

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

export interface PublishOptions {
  /**
   * The broker partition key. Defaults to the publishing retailer's id, which is
   * what `partitionKeyFor` contracts every producer to use.
   */
  readonly key?: string | null;
  /** Deliver onto a topic other than this retailer's own — for isolation tests. */
  readonly topic?: string;
  /** The broker's append time. Defaults to the clock's current instant. */
  readonly timestamp?: Instant;
}

/** Everything one retailer runs, plus the levers a test needs over it. */
export class RetailerHarness {
  /**
   * Every record this retailer's producers published, in order.
   *
   * *The* retained event log, in the only form an auditor could be handed: the
   * producers' own bytes, before this service interpreted any of them. The
   * reproducibility tests replay it into a fresh deployment, which is a much
   * stronger claim than replaying our own normalised events would be.
   */
  readonly retained: StreamRecord[] = [];

  constructor(
    readonly spec: PilotRetailerSpec,
    readonly runtime: RetailerRuntime,
    readonly parts: TenantParts,
    private readonly clock: MutableClock,
  ) {}

  get tenant(): RetailerTenant {
    return this.spec.tenant;
  }

  get retailerId(): RetailerId {
    return this.spec.tenant.retailerId;
  }

  get container(): Container {
    return this.runtime.container;
  }

  get repository(): InMemoryFacingRepository {
    return this.parts.repository;
  }

  get readModel(): RetainedReadModel {
    return this.parts.readModel;
  }

  get deadLetters(): RecordingDeadLetterSink {
    return this.parts.deadLetters;
  }

  get artifacts(): InMemoryAuditArtifactStore {
    return this.parts.artifacts;
  }

  get reporting(): ReportingPort & AuditExportPort {
    return this.container.resolve('reporting');
  }

  /** The topic this retailer's producers for `source` publish to. */
  topicFor(source: DetectionSource): string {
    const subscription = this.runtime.bus.subscriptions.find((entry) => entry.source === source);
    if (subscription === undefined) {
      throw new Error(`Retailer "${this.retailerId}" runs no "${source}" producer`);
    }
    return subscription.topic;
  }

  /** The shelf-edge fleet adapter for one store, through the shipped registry. */
  esl(storeId: StoreId): EslActuationPort {
    return this.container.resolve('eslActuation')(this.retailerId, storeId);
  }

  /** The vendor's transport, for asserting on the payload that vendor's API sees. */
  gateway(storeId: StoreId): FakeFleetGateway {
    const existing = this.parts.gateways.get(storeId);
    if (existing !== undefined) return existing;
    // Resolving the adapter is what builds the gateway; the container memoizes
    // both, so this is the same instance the loop drives.
    this.esl(storeId);
    const created = this.parts.gateways.get(storeId);
    if (created === undefined) throw new Error(`no gateway was built for store "${storeId}"`);
    return created;
  }

  /** Publishes one producer payload and consumes it, as the broker would deliver it. */
  async publish(
    source: DetectionSource,
    payload: Payload,
    options: PublishOptions = {},
  ): Promise<ConsumedBatch> {
    return this.publishBatch(source, [payload], options);
  }

  /** Publishes several payloads as one broker batch on one topic-partition. */
  async publishBatch(
    source: DetectionSource,
    payloads: readonly Payload[],
    options: PublishOptions = {},
  ): Promise<ConsumedBatch> {
    const topic = options.topic ?? this.topicFor(source);
    const key = options.key === undefined ? (this.retailerId as string) : options.key;

    const records = payloads.map((payload) =>
      streamRecord(topic, key, payload, { timestamp: options.timestamp ?? this.clock.now() }),
    );
    for (const record of records) {
      this.retained.push(record);
      this.rememberProvenance(source, record);
    }

    return this.runtime.consumer.consume(streamBatch(topic, records));
  }

  /**
   * Re-delivers the retained log into whichever consumer is given.
   *
   * Used by the reproducibility tests: a second, empty deployment fed the same
   * bytes must arrive at the same histories and therefore the same index.
   * `include` lets a test replay a *lossy* log, which is what says the
   * reconstruction is reading the records rather than reaching past them.
   */
  async replayInto(
    other: RetailerHarness,
    include: (record: StreamRecord, index: number) => boolean = () => true,
  ): Promise<void> {
    for (const [index, record] of this.retained.entries()) {
      if (!include(record, index)) continue;
      const source = sourceOfTopic(record.topic, other);
      await other.publishBatch(source, [JSON.parse(String(record.value)) as Payload], {
        key: record.key,
        timestamp: record.timestamp,
      });
    }
  }

  /** The facing as ingestion left it. */
  async facing(facingId: FacingId): Promise<Facing | null> {
    return this.repository.load(this.retailerId, facingId);
  }

  /**
   * Records the producer behind each signal this payload will normalise into.
   *
   * A real deployment retains this beside the event; here it is derived from the
   * envelope the shipped adapter reads, which is the same derivation the
   * ingestion path makes, so the audit export's "which camera, which build"
   * answers are the producer's own rather than a fixture's.
   */
  private rememberProvenance(source: DetectionSource, record: StreamRecord): void {
    let payload: unknown;
    try {
      payload = JSON.parse(String(record.value));
    } catch {
      return;
    }

    const adapter = DETECTION_SOURCE_ADAPTERS[source];
    try {
      const event = adapter.decode(payload, { record });
      const observations = event.observations as readonly unknown[];
      for (let index = 0; index < observations.length; index += 1) {
        this.readModel.provenance.set(streamSignalId(event.envelope, source, index), {
          instanceId: event.envelope.producer.instanceId,
          softwareVersion: event.envelope.producer.softwareVersion,
        });
      }
    } catch {
      // A payload the adapter refuses has no provenance to retain, and the
      // consumer is about to dead-letter it. Nothing to record, nothing to fail.
    }
  }
}

/** Reads a delivered record's topic back into the source it carries. */
const sourceOfTopic = (topic: string, harness: RetailerHarness): DetectionSource => {
  const subscription = harness.runtime.bus.subscriptions.find((entry) => entry.topic === topic);
  if (subscription !== undefined) return subscription.source;

  // A replay across retailers: topics differ by tenant segment, so fall back to
  // the source segment, which is the same in every tenant's namespace.
  const segment = topic.split('.').at(-1) ?? '';
  const match = harness.runtime.bus.subscriptions.find((entry) => entry.source === segment);
  if (match === undefined) throw new Error(`cannot route replayed topic "${topic}"`);
  return match.source;
};

export class Pilot {
  private readonly byRetailer: ReadonlyMap<RetailerId, RetailerHarness>;

  constructor(
    readonly deployment: PilotDeployment,
    readonly runtimes: RetailerRuntimes,
    readonly retailers: readonly RetailerHarness[],
    readonly clock: MutableClock,
  ) {
    this.byRetailer = new Map(retailers.map((harness) => [harness.retailerId, harness]));
  }

  /** The harness for one retailer, or a named failure — never another tenant's. */
  retailer(retailerId: RetailerId): RetailerHarness {
    const harness = this.byRetailer.get(retailerId);
    if (harness === undefined) {
      throw new Error(`Retailer "${retailerId}" is not running in this pilot`);
    }
    return harness;
  }
}

/**
 * Plans and starts a pilot from a list of retailer specs.
 *
 * The plan goes through `planPilotDeployment` unmodified, so a test that
 * configures something the engagement does not allow — one retailer, five, a
 * window outside 9–15 months — fails the same way a real deployment would rather
 * than quietly running anyway.
 */
export function startPilot(
  specs: readonly PilotRetailerSpec[],
  options: PilotOptions,
): Pilot {
  const clock = new MutableClock(options.now);
  const deployment = planPilotDeployment({
    environment: 'pilot',
    tenants: specs.map((spec) => spec.tenant),
    window: options.window ?? PILOT_WINDOW,
  });

  const partsByRetailer = new Map<RetailerId, TenantParts>(
    specs.map((spec) => [spec.tenant.retailerId, buildTenantParts(spec, clock, options)]),
  );

  const runtimes = startDeployment(deployment, (tenant) => {
    const parts = partsByRetailer.get(tenant.retailerId);
    if (parts === undefined) throw new Error(`no infrastructure for "${tenant.retailerId}"`);
    return parts.infrastructure;
  });

  const harnesses = specs.map((spec) => {
    const parts = partsByRetailer.get(spec.tenant.retailerId);
    if (parts === undefined) throw new Error(`no infrastructure for "${spec.tenant.retailerId}"`);
    return new RetailerHarness(spec, runtimes.require(spec.tenant.retailerId), parts, clock);
  });

  return new Pilot(deployment, runtimes, harnesses, clock);
}
