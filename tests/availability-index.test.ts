import { describe, expect, it } from 'vitest';
import {
  CrossRetailerAccessError,
  computeAvailabilityIndex,
  computeFacingAvailability,
  confidence,
  eventId,
  facingId,
  recordSignal,
  signalId,
  timelineFor,
  timeWindow,
  type FacingStateEvent,
  type FacingTimeline,
  type Instant,
  type ShelfState,
} from '../src/index.js';
import {
  ACME,
  FACING,
  RIVAL,
  STORE,
  arpalusDetection,
  facingAt,
  hour,
  nextEventId,
  shopperScan,
} from './support/fixtures.js';

const HOURS = (n: number) => n * 60 * 60 * 1000;

let seq = 0;
const transition = (from: ShelfState, to: ShelfState, at: Instant): FacingStateEvent => ({
  eventId: eventId(`idx-evt-${++seq}`),
  retailerId: ACME,
  storeId: STORE,
  facingId: FACING,
  sequence: seq,
  at,
  from,
  to,
  cause: {
    source: 'arpalus_detection',
    signalId: signalId(`idx-sig-${seq}`),
    confidence: confidence(0.9),
  },
});

const timeline = (
  stateAtWindowStart: ShelfState,
  events: readonly FacingStateEvent[],
  id = FACING,
): FacingTimeline => ({
  retailerId: ACME,
  storeId: STORE,
  facingId: id,
  stateAtWindowStart,
  events,
});

const day = timeWindow(hour(0), hour(24));

describe('availability index — facing-time in stock', () => {
  it('scores a facing that is in stock for the whole window as 1', () => {
    const result = computeFacingAvailability(timeline('in_stock', []), day);

    expect(result.index).toBe(1);
    expect(result.coverage).toBe(1);
    expect(result.inStockMillis).toBe(HOURS(24));
    expect(result.outOfStockMillis).toBe(0);
  });

  it('scores a facing that is out of stock for the whole window as 0', () => {
    const result = computeFacingAvailability(timeline('out_of_stock', []), day);

    expect(result.index).toBe(0);
    expect(result.coverage).toBe(1);
  });

  it('divides in-stock facing-time by measured facing-time', () => {
    // In stock 00:00-18:00, out of stock 18:00-24:00 => 18 / 24.
    const result = computeFacingAvailability(
      timeline('in_stock', [transition('in_stock', 'out_of_stock', hour(18))]),
      day,
    );

    expect(result.inStockMillis).toBe(HOURS(18));
    expect(result.outOfStockMillis).toBe(HOURS(6));
    expect(result.index).toBe(0.75);
  });

  it('carries the pre-window state into the window instead of starting from the first event', () => {
    // Went out of stock the night before; restocked at 06:00.
    const result = computeFacingAvailability(
      timeline('out_of_stock', [transition('out_of_stock', 'in_stock', hour(6))]),
      day,
    );

    expect(result.outOfStockMillis).toBe(HOURS(6));
    expect(result.inStockMillis).toBe(HOURS(18));
    expect(result.index).toBe(0.75);
  });

  it('excludes unknown time from both numerator and denominator, and reports it as coverage', () => {
    // 00:00-06:00 unknown, 06:00-18:00 in stock, 18:00-24:00 out of stock.
    const result = computeFacingAvailability(
      timeline('unknown', [
        transition('unknown', 'in_stock', hour(6)),
        transition('in_stock', 'out_of_stock', hour(18)),
      ]),
      day,
    );

    expect(result.unknownMillis).toBe(HOURS(6));
    expect(result.measuredMillis).toBe(HOURS(18));
    expect(result.index).toBe(12 / 18);
    expect(result.coverage).toBe(18 / 24);
  });

  it('returns a null index — not zero — when nothing in the window was measured', () => {
    const result = computeFacingAvailability(timeline('unknown', []), day);

    expect(result.index).toBeNull();
    expect(result.coverage).toBe(0);
  });

  it('returns a null index for a zero-length window', () => {
    const result = computeFacingAvailability(timeline('in_stock', []), timeWindow(hour(9), hour(9)));

    expect(result.index).toBeNull();
    expect(result.coverage).toBe(0);
  });

  it('clamps events that land outside the window', () => {
    const shift = timeWindow(hour(8), hour(16));
    const result = computeFacingAvailability(
      timeline('in_stock', [
        transition('in_stock', 'out_of_stock', hour(4)), // before the window
        transition('out_of_stock', 'in_stock', hour(12)), // inside
        transition('in_stock', 'out_of_stock', hour(20)), // after the window
      ]),
      shift,
    );

    // Carry-in is in_stock; the pre-window event still advances state to
    // out_of_stock for 08:00-12:00, then in stock for 12:00-16:00.
    expect(result.outOfStockMillis).toBe(HOURS(4));
    expect(result.inStockMillis).toBe(HOURS(4));
    expect(result.index).toBe(0.5);
  });
});

