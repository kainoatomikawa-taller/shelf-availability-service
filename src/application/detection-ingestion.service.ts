import { CrossRetailerAccessError } from '../domain/common/errors.js';
import type { EventId, FacingId, RetailerId } from '../domain/common/ids.js';
import type { Instant } from '../domain/common/time.js';
import { recordSignal, type Facing, type SignalApplication } from '../domain/facing/facing.js';
import type { InterpretationPolicy } from '../domain/facing/interpretation.js';
import type { Signal } from '../domain/facing/signals.js';
import {
  DETECTION_SCHEMA_CONTRACT,
  type DetectionEvent,
  type DetectionEventBatch,
  type DetectionIngestionPort,
  type IngestionOutcome,
  type ObservationResult,
} from '../ports/inbound/detection-ingestion.port.js';
import type { SchemaContract } from '../ports/common/schema-contract.js';
import type { FacingRepositoryPort } from '../ports/outbound/facing-repository.port.js';
import type { IngestionLedgerPort } from '../ports/outbound/ingestion-ledger.port.js';
import { normalizeDetectionEvent, type NormalizationContext } from './signal-normalization.js';

export interface DetectionIngestionDependencies {
  readonly facings: FacingRepositoryPort;
  readonly ledger: IngestionLedgerPort;
  /** The platform clock. Injected, so the domain and its orchestration stay pure. */
  readonly now: () => Instant;
  readonly nextSignalId: NormalizationContext['nextSignalId'];
  readonly nextEventId: (facing: Facing, signal: Signal) => EventId;
  /** Retailer-tuned detection thresholds; the standard policy when absent. */
  readonly policy?: InterpretationPolicy;
}

const emittedEventIdOf = (application: SignalApplication): EventId | null =>
  application.outcome === 'transitioned' ? application.event.eventId : null;

/**
 * Normalizes detection events into the facing model and maintains the per-facing
 * time-ordered event history.
 *
 * The orchestration is deliberately thin. Deciding what a signal means is
 * `interpretSignal`'s job, deciding whether it moves the shelf is `recordSignal`'s,
 * and the history's ordering invariants are enforced by `appendEvent`. What lives
 * here is the part that is genuinely about the boundary: schema acceptance,
 * idempotency, loading and storing aggregates, and turning domain outcomes into
 * the port's vocabulary.
 */
export class DetectionIngestionService implements DetectionIngestionPort {
  constructor(private readonly deps: DetectionIngestionDependencies) {}

  async describeSchemaContract(): Promise<SchemaContract> {
    return DETECTION_SCHEMA_CONTRACT;
  }

