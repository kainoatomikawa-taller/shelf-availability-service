import { toISO, type DetectionSource, type Instant } from '../../src/index.js';

/**
 * Producer payloads in each vendor's own dialect, parameterised by who and where.
 *
 * `producer-payloads.ts` next door is the hand-written specimen of each dialect —
 * one retailer, one store, one facing — and it stays that way, because a fixture
 * you can read against the vendor's API documentation is what catches an adapter
 * agreeing with itself. This module is the other half: the *same* dialects with
 * the retailer, store, facing and instant lifted out, so an integration test can
 * publish a real Arpalus scan for whichever tenant it is exercising and a
 * partition test can publish one tenant's scan onto another's topic.
 *
 * The claim a payload makes about the shelf is a parameter too, and it is spelled
 * in each producer's own terms — Arpalus argues from void percentage, Caper from
 * a gap in millimetres, POS from sell-through against forecast, a shopper from a
 * pick outcome. Nothing here converts anything: producing the *unconverted* value
 * is the entire point, since every one of these is a plausible number if the
 * adapter forgets to convert it.
 */

export type Payload = Record<string, unknown>;

/**
 * What a payload claims about the shelf, in the only two states a detection can
 * evidence. `carrot_tag_label` honours neither, by design — a label sweep reports
 * a tag, never stock — and its builder says so rather than faking a claim.
 */
export type StockClaim = 'in_stock' | 'out_of_stock';

/** Who and where a payload is about, in the producer's own spelling. */
export interface WireContext {
  /** The retailer as its producers name it — the same string the topic is keyed by. */
  readonly retailerCode: string;
  readonly storeCode: string;
  /** Facings covered. Array sources carry all of them; shopper scans, the first. */
  readonly facingRefs: readonly string[];
  readonly sku: string;
  readonly observedAt: Instant;
  /** The producer's own id for this event. Drives the idempotency key downstream. */
  readonly eventRef: string;
}

const firstFacing = (context: WireContext): string => {
  const facing = context.facingRefs[0];
  if (facing === undefined) {
    throw new Error('a producer payload needs at least one facing to be about');
  }
  return facing;
};

/**
 * Arpalus: void space as a 0–100 percentage, store nested under `site`.
 *
 * An empty facing is stated as no facings detected *and* a void past 90%, which
 * is what a camera actually reports for a bare shelf; the in-stock case is a full
 * plan with no void at all.
 */
export const arpalusWire = (context: WireContext, claim: StockClaim): Payload => ({
  schema: 'arpalus.shelf-scan.v2',
  scan_id: context.eventRef,
  site: { retailer: context.retailerCode, store: context.storeCode },
  sensor: { camera_id: `cam-${context.storeCode}`, agent_version: '2.11.0' },
  captured_at: toISO(context.observedAt),
  published_at: toISO(context.observedAt),
  pass_id: `pass-${context.eventRef}`,
  segments: context.facingRefs.map((facing) => ({
    facing_ref: facing,
    sku: context.sku,
    score: 0.92,
    facings_detected: claim === 'in_stock' ? 3 : 0,
    facings_expected: 3,
    void_pct: claim === 'in_stock' ? 0 : 91.5,
  })),
});

/** Caper: epoch-millis capture time, gap widths in millimetres. */
export const caperWire = (context: WireContext, claim: StockClaim): Payload => ({
  eventType: 'caper.frame',
  version: 1,
  frameId: context.eventRef,
  tenant: context.retailerCode,
  storeNumber: context.storeCode,
  cart: { cartId: `cart-${context.storeCode}`, firmware: '4.2.1' },
  capturedAtEpochMs: context.observedAt as number,
  tripId: `trip-${context.eventRef}`,
  detections: context.facingRefs.map((facing) => ({
    facing,
    upc: context.sku,
    confidence: 0.85,
    productVisible: claim === 'in_stock',
    // 180 mm is 18 cm — past the 12 cm void threshold once converted, and a void
    // call on nothing at all if it is not.
    gapWidthMm: claim === 'in_stock' ? 0 : 180,
  })),
});

