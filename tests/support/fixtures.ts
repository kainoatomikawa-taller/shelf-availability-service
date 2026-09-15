import {
  carrotTagId,
  confidence,
  createFacing,
  employeeId,
  eventId,
  facingId,
  instantFromISO,
  passId,
  productId,
  retailerId,
  shopperId,
  signalId,
  storeId,
  taskId,
  type ArpalusDetectionSignal,
  type CaperFrameSignal,
  type CarrotTagLabelSignal,
  type Facing,
  type Instant,
  type PlanogramRecordSignal,
  type PosMovementSignal,
  type ShopperScanSignal,
  type VerificationPass,
  millis,
} from '../../src/index.js';

export const ACME = retailerId('acme-grocery');
export const RIVAL = retailerId('rival-mart');
export const STORE = storeId('acme-0042');
export const FACING = facingId('acme-0042:a12:b3:s2:p1');
export const PRODUCT = productId('sku-oat-milk-64oz');
export const TASK = taskId('task-1');
export const EMPLOYEE = employeeId('emp-77');

export const at = (iso: string): Instant => instantFromISO(iso);

/** Midnight-anchored helper so tests read as "hour 3 of the window". */
export const hour = (h: number, minute = 0): Instant =>
  instantFromISO(
    `2026-03-02T${String(h).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`,
  );

export const facingAt = (opened: Instant, initialState: Facing['state'] = 'unknown'): Facing =>
  createFacing({
    retailerId: ACME,
    storeId: STORE,
    facingId: FACING,
    productId: PRODUCT,
    location: { aisle: 'A12', bay: 'B3', shelf: 2, position: 1 },
    capacityUnits: 12,
    createdAt: opened,
    initialState,
  });

let eventCounter = 0;
export const nextEventId = () => eventId(`evt-${++eventCounter}`);

export const shopperScan = (
  overrides: Partial<ShopperScanSignal> & { observedAt: Instant },
): ShopperScanSignal => ({
  signalId: signalId(`scan-${overrides.observedAt}`),
  retailerId: ACME,
  storeId: STORE,
  facingId: FACING,
  source: 'shopper_scan',
  receivedAt: overrides.observedAt,
  confidence: confidence(0.95),
  shopperId: shopperId('shopper-9'),
  productId: PRODUCT,
  outcome: 'found',
  ...overrides,
});

export const arpalusDetection = (
  overrides: Partial<ArpalusDetectionSignal> & { observedAt: Instant },
): ArpalusDetectionSignal => ({
  signalId: signalId(`arpalus-${overrides.observedAt}`),
  retailerId: ACME,
  storeId: STORE,
  facingId: FACING,
  source: 'arpalus_detection',
  receivedAt: overrides.observedAt,
  confidence: confidence(0.9),
  productId: PRODUCT,
  detectedFacings: 3,
  expectedFacings: 3,
  voidRatio: confidence(0),
  ...overrides,
});

export const caperFrame = (
  overrides: Partial<CaperFrameSignal> & { observedAt: Instant },
): CaperFrameSignal => ({
  signalId: signalId(`caper-${overrides.observedAt}`),
  retailerId: ACME,
  storeId: STORE,
  facingId: FACING,
  source: 'caper_frame',
  receivedAt: overrides.observedAt,
  confidence: confidence(0.85),
  productId: PRODUCT,
  productVisible: true,
  gapWidthCm: 0,
  ...overrides,
});

export const planogramRecord = (
  overrides: Partial<PlanogramRecordSignal> & { observedAt: Instant },
): PlanogramRecordSignal => ({
  signalId: signalId(`plano-${overrides.observedAt}`),
  retailerId: ACME,
  storeId: STORE,
  facingId: FACING,
  source: 'planogram_record',
  receivedAt: overrides.observedAt,
  confidence: confidence(1),
  planogramVersion: '2026.09',
  expectedProductId: PRODUCT,
  expectedFacings: 3,
  assortmentStatus: 'active',
  ...overrides,
});

export const carrotTagLabel = (
  overrides: Partial<CarrotTagLabelSignal> & { observedAt: Instant },
): CarrotTagLabelSignal => ({
  signalId: signalId(`tag-${overrides.observedAt}`),
  retailerId: ACME,
  storeId: STORE,
  facingId: FACING,
  source: 'carrot_tag_label',
  receivedAt: overrides.observedAt,
  confidence: confidence(1),
  tagId: carrotTagId('tag-551'),
  labelState: 'nominal',
  displayedPriceCents: 599,
  litLane: null,
  ...overrides,
});

export const posMovement = (
  overrides: Partial<PosMovementSignal> & { observedAt: Instant },
): PosMovementSignal => ({
  signalId: signalId(`pos-${overrides.observedAt}`),
  retailerId: ACME,
  storeId: STORE,
  facingId: FACING,
  source: 'pos_movement',
  receivedAt: overrides.observedAt,
  confidence: confidence(1),
  productId: PRODUCT,
  unitsSold: 10,
  expectedUnitsSold: 10,
  windowMillis: millis(60 * 60 * 1000),
  ...overrides,
});

export const pass = (
  id: string,
  when: Instant,
  outcome: 'clean' | 'dirty' = 'clean',
  overrides: Partial<VerificationPass> = {},
): VerificationPass => ({
  passId: passId(id),
  retailerId: ACME,
  storeId: STORE,
  facingId: FACING,
  taskId: TASK,
  at: when,
  outcome,
  source: 'caper_frame',
  ...overrides,
});
