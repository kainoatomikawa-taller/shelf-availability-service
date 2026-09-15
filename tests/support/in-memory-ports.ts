import {
  type Facing,
  type FacingId,
  type FacingRepositoryPort,
  type IngestionLedgerPort,
  type Instant,
  type RetailerId,
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
