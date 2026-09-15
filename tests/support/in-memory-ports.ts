import {
  type ClearExpressionCommand,
  type EslActuationPort,
  type EslActuationResult,
  type EslClearResult,
  type EslExpressionId,
  type EslExpressionMode,
  type EslFleetCapabilities,
  type EslUnavailableReason,
  type ExpressTaskBatch,
  type ExpressTaskCommand,
  type Facing,
  type FacingId,
  type FacingRepositoryPort,
  type IngestionLedgerPort,
  type Instant,
  type RetailerId,
  type StoreId,
} from '../../src/index.js';

/**
 * In-memory adapters for the two outbound ports the ingestion service drives.
 *
 * Deliberately faithful rather than convenient: both partition their state by
 * retailer, so a test that leaks across tenants fails here rather than passing
 * against a store that never had the isolation the real one does.
 */

const partitioned = <T>(): Map<RetailerId, Map<string, T>> => new Map();

const partitionOf = <T>(store: Map<RetailerId, Map<string, T>>, retailerId: RetailerId) => {
  const existing = store.get(retailerId);
  if (existing !== undefined) return existing;
  const created = new Map<string, T>();
  store.set(retailerId, created);
  return created;
};

export class InMemoryFacingRepository implements FacingRepositoryPort {
  private readonly store = partitioned<Facing>();

  /** Counts `saveAll` calls, so a test can assert one event is one write. */
  saveCount = 0;

  constructor(facings: readonly Facing[] = []) {
    for (const facing of facings) {
      partitionOf(this.store, facing.retailerId).set(facing.facingId, facing);
    }
  }

  async load(retailerId: RetailerId, facingId: FacingId): Promise<Facing | null> {
    return partitionOf(this.store, retailerId).get(facingId) ?? null;
  }

  async loadMany(retailerId: RetailerId, facingIds: readonly FacingId[]): Promise<readonly Facing[]> {
    const partition = partitionOf(this.store, retailerId);
    return facingIds
      .map((facingId) => partition.get(facingId))
      .filter((facing): facing is Facing => facing !== undefined);
  }

  async saveAll(retailerId: RetailerId, facings: readonly Facing[]): Promise<void> {
    this.saveCount += 1;
    const partition = partitionOf(this.store, retailerId);
    for (const facing of facings) {
      partition.set(facing.facingId, facing);
    }
  }
}

export class InMemoryIngestionLedger implements IngestionLedgerPort {
  private readonly store = partitioned<Instant>();

  async firstAcceptedAt(retailerId: RetailerId, idempotencyKey: string): Promise<Instant | null> {
    return partitionOf(this.store, retailerId).get(idempotencyKey) ?? null;
  }

  async record(
    retailerId: RetailerId,
    idempotencyKey: string,
    acceptedAt: Instant,
  ): Promise<Instant> {
    const partition = partitionOf(this.store, retailerId);
    const winner = partition.get(idempotencyKey) ?? acceptedAt;
    partition.set(idempotencyKey, winner);
    return winner;
  }
}

/**
 * A shelf-edge fleet that lights whatever the capabilities it was handed allow.
 *
 * Faithful to the port's contract rather than convenient: it walks the caller's
 * ladder against its own supported modes, reports the rung it landed on and
 * whether that was a degradation, leases every expression, and keeps expressions
 * keyed by `(taskId, facingId)` so a re-express refreshes rather than stacks.
 * Failures are scripted per facing, because "the tag was dark" is the case worth
 * testing and the one a forgiving double would never produce.
 */
export class InMemoryEslFleet implements EslActuationPort {
  /** Every command the fleet was asked to express, in order. */
  readonly commands: ExpressTaskCommand[] = [];
  readonly clears: ClearExpressionCommand[] = [];
  /** Live expressions, keyed `taskId|facingId`. */
  readonly expressions = new Map<string, EslExpressionMode>();
  /** Scripted refusals, keyed by facing id. */
  readonly failures = new Map<FacingId, EslUnavailableReason>();
  batchCalls = 0;

  constructor(private readonly capabilities: EslFleetCapabilities) {}

  async describeCapabilities(
    retailerId: RetailerId,
    storeId: StoreId,
  ): Promise<EslFleetCapabilities> {
    if (this.capabilities.retailerId !== retailerId || this.capabilities.storeId !== storeId) {
      throw new Error(`No fleet onboarded for ${retailerId}/${storeId}`);
    }
    return this.capabilities;
  }

  async express(command: ExpressTaskCommand): Promise<EslActuationResult> {
    this.commands.push(command);

    const failure = this.failures.get(command.facingId);
    if (failure !== undefined) {
      return { status: 'unavailable', reason: failure, retryAfter: null };
    }

    const mode =
      command.modePreference.find((candidate) =>
        this.capabilities.supportedModes.includes(candidate),
      ) ?? 'none';

    if (mode === 'none') {
      return { status: 'unavailable', reason: 'no_supported_mode', retryAfter: null };
    }

    this.expressions.set(`${command.taskId}|${command.facingId}`, mode);
    const renderable = this.capabilities.renderableColours.includes(command.lane);

    return {
      status: 'expressed',
      expressionId: `exp-${command.taskId}` as EslExpressionId,
      mode,
      degraded: mode !== command.modePreference[0],
      renderedColour: renderable ? command.lane : null,
      expressedAt: command.requestedAt,
      leaseExpiresAt: command.expiresAt,
    };
  }

  async expressBatch(batch: ExpressTaskBatch): Promise<readonly EslActuationResult[]> {
    this.batchCalls += 1;
    if (batch.commands.length > this.capabilities.batchLimit) {
      throw new Error(
        `Batch of ${batch.commands.length} exceeds the fleet's limit of ${this.capabilities.batchLimit}`,
      );
    }
    const results: EslActuationResult[] = [];
    for (const command of batch.commands) results.push(await this.express(command));
    return results;
  }

  async refresh(
    _retailerId: RetailerId,
    expressionId: EslExpressionId,
    requestedAt: Instant,
  ): Promise<EslActuationResult> {
    return {
      status: 'expressed',
      expressionId,
      mode: 'pick_to_light',
      degraded: false,
      renderedColour: null,
      expressedAt: requestedAt,
      leaseExpiresAt: (requestedAt + this.capabilities.expressionLeaseMillis) as Instant,
    };
  }

  async clear(command: ClearExpressionCommand): Promise<EslClearResult> {
    this.clears.push(command);
    const key = `${command.taskId}|${command.facingId}`;
    if (!this.expressions.has(key)) return { status: 'not_expressed' };
    this.expressions.delete(key);
    return { status: 'cleared', clearedAt: command.requestedAt };
  }
}
