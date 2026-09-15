import type { RetailerId } from '../../domain/common/ids.js';
import type { Instant } from '../../domain/common/time.js';

/**
 * Outbound (driven) port backing the idempotency guarantee `DetectionIngestionPort`
 * makes to its producers.
 *
 * Redelivery is normal at the detection edge — a cart reconnects, a gateway
 * replays its buffer — so "ingest once per `idempotencyKey`" has to be a fact
 * about stored state, not about how carefully the adapter retries. The ledger is
 * the state.
 *
 * Keys are scoped by retailer: two producers in two partitions may legitimately
 * mint the same key, and a shared key space would have one silently swallow the
 * other's event.
 */
export interface IngestionLedgerPort {
  /** When this key was first accepted, or `null` if it never has been. */
  firstAcceptedAt(retailerId: RetailerId, idempotencyKey: string): Promise<Instant | null>;

  /**
   * Records a key as accepted.
   *
   * Returns the *winning* instant: the one already stored if another writer got
   * there first, otherwise `acceptedAt`. Returning rather than throwing lets the
   * caller answer a racing redelivery with the original outcome, which is what
   * the port promises, instead of failing an event that was in fact ingested.
   */
  record(retailerId: RetailerId, idempotencyKey: string, acceptedAt: Instant): Promise<Instant>;
}