describe('availability index — aggregation across facings', () => {
  it('weights by facing-time rather than averaging per-facing indexes', () => {
    const fullDay = timeline('in_stock', [], facingId('facing-always-stocked'));
    // Second facing measured for only the last 6 hours, entirely out of stock.
    const sliver = timeline(
      'unknown',
      [transition('unknown', 'out_of_stock', hour(18))],
      facingId('facing-briefly-seen'),
    );

    const index = computeAvailabilityIndex(ACME, [fullDay, sliver], day);

    // Facing-time weighted: 24h in stock over 30h measured.
    expect(index.inStockFacingMillis).toBe(HOURS(24));
    expect(index.measuredFacingMillis).toBe(HOURS(30));
    expect(index.index).toBe(24 / 30);
    // A naive average of the two per-facing indexes (1 and 0) would have said 0.5.
    expect(index.index).not.toBe(0.5);
    expect(index.facingCount).toBe(2);
    expect(index.coverage).toBe(30 / 48);
  });

  it('reports a per-facing breakdown alongside the rolled-up index', () => {
    const index = computeAvailabilityIndex(ACME, [timeline('in_stock', [])], day);

    expect(index.perFacing).toHaveLength(1);
    expect(index.perFacing[0]?.facingId).toBe(FACING);
    expect(index.perFacing[0]?.retailerId).toBe(ACME);
  });

  it('returns a null index when no facing contributed measured time', () => {
    const index = computeAvailabilityIndex(ACME, [timeline('unknown', [])], day);

    expect(index.index).toBeNull();
  });

  it('returns a null index for an empty facing set', () => {
    const index = computeAvailabilityIndex(ACME, [], day);

    expect(index.index).toBeNull();
    expect(index.facingCount).toBe(0);
  });

  it('refuses to pool facings from another retailer', () => {
    const foreign: FacingTimeline = { ...timeline('in_stock', []), retailerId: RIVAL };

    expect(() => computeAvailabilityIndex(ACME, [foreign], day)).toThrow(CrossRetailerAccessError);
  });
});

describe('availability index — computed from a live facing history', () => {
  it('integrates the transitions produced by real signals', () => {
    const opened = facingAt(hour(0), 'in_stock');

    const wentEmpty = recordSignal(
      opened,
      arpalusDetection({ observedAt: hour(9), voidRatio: confidence(0.95), detectedFacings: 0 }),
      { nextEventId },
    );
    const restocked = recordSignal(
      wentEmpty.facing,
      shopperScan({ observedAt: hour(15), outcome: 'found' }),
      { nextEventId },
    );

    const result = computeFacingAvailability(timelineFor(restocked.facing, day), day);

    // In stock 00:00-09:00 and 15:00-24:00 => 18h of 24h measured.
    expect(result.inStockMillis).toBe(HOURS(18));
    expect(result.outOfStockMillis).toBe(HOURS(6));
    expect(result.index).toBe(0.75);
  });
});
