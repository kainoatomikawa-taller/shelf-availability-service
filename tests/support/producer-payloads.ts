/**
 * Payloads in each producer's own dialect.
 *
 * Written out as the five vendors actually spell things — `void_pct`,
 * `gapWidthMm`, `storeNumber`, `REPLACED`, a price as `"5.99"` — rather than
 * built from the domain types. That is the point of the tests they feed: if these
 * were derived from our own model they could not catch the adapter agreeing with
 * itself, which is the only failure mode that matters at this boundary.
 */

export const ACME_CODE = 'acme-grocery';
export const RIVAL_CODE = 'rival-mart';
export const STORE_CODE = 'acme-0042';
export const FACING_REF = 'acme-0042:a12:b3:s2:p1';
export const SKU = 'sku-oat-milk-64oz';

const CAPTURED_ISO = '2026-03-02T09:00:00.000Z';

type Payload = Record<string, unknown>;

/** An Arpalus shelf-vision scan. Void space is a 0–100 percentage. */
export const arpalusScan = (
  segments: readonly Payload[],
  overrides: Payload = {},
): Payload => ({
  schema: 'arpalus.shelf-scan.v2',
  scan_id: 'scan-8821',
  site: { retailer: ACME_CODE, store: STORE_CODE },
  sensor: { camera_id: 'cam-7', agent_version: '2.11.0' },
  captured_at: CAPTURED_ISO,
  published_at: '2026-03-02T09:00:04.000Z',
  pass_id: 'pass-99',
  segments,
  ...overrides,
});

export const arpalusSegment = (overrides: Payload = {}): Payload => ({
  facing_ref: FACING_REF,
  sku: SKU,
  score: 0.92,
  facings_detected: 2,
  facings_expected: 3,
  void_pct: 33.5,
  ...overrides,
});

/** A Caper smart-cart frame. Capture time is epoch millis; gaps are millimetres. */
export const caperFrame = (
  detections: readonly Payload[],
  overrides: Payload = {},
): Payload => ({
  eventType: 'caper.frame',
  version: 1,
  frameId: 'frm-4410',
  tenant: ACME_CODE,
  storeNumber: STORE_CODE,
  cart: { cartId: 'cart-3', firmware: '4.2.1' },
  capturedAtEpochMs: Date.parse(CAPTURED_ISO),
  tripId: 'trip-11',
  detections,
  ...overrides,
});

export const caperDetection = (overrides: Payload = {}): Payload => ({
  facing: FACING_REF,
  upc: SKU,
  confidence: 0.85,
  productVisible: true,
  gapWidthMm: 0,
  ...overrides,
});

/** A Carrot Tags gateway sweep. Prices are decimal strings; lamps are colour codes. */
export const carrotSweep = (labels: readonly Payload[], overrides: Payload = {}): Payload => ({
  msg_type: 'label_state',
  proto: 'carrot/3',
  gateway: { id: 'gw-2', fw: '9.0.3' },
  retailer_code: ACME_CODE,
  store_code: STORE_CODE,
  observed: CAPTURED_ISO,
  sweep_ref: 'sweep-5',
  labels,
  ...overrides,
});

export const carrotLabel = (overrides: Payload = {}): Payload => ({
  tag: 'tag-551',
  facing: FACING_REF,
  status: 'OK',
  price: '5.99',
  lamp: 'OFF',
  ...overrides,
});

/** A POS aggregation batch. The window is two timestamps, not a duration. */
export const posBatch = (lines: readonly Payload[], overrides: Payload = {}): Payload => ({
  feed: 'pos.movement',
  feedVersion: '2024-06',
  retailer: ACME_CODE,
  store: STORE_CODE,
  job: { name: 'pos-agg-hourly', build: '1.9.0' },
  batchId: 'posb-31',
  window: { start: '2026-03-02T08:00:00.000Z', end: CAPTURED_ISO },
  emittedAt: '2026-03-02T09:01:00.000Z',
  lines,
  ...overrides,
});

export const posLine = (overrides: Payload = {}): Payload => ({
  facingId: FACING_REF,
  gtin: SKU,
  unitsSold: 10,
  forecastUnits: 9.4,
  ...overrides,
});

/** A shopper app item scan. One facing per event, and `REPLACED` means substituted. */
export const shopperItemScan = (overrides: Payload = {}): Payload => ({
  type: 'pick.item_scan',
  v: 3,
  scan_id: 'scan-abc',
  retailer_id: ACME_CODE,
  store_id: STORE_CODE,
  order_id: 'ord-77',
  shopper: { id: 'shopper-9', app_build: 'ios-2026.9.1' },
  scanned_at: CAPTURED_ISO,
  item: {
    facing_id: FACING_REF,
    product_id: SKU,
    result: 'FOUND',
    confidence: 0.95,
  },
  ...overrides,
});
