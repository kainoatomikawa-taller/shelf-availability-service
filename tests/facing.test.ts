import { describe, expect, it } from 'vitest';
import {
  CrossRetailerAccessError,
  SIGNAL_SOURCES,
  confidence,
  currentState,
  interpretSignal,
  observedSourceCount,
  recordSignal,
  type Facing,
  type Signal,
} from '../src/index.js';
import {
  RIVAL,
  arpalusDetection,
  caperFrame,
  carrotTagLabel,
  facingAt,
  hour,
  nextEventId,
  planogramRecord,
  posMovement,
  shopperScan,
} from './support/fixtures.js';

const apply = (facing: Facing, signal: Signal) => recordSignal(facing, signal, { nextEventId });

describe('facing — unifying the six signal sources', () => {
  it('starts with a slot for every source and none of them filled', () => {
    const facing = facingAt(hour(0));

    expect(Object.keys(facing.signals).sort()).toEqual([...SIGNAL_SOURCES].sort());
    expect(observedSourceCount(facing)).toBe(0);
  });

  it('holds the latest observation from all six sources on one addressable object', () => {
    const signals: readonly Signal[] = [
      shopperScan({ observedAt: hour(1) }),
      arpalusDetection({ observedAt: hour(2) }),
      caperFrame({ observedAt: hour(3) }),
      planogramRecord({ observedAt: hour(4) }),
      carrotTagLabel({ observedAt: hour(5) }),
      posMovement({ observedAt: hour(6) }),
    ];

    const facing = signals.reduce<Facing>((acc, signal) => apply(acc, signal).facing, facingAt(hour(0)));

    expect(observedSourceCount(facing)).toBe(SIGNAL_SOURCES.length);
    for (const source of SIGNAL_SOURCES) {
      expect(facing.signals[source]?.source).toBe(source);
    }
  });

  it('keeps the freshest signal per source and discards an older redelivery', () => {
    const facing = facingAt(hour(0));
    const withNew = apply(facing, caperFrame({ observedAt: hour(9) })).facing;
    const withStale = apply(withNew, caperFrame({ observedAt: hour(4) })).facing;

    expect(withStale.signals.caper_frame?.observedAt).toBe(hour(9));
  });

  it('refuses a signal from another retailer', () => {
    const facing = facingAt(hour(0));

    expect(() => apply(facing, shopperScan({ observedAt: hour(1), retailerId: RIVAL }))).toThrow(
      CrossRetailerAccessError,
    );
  });
});

describe('facing — state transitions', () => {
  it('records a transition when a shopper cannot find the product', () => {
    const facing = facingAt(hour(0), 'in_stock');
    const result = apply(facing, shopperScan({ observedAt: hour(9), outcome: 'not_found' }));

    expect(result.outcome).toBe('transitioned');
    if (result.outcome !== 'transitioned') return;
    expect(result.event.from).toBe('in_stock');
    expect(result.event.to).toBe('out_of_stock');
    expect(result.event.cause.source).toBe('shopper_scan');
    expect(result.facing.state).toBe('out_of_stock');
    expect(result.facing.stateSince).toBe(hour(9));
  });

  it('treats a substitution as out-of-stock evidence', () => {
    const facing = facingAt(hour(0), 'in_stock');
    const result = apply(facing, shopperScan({ observedAt: hour(9), outcome: 'substituted' }));

    expect(result.outcome).toBe('transitioned');
  });

  it('does not emit an event when a second source agrees with the current state', () => {
    const facing = facingAt(hour(0), 'in_stock');
    const result = apply(facing, caperFrame({ observedAt: hour(2), productVisible: true }));

    expect(result.outcome).toBe('reaffirmed');
    expect(result.facing.history.events).toHaveLength(0);
    // Reaffirmation is still recorded as evidence in the snapshot.
    expect(result.facing.signals.caper_frame).not.toBeNull();
  });

  it('ignores an observation predating the current state rather than rewriting history', () => {
    const facing = facingAt(hour(0), 'in_stock');
    const emptied = apply(facing, arpalusDetection({
      observedAt: hour(10),
      voidRatio: confidence(0.9),
      detectedFacings: 0,
    })).facing;

    const late = apply(emptied, shopperScan({ observedAt: hour(6), outcome: 'found' }));

    expect(late.outcome).toBe('stale_ignored');
    expect(late.facing.state).toBe('out_of_stock');
    expect(late.facing.history.events).toHaveLength(1);
  });

  it('does not let a planogram record or a label state move the stock timeline', () => {
    const facing = facingAt(hour(0), 'in_stock');

    const plano = apply(facing, planogramRecord({ observedAt: hour(3) }));
    const label = apply(plano.facing, carrotTagLabel({ observedAt: hour(4), labelState: 'price_mismatch' }));

    expect(plano.outcome).toBe('no_stock_evidence');
    expect(label.outcome).toBe('no_stock_evidence');
    expect(label.facing.history.events).toHaveLength(0);
  });

  it('parks a delisted facing in unknown so it stops accruing out-of-stock time', () => {
    const facing = facingAt(hour(0), 'out_of_stock');
    const result = apply(
      facing,
      planogramRecord({ observedAt: hour(3), assortmentStatus: 'discontinued' }),
    );

    expect(result.outcome).toBe('transitioned');
    expect(result.facing.state).toBe('unknown');
  });

  it('builds a time-ordered history across several sources', () => {
    let facing = facingAt(hour(0), 'in_stock');
    facing = apply(facing, arpalusDetection({
      observedAt: hour(7),
      voidRatio: confidence(0.95),
      detectedFacings: 0,
    })).facing;
    facing = apply(facing, shopperScan({ observedAt: hour(11), outcome: 'found' })).facing;
    facing = apply(facing, caperFrame({
      observedAt: hour(19),
      productVisible: false,
      gapWidthCm: 30,
    })).facing;

    expect(facing.history.events.map((e) => [e.at, e.to])).toEqual([
      [hour(7), 'out_of_stock'],
      [hour(11), 'in_stock'],
      [hour(19), 'out_of_stock'],
    ]);
    expect(facing.history.events.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(currentState(facing.history)).toBe('out_of_stock');
  });
});

describe('facing — signal interpretation thresholds', () => {
  it('ignores low-confidence vision rather than flapping the shelf state', () => {
    const evidence = interpretSignal(
      arpalusDetection({ observedAt: hour(3), confidence: confidence(0.2), voidRatio: confidence(0.99) }),
    );

    expect(evidence.kind).toBe('no_stock_evidence');
  });

  it('will not call a void from a narrow gap behind an occluded product', () => {
    const evidence = interpretSignal(
      caperFrame({ observedAt: hour(3), productVisible: false, gapWidthCm: 4 }),
    );

    expect(evidence.kind).toBe('no_stock_evidence');
  });

  it('reads a live forecast with no sell-through as phantom inventory', () => {
    const evidence = interpretSignal(
      posMovement({ observedAt: hour(3), unitsSold: 0, expectedUnitsSold: 20 }),
    );

    expect(evidence.kind === 'observation' && evidence.state).toBe('out_of_stock');
  });

  it('will not infer stock from a forecast too small to mean anything', () => {
    const evidence = interpretSignal(
      posMovement({ observedAt: hour(3), unitsSold: 0, expectedUnitsSold: 1 }),
    );

    expect(evidence.kind).toBe('no_stock_evidence');
  });
});
