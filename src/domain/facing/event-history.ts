import { OutOfOrderEventError } from '../common/errors.js';
import type { EventId, FacingId, RetailerId, SignalId, StoreId } from '../common/ids.js';
import { assertSameRetailer, type RetailerPartitioned } from '../common/partition.js';
import { toISO, type Instant, type TimeWindow } from '../common/time.js';
import type { ShelfState } from './shelf-state.js';
import type { Confidence, SignalSource } from './signals.js';

/**
 * One in-stock/out-of-stock transition at a facing.
 *
 * Events record transitions only — a re-observation of the state the facing is
 * already in is not an event. That keeps the history an exact description of the
 * step function the availability index integrates over.
 */
export interface FacingStateEvent extends RetailerPartitioned {
  readonly eventId: EventId;
  readonly retailerId: RetailerId;
  readonly storeId: StoreId;
  readonly facingId: FacingId;
  /** Monotonic per facing, starting at 1. Disambiguates events sharing an instant. */
  readonly sequence: number;
  readonly at: Instant;
  readonly from: ShelfState;
  readonly to: ShelfState;
  readonly cause: {
    readonly source: SignalSource;
    readonly signalId: SignalId;
    readonly confidence: Confidence;
  };
}

/**
 * Append-only, strictly time-ordered event log for a single facing in a single
 * retailer partition.
 */
export interface FacingEventHistory extends RetailerPartitioned {
  readonly retailerId: RetailerId;
  readonly facingId: FacingId;
  /** The state the facing held before the first recorded event. */
  readonly initialState: ShelfState;
  readonly openedAt: Instant;
  readonly events: readonly FacingStateEvent[];
}

export const emptyHistory = (
  retailerId: RetailerId,
  facingId: FacingId,
  openedAt: Instant,
  initialState: ShelfState = 'unknown',
): FacingEventHistory => ({ retailerId, facingId, initialState, openedAt, events: [] });

export const lastEvent = (history: FacingEventHistory): FacingStateEvent | null =>
  history.events.at(-1) ?? null;

export const nextSequence = (history: FacingEventHistory): number =>
  (lastEvent(history)?.sequence ?? 0) + 1;

/** State of the facing after every recorded event. */
export const currentState = (history: FacingEventHistory): ShelfState =>
  lastEvent(history)?.to ?? history.initialState;

/**
 * Appends an event, enforcing the two invariants the rest of the domain relies on:
 * single-partition and non-decreasing observation time. Returns a new history —
 * histories are values, never mutated in place.
 */
export function appendEvent(
  history: FacingEventHistory,
  event: FacingStateEvent,
): FacingEventHistory {
  assertSameRetailer(history.retailerId, event, 'appendEvent');

  if (event.facingId !== history.facingId) {
    throw new OutOfOrderEventError(
      `Event ${event.eventId} targets facing "${event.facingId}" but history is for "${history.facingId}"`,
    );
  }

  const previous = lastEvent(history);
  if (previous !== null && event.at < previous.at) {
    throw new OutOfOrderEventError(
      `Event ${event.eventId} at ${toISO(event.at)} precedes the last recorded event at ${toISO(previous.at)}`,
    );
  }
  if (previous === null && event.at < history.openedAt) {
    throw new OutOfOrderEventError(
      `Event ${event.eventId} at ${toISO(event.at)} precedes the facing's opening at ${toISO(history.openedAt)}`,
    );
  }

  const expectedSequence = nextSequence(history);
  if (event.sequence !== expectedSequence) {
    throw new OutOfOrderEventError(
      `Event ${event.eventId} carries sequence ${event.sequence} but the facing expects ${expectedSequence}`,
    );
  }

  const expectedFrom = currentState(history);
  if (event.from !== expectedFrom) {
    throw new OutOfOrderEventError(
      `Event ${event.eventId} claims a transition from "${event.from}" but the facing is "${expectedFrom}"`,
    );
  }
  if (event.from === event.to) {
    throw new OutOfOrderEventError(
      `Event ${event.eventId} is not a transition: "${event.from}" -> "${event.to}"`,
    );
  }

  return { ...history, events: [...history.events, event] };
}

/** State the facing was in at `at`, replaying the history up to that instant. */
export function stateAt(history: FacingEventHistory, at: Instant): ShelfState {
  let state = history.initialState;
  for (const event of history.events) {
    if (event.at > at) break;
    state = event.to;
  }
  return state;
}

/** Events falling inside the half-open window `[from, to)`, in order. */
export const eventsWithin = (
  history: FacingEventHistory,
  window: TimeWindow,
): readonly FacingStateEvent[] =>
  history.events.filter((event) => event.at >= window.from && event.at < window.to);

/** Transitions into `out_of_stock` — the trigger surface for task creation. */
export const outOfStockEvents = (history: FacingEventHistory): readonly FacingStateEvent[] =>
  history.events.filter((event) => event.to === 'out_of_stock');