  async ingest(event: DetectionEvent): Promise<IngestionOutcome> {
    const { envelope } = event;

    if (!DETECTION_SCHEMA_CONTRACT.supported.includes(envelope.schemaVersion)) {
      return {
        status: 'rejected',
        rejection: {
          reason: 'unsupported_schema_version',
          received: envelope.schemaVersion,
          supported: DETECTION_SCHEMA_CONTRACT.supported,
        },
      };
    }

    // A producer that labels itself one system and sends another's payload has a
    // routing bug; accepting it would attribute the observation to the wrong
    // sensor for the rest of the audit trail.
    if (envelope.producer.system !== event.source) {
      return {
        status: 'rejected',
        rejection: {
          reason: 'schema_violation',
          field: 'envelope.producer.system',
          detail: `producer declares "${envelope.producer.system}" but the event carries "${event.source}" observations`,
        },
      };
    }

    const alreadyAccepted = await this.deps.ledger.firstAcceptedAt(
      envelope.retailerId,
      envelope.idempotencyKey,
    );
    if (alreadyAccepted !== null) {
      return {
        status: 'duplicate',
        idempotencyKey: envelope.idempotencyKey,
        firstAcceptedAt: alreadyAccepted,
      };
    }

    const signals = normalizeDetectionEvent(event, {
      nextSignalId: this.deps.nextSignalId,
      receivedAt: this.deps.now(),
    });

    // Load every facing the event touches before applying any of it. One event is
    // one decision about a bay: half-applying it and then rejecting the rest
    // would leave a history no replay of the event stream can reproduce.
    const facingIds = [...new Set(signals.map((signal) => signal.facingId))];
    const loaded = await this.deps.facings.loadMany(envelope.retailerId, facingIds);
    const working = new Map<FacingId, Facing>(loaded.map((facing) => [facing.facingId, facing]));

    const missing = facingIds.find((facingId) => !working.has(facingId));
    if (missing !== undefined) {
      return { status: 'rejected', rejection: { reason: 'unknown_facing', facingId: missing } };
    }

    const results: ObservationResult[] = [];
    const touched = new Set<FacingId>();

    try {
      for (const signal of signals) {
        // Non-null: every id in `signals` was just proven present above, and each
        // pass writes the updated aggregate back under the same key.
        const facing = working.get(signal.facingId) as Facing;
        const application = recordSignal(facing, signal, {
          ...(this.deps.policy === undefined ? {} : { policy: this.deps.policy }),
          nextEventId: this.deps.nextEventId,
        });

        working.set(signal.facingId, application.facing);
        touched.add(signal.facingId);
        results.push({
          facingId: signal.facingId,
          signalId: signal.signalId,
          application: application.outcome,
          resultingState: application.facing.state,
          emittedEventId: emittedEventIdOf(application),
        });
      }
    } catch (error: unknown) {
      if (error instanceof CrossRetailerAccessError) {
        return {
          status: 'rejected',
          rejection: {
            reason: 'cross_retailer_mismatch',
            expected: error.expected,
            actual: error.actual,
          },
        };
      }
      throw error;
    }

    const acceptedAt = this.deps.now();
    await this.deps.facings.saveAll(
      envelope.retailerId,
      [...touched].map((facingId) => working.get(facingId) as Facing),
    );

    // The ledger is written after the aggregates, not before: a crash in between
    // replays the event, and a replay is a no-op the domain already handles —
    // history records transitions only, so re-applying a signal to the state it
    // already produced reaffirms rather than duplicates. Recording first would
    // trade that harmless repeat for a silently dropped observation.
    const winner = await this.deps.ledger.record(
      envelope.retailerId,
      envelope.idempotencyKey,
      acceptedAt,
    );
    if (winner !== acceptedAt) {
      return {
        status: 'duplicate',
        idempotencyKey: envelope.idempotencyKey,
        firstAcceptedAt: winner,
      };
    }

    return { status: 'accepted', acceptedAt, results };
  }

  /**
   * Ingests a batch, one outcome per submitted event in submission order.
   *
   * Sequential rather than concurrent, and deliberately so: events in a batch
   * routinely touch the same facing, and the history's ordering invariants are
   * enforced against the aggregate as loaded. Fanning out would race two passes
   * over the same shelf against each other.
   *
   * Events are accepted or rejected individually — one malformed frame must not
   * stall a whole store's stream.
   */
  async ingestBatch(batch: DetectionEventBatch): Promise<readonly IngestionOutcome[]> {
    const outcomes: IngestionOutcome[] = [];

    for (const event of batch.events) {
      const mismatch = partitionMismatch(batch.retailerId, event);
      outcomes.push(mismatch ?? (await this.ingest(event)));
    }

    return outcomes;
  }
}

/**
 * A batch is single-partition by construction, so an event carrying a different
 * retailer is rejected rather than ingested under the batch's partition. Rejected
 * positionally rather than thrown, because the other events in the batch are
 * innocent and their producers are waiting on an answer.
 */
const partitionMismatch = (
  expected: RetailerId,
  event: DetectionEvent,
): IngestionOutcome | null =>
  event.envelope.retailerId === expected
    ? null
    : {
        status: 'rejected',
        rejection: {
          reason: 'cross_retailer_mismatch',
          expected,
          actual: event.envelope.retailerId,
        },
      };
