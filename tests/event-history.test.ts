import { describe, expect, it } from 'vitest';
import {
  CrossRetailerAccessError,
  OutOfOrderEventError,
  appendEvent,
  confidence,
  currentState,
  emptyHistory,
  eventId,
  eventsWithin,
  facingId,
  nextSequence,
  outOfStockEvents,
  signalId,
  stateAt,
  timeWindow,
  type FacingEventHistory,
  type FacingStateEvent,
  type Instant,
  type ShelfState,
} from '../src/index.js';
import { ACME, FACING, RIVAL, STORE, hour } from './support/fixtures.js';

let uniqueId = 0;

/** Builds the next well-formed event for a history, so tests can perturb one field at a time. */
const nextEvent = (
  history: FacingEventHistory,
  from: ShelfState,
  to: ShelfState,
  at: Instant,
  overrides: Partial<FacingStateEvent> = {},
): FacingStateEvent => ({
  eventId: eventId(`hist-${++uniqueId}`),
  retailerId: ACME,
  storeId: STORE,
  facingId: FACING,
  sequence: nextSequence(history),
  at,
  from,
  to,
  cause: {
    source: 'caper_frame',
    signalId: signalId(`sig-${uniqueId}`),
    confidence: confidence(0.9),
  },
  ...overrides,
});

const push = (
  history: FacingEventHistory,
  from: ShelfState,
  to: ShelfState,
  at: Instant,
): FacingEventHistory => appendEvent(history, nextEvent(history, from, to, at));

const history = () => emptyHistory(ACME, FACING, hour(0), 'in_stock');

describe('facing event history', () => {
  it('starts at the initial state with no events', () => {
    expect(currentState(history())).toBe('in_stock');
    expect(history().events).toEqual([]);
  });

  it('appends transitions without mutating the prior history', () => {
    const before = history();
    const after = push(before, 'in_stock', 'out_of_stock', hour(4));

    expect(before.events).toHaveLength(0);
    expect(after.events).toHaveLength(1);
    expect(currentState(after)).toBe('out_of_stock');
  });

  it('numbers events monotonically from one', () => {
    let log = history();
    log = push(log, 'in_stock', 'out_of_stock', hour(4));
    log = push(log, 'out_of_stock', 'in_stock', hour(6));

    expect(log.events.map((e) => e.sequence)).toEqual([1, 2]);
  });

  it('rejects an event that precedes the last recorded one', () => {
    const withEvent = push(history(), 'in_stock', 'out_of_stock', hour(10));

    expect(() =>
      appendEvent(withEvent, nextEvent(withEvent, 'out_of_stock', 'in_stock', hour(6))),
    ).toThrow(OutOfOrderEventError);
  });

  it('rejects a first event predating the facing itself', () => {
    const openedLate = emptyHistory(ACME, FACING, hour(8), 'in_stock');

    expect(() =>
      appendEvent(openedLate, nextEvent(openedLate, 'in_stock', 'out_of_stock', hour(2))),
    ).toThrow(OutOfOrderEventError);
  });

  it('rejects an event whose "from" disagrees with the current state', () => {
    const log = history();

    expect(() => appendEvent(log, nextEvent(log, 'out_of_stock', 'in_stock', hour(4)))).toThrow(
      OutOfOrderEventError,
    );
  });

  it('rejects a non-transition, since the history records changes only', () => {
    const log = history();

    expect(() => appendEvent(log, nextEvent(log, 'in_stock', 'in_stock', hour(4)))).toThrow(
      OutOfOrderEventError,
    );
  });

  it('rejects an event carrying the wrong sequence number', () => {
    const log = history();

    expect(() =>
      appendEvent(log, nextEvent(log, 'in_stock', 'out_of_stock', hour(4), { sequence: 7 })),
    ).toThrow(OutOfOrderEventError);
  });

  it('rejects an event from another retailer partition', () => {
    const log = history();

    expect(() =>
      appendEvent(log, nextEvent(log, 'in_stock', 'out_of_stock', hour(4), { retailerId: RIVAL })),
    ).toThrow(CrossRetailerAccessError);
  });

  it('rejects an event for a different facing', () => {
    const log = history();

    expect(() =>
      appendEvent(
        log,
        nextEvent(log, 'in_stock', 'out_of_stock', hour(4), {
          facingId: facingId('some-other-facing'),
        }),
      ),
    ).toThrow(OutOfOrderEventError);
  });

  it('accepts two events sharing an instant, ordered by sequence', () => {
    let log = history();
    log = push(log, 'in_stock', 'out_of_stock', hour(5));
    log = push(log, 'out_of_stock', 'in_stock', hour(5));

    expect(log.events.map((e) => e.sequence)).toEqual([1, 2]);
    expect(currentState(log)).toBe('in_stock');
  });
});

describe('facing event history — queries', () => {
  const populated = (() => {
    let log = history();
    log = push(log, 'in_stock', 'out_of_stock', hour(3));
    log = push(log, 'out_of_stock', 'in_stock', hour(9));
    log = push(log, 'in_stock', 'out_of_stock', hour(21));
    return log;
  })();

  it('replays the state as of any instant', () => {
    expect(stateAt(populated, hour(1))).toBe('in_stock');
    expect(stateAt(populated, hour(3))).toBe('out_of_stock');
    expect(stateAt(populated, hour(12))).toBe('in_stock');
    expect(stateAt(populated, hour(23))).toBe('out_of_stock');
  });

  it('selects events inside a half-open window', () => {
    const window = timeWindow(hour(3), hour(21));

    expect(eventsWithin(populated, window).map((e) => e.at)).toEqual([hour(3), hour(9)]);
  });

  it('surfaces the out-of-stock transitions that trigger tasks', () => {
    expect(outOfStockEvents(populated).map((e) => e.at)).toEqual([hour(3), hour(21)]);
  });
});
