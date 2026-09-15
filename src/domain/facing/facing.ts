import { assertNever } from '../common/exhaustive.js';
import type { EventId, FacingId, ProductId, RetailerId, StoreId } from '../common/ids.js';
import { assertSameRetailer, type RetailerPartitioned } from '../common/partition.js';
import type { Instant } from '../common/time.js';
import {
  appendEvent,
  currentState,
  emptyHistory,
  nextSequence,
  type FacingEventHistory,
  type FacingStateEvent,
} from './event-history.js';
import {
  interpretSignal,
  STANDARD_INTERPRETATION_POLICY,
  type InterpretationPolicy,
} from './interpretation.js';
import type { ShelfState } from './shelf-state.js';
import { emptySignalSnapshot, type Signal, type SignalSnapshot } from './signals.js';

/** Physical address of the facing inside the store. */
export interface FacingLocation {
  readonly aisle: string;
  readonly bay: string;
  readonly shelf: number;
  /** Left-to-right index of the facing within the shelf. */
  readonly position: number;
}

/**
 * The addressable unit of the whole service: one product in one slot on one
 * shelf in one store of one retailer.
 *
 * Everything upstream (six signal families) and downstream (tasks, verification,
 * the availability index, audit) hangs off this identity. The aggregate holds the
 * latest observation from each source plus the full transition history, so a
 * facing answers both "what does every system currently say?" and "what has
 * actually happened here?" without a join.
 */
export interface Facing extends RetailerPartitioned {
  /** Partition key. First-class, and never derived from the caller's session. */
  readonly retailerId: RetailerId;
  readonly storeId: StoreId;
  readonly facingId: FacingId;
  readonly productId: ProductId;
  readonly location: FacingLocation;
  readonly capacityUnits: number;
  readonly state: ShelfState;
  /** When the facing entered `state`. */
  readonly stateSince: Instant;
  /** Latest signal from each of the six sources, unified on the one object. */
  readonly signals: SignalSnapshot;
  readonly history: FacingEventHistory;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
}

export interface CreateFacingInput {
  readonly retailerId: RetailerId;
  readonly storeId: StoreId;
  readonly facingId: FacingId;
  readonly productId: ProductId;
  readonly location: FacingLocation;
  readonly capacityUnits: number;
  readonly createdAt: Instant;
  readonly initialState?: ShelfState;
}

export function createFacing(input: CreateFacingInput): Facing {
  const initialState = input.initialState ?? 'unknown';
  return {
    retailerId: input.retailerId,
    storeId: input.storeId,
    facingId: input.facingId,
    productId: input.productId,
    location: input.location,
    capacityUnits: input.capacityUnits,
    state: initialState,
    stateSince: input.createdAt,
    signals: emptySignalSnapshot(),
    history: emptyHistory(input.retailerId, input.facingId, input.createdAt, initialState),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

/**
 * Outcome of folding one signal into a facing.
 *
 * Explicit variants rather than a bare facing: callers (task engine, audit,
 * metrics) need to distinguish "the shelf just went empty" from "a fourth camera
 * agreed with the other three" without diffing two aggregates.
 */
export type SignalApplication =
  | { readonly outcome: 'transitioned'; readonly facing: Facing; readonly event: FacingStateEvent }
  | { readonly outcome: 'reaffirmed'; readonly facing: Facing }
  | { readonly outcome: 'no_stock_evidence'; readonly facing: Facing; readonly reason: string }
  | { readonly outcome: 'stale_ignored'; readonly facing: Facing; readonly reason: string };

export interface RecordSignalOptions {
  readonly policy?: InterpretationPolicy;
  /** Supplies the id for a transition event. Kept injectable so the domain stays pure. */
  readonly nextEventId: (facing: Facing, signal: Signal) => EventId;
}

/**
 * Folds a signal into the facing: refreshes that source's slot in the snapshot
 * and, when the interpreted evidence disagrees with the current state, appends a
 * transition to the time-ordered history.
 *
 * Pure: no clock, no IO. Out-of-order arrivals older than the current state are
 * kept in the snapshot only if they are the freshest for their source, and never
 * rewrite history.
 */
export function recordSignal(
  facing: Facing,
  signal: Signal,
  options: RecordSignalOptions,
): SignalApplication {
  assertSameRetailer(facing.retailerId, signal, 'recordSignal');

  if (signal.facingId !== facing.facingId) {
    throw new Error(
      `Signal ${signal.signalId} targets facing "${signal.facingId}" but was applied to "${facing.facingId}"`,
    );
  }

  const known = facing.signals[signal.source];
  const isFreshestForSource = known === null || signal.observedAt >= known.observedAt;
  const withSignal: Facing = isFreshestForSource
    ? {
        ...facing,
        signals: { ...facing.signals, [signal.source]: signal },
        updatedAt: signal.observedAt > facing.updatedAt ? signal.observedAt : facing.updatedAt,
      }
    : facing;

  const evidence = interpretSignal(signal, options.policy ?? STANDARD_INTERPRETATION_POLICY);

  switch (evidence.kind) {
    case 'no_stock_evidence':
      return { outcome: 'no_stock_evidence', facing: withSignal, reason: evidence.reason };

    case 'observation': {
      // History is append-only and time-ordered: a signal observed before the
      // current state began cannot retroactively change it.
      if (evidence.at < facing.stateSince) {
        return {
          outcome: 'stale_ignored',
          facing: withSignal,
          reason: 'observed before the current state began',
        };
      }
      if (evidence.state === facing.state) {
        return { outcome: 'reaffirmed', facing: withSignal };
      }

      const event: FacingStateEvent = {
        eventId: options.nextEventId(withSignal, signal),
        retailerId: facing.retailerId,
        storeId: facing.storeId,
        facingId: facing.facingId,
        sequence: nextSequence(withSignal.history),
        at: evidence.at,
        from: facing.state,
        to: evidence.state,
        cause: {
          source: signal.source,
          signalId: signal.signalId,
          confidence: evidence.confidence,
        },
      };

      const history = appendEvent(withSignal.history, event);
      const next: Facing = {
        ...withSignal,
        state: currentState(history),
        stateSince: event.at,
        history,
        updatedAt: event.at > withSignal.updatedAt ? event.at : withSignal.updatedAt,
      };
      return { outcome: 'transitioned', facing: next, event };
    }

    default:
      return assertNever(evidence, 'recordSignal');
  }
}

/** Number of the six sources that have ever reported on this facing. */
export const observedSourceCount = (facing: Facing): number =>
  Object.values(facing.signals).filter((signal) => signal !== null).length;