/**
 * Carrot Tags: vendor status codes, decimal price strings, lamp colours.
 *
 * Takes no `StockClaim`. The gateway is reporting what a label is displaying, and
 * a label knows nothing about what is behind it.
 */
export const carrotWire = (
  context: WireContext,
  label: { readonly status: string; readonly price: string; readonly lamp: string } = {
    status: 'OK',
    price: '5.99',
    lamp: 'OFF',
  },
): Payload => ({
  msg_type: 'label_state',
  proto: 'carrot/3',
  gateway: { id: `gw-${context.storeCode}`, fw: '9.0.3' },
  retailer_code: context.retailerCode,
  store_code: context.storeCode,
  observed: toISO(context.observedAt),
  sweep_ref: context.eventRef,
  labels: context.facingRefs.map((facing, index) => ({
    tag: `tag-${index}-${facing}`,
    facing,
    status: label.status,
    price: label.price,
    lamp: label.lamp,
  })),
});

/**
 * POS: a start/end window rather than a duration, and the observation instant is
 * the window's close.
 *
 * The forecast clears the minimum the policy trusts, so the sell-through ratio is
 * what decides the call: nothing sold against a live forecast is phantom
 * inventory, and selling to forecast is a shelf somebody is picking from.
 */
export const posWire = (context: WireContext, claim: StockClaim): Payload => ({
  feed: 'pos.movement',
  feedVersion: '2024-06',
  retailer: context.retailerCode,
  store: context.storeCode,
  job: { name: 'pos-agg-hourly', build: '1.9.0' },
  batchId: context.eventRef,
  window: {
    start: toISO((context.observedAt - 60 * 60 * 1000) as Instant),
    end: toISO(context.observedAt),
  },
  emittedAt: toISO(context.observedAt),
  lines: context.facingRefs.map((facing) => ({
    facingId: facing,
    gtin: context.sku,
    unitsSold: claim === 'in_stock' ? 10 : 0,
    forecastUnits: 9.4,
  })),
});

/** A shopper app item scan: one facing per event, `REPLACED` meaning substituted. */
export const shopperWire = (context: WireContext, claim: StockClaim): Payload => ({
  type: 'pick.item_scan',
  v: 3,
  scan_id: context.eventRef,
  retailer_id: context.retailerCode,
  store_id: context.storeCode,
  order_id: `ord-${context.eventRef}`,
  shopper: { id: `shopper-${context.storeCode}`, app_build: 'ios-2026.9.1' },
  scanned_at: toISO(context.observedAt),
  item: {
    facing_id: firstFacing(context),
    product_id: context.sku,
    result: claim === 'in_stock' ? 'FOUND' : 'NOT_FOUND',
    confidence: 0.95,
  },
});

/**
 * Every source's builder, keyed by source.
 *
 * A mapped type over `DetectionSource` for the same reason the shipped registry
 * is one: a sixth producer is a compile error here until the tests can actually
 * speak its dialect, rather than a source the integration suite silently stops
 * covering.
 */
export const WIRE_BUILDERS: {
  readonly [S in DetectionSource]: (context: WireContext, claim: StockClaim) => Payload;
} = {
  arpalus_detection: arpalusWire,
  caper_frame: caperWire,
  carrot_tag_label: (context) => carrotWire(context),
  pos_movement: posWire,
  shopper_scan: shopperWire,
};

export const wireFor = (
  source: DetectionSource,
  context: WireContext,
  claim: StockClaim,
): Payload => WIRE_BUILDERS[source](context, claim);

/**
 * Which sources can move the stock timeline at all.
 *
 * Four of the five can; a Carrot Tags sweep cannot, and `interpretSignal` returns
 * `no_stock_evidence` for it by design. Stated here so the per-source integration
 * test can assert the *right* outcome for each producer rather than skipping the
 * one that behaves differently.
 */
export const MOVES_STOCK_TIMELINE: { readonly [S in DetectionSource]: boolean } = {
  arpalus_detection: true,
  caper_frame: true,
  carrot_tag_label: false,
  pos_movement: true,
  shopper_scan: true,
};
