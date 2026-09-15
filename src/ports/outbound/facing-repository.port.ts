import type { FacingId, RetailerId } from '../../domain/common/ids.js';
import type { Facing } from '../../domain/facing/facing.js';

/**
 * Outbound (driven) port for loading and storing facing aggregates.
 *
 * Types only, as with every port in this layer. The domain is pure and the use
 * cases that orchestrate it are too; this interface is where the state they fold
 * over is fetched and put back, and it is the only reason an application service
 * is asynchronous at all.
 *
 * Every read carries the partition key explicitly rather than inferring it from a
 * session or a connection: a facing id is unique in practice, but resolving one
 * without naming the retailer is exactly the shortcut that turns a shared index
 * into a cross-tenant leak.
 */
export interface FacingRepositoryPort {
  load(retailerId: RetailerId, facingId: FacingId): Promise<Facing | null>;

  /**
   * Loads several facings at once, in whatever order is convenient. Missing ids
   * are simply absent from the result — the caller decides whether that is a
   * rejection, because the answer differs by use case.
   */
  loadMany(retailerId: RetailerId, facingIds: readonly FacingId[]): Promise<readonly Facing[]>;

  /**
   * Persists the facings an event touched, as one unit.
   *
   * Atomic across the batch by contract: one detection event is one decision
   * about a bay, and half-applying it would leave a history that no replay of the
   * event stream can reproduce.
   */
  saveAll(retailerId: RetailerId, facings: readonly Facing[]): Promise<void>;
}
