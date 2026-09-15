import {
  carrotTagId,
  categoryId,
  confidence,
  createFacing,
  departmentId,
  employeeId,
  eventId,
  facingId,
  gapId,
  instant,
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
  type CategoryId,
  type ClassifiedFacing,
  type DepartmentId,
  type DetectedGap,
  type DetectionEvent,
  type DetectionEventEnvelope,
  type DetectionObservationOf,
  type DetectionSource,
  type FacingId,
  type FacingPass,
  type GapDetail,
  type MerchandisingClassification,
  type SignalSource,
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

// ---------------------------------------------------------------------------
// Merchandising hierarchy, gaps and coverage
// ---------------------------------------------------------------------------

export const FRESH: DepartmentId = departmentId('fresh');
export const GROCERY: DepartmentId = departmentId('grocery');

export const DAIRY: CategoryId = categoryId('dairy');
export const CEREAL: CategoryId = categoryId('cereal');
export const SEASONAL: CategoryId = categoryId('seasonal-decor');

export const inCategory = (
  department: DepartmentId,
  category: CategoryId,
): MerchandisingClassification => ({ departmentId: department, categoryId: category });

export const DAIRY_FRESH = inCategory(FRESH, DAIRY);
export const CEREAL_GROCERY = inCategory(GROCERY, CEREAL);

export const facingWith = (
  id: string,
  opened: Instant,
  overrides: Partial<Parameters<typeof createFacing>[0]> = {},
): Facing =>
  createFacing({
    retailerId: ACME,
    storeId: STORE,
    facingId: facingId(id),
    productId: PRODUCT,
    location: { aisle: 'A12', bay: 'B3', shelf: 2, position: 1 },
    capacityUnits: 12,
    createdAt: opened,
    ...overrides,
  });

export const classified = (
  id: string,
  classification: MerchandisingClassification,
): ClassifiedFacing => ({
  retailerId: ACME,
  storeId: STORE,
  facingId: facingId(id),
  classification,
});

/** `count` facings in one category, named `<prefix>-0`, `<prefix>-1`, ... */
export const classifiedFacings = (
  prefix: string,
  count: number,
  classification: MerchandisingClassification,
): readonly ClassifiedFacing[] =>
  Array.from({ length: count }, (_, index) => classified(`${prefix}-${index}`, classification));

export const facingPass = (
  id: string,
  when: Instant,
  source: SignalSource = 'caper_frame',
): FacingPass => ({
  retailerId: ACME,
  storeId: STORE,
  facingId: facingId(id),
  at: when,
  source,
});

/** `count` evenly-spaced passes over one facing, starting at `from`. */
export const passesOver = (
  id: string,
  count: number,
  from: Instant,
  spacing = 60 * 60 * 1000,
): readonly FacingPass[] =>
  Array.from({ length: count }, (_, index) => facingPass(id, instant(from + index * spacing)));

export const outOfStockSince = (since: Instant): GapDetail => ({
  kind: 'availability_gap',
  since,
  source: 'arpalus_detection',
});

export const gap = (
  id: string,
  facing: string,
  classification: MerchandisingClassification,
  detectedAt: Instant,
  detail: GapDetail = outOfStockSince(detectedAt),
): DetectedGap => ({
  gapId: gapId(id),
  retailerId: ACME,
  storeId: STORE,
  facingId: facingId(facing),
  productId: PRODUCT,
  classification,
  detectedAt,
  detail,
});

// ---------------------------------------------------------------------------
// Detection events (the wire side of ingestion)
// ---------------------------------------------------------------------------

export const envelope = (
  source: DetectionSource,
  occurredAt: Instant,
  overrides: Partial<DetectionEventEnvelope> = {},
): DetectionEventEnvelope => ({
  schemaVersion: '1.0',
  eventId: `evt-${source}-${occurredAt}`,
  idempotencyKey: `key-${source}-${occurredAt}`,
  retailerId: ACME,
  storeId: STORE,
  producer: { system: source, instanceId: 'cart-3', softwareVersion: '4.2.1' },
  occurredAt,
  producedAt: occurredAt,
  correlationId: null,
  ...overrides,
});

export const detectionEvent = <S extends DetectionSource>(
  source: S,
  occurredAt: Instant,
  observations: readonly DetectionObservationOf<S>[],
  envelopeOverrides: Partial<DetectionEventEnvelope> = {},
): DetectionEvent =>
  ({
    envelope: envelope(source, occurredAt, envelopeOverrides),
    source,
    observations,
  }) as DetectionEvent;

export const arpalusObservation = (
  facing: string,
  overrides: Partial<DetectionObservationOf<'arpalus_detection'>> = {},
): DetectionObservationOf<'arpalus_detection'> => ({
  facingId: facingId(facing),
  confidence: confidence(0.9),
  productId: PRODUCT,
  detectedFacings: 3,
  expectedFacings: 3,
  voidRatio: confidence(0),
  ...overrides,
});

export const scanObservation = (
  facing: string,
  outcome: 'found' | 'not_found' | 'substituted',
): DetectionObservationOf<'shopper_scan'> => ({
  facingId: facingId(facing),
  confidence: confidence(0.95),
  shopperId: shopperId('shopper-9'),
  productId: PRODUCT,
  outcome,
});

export const facingIdOf = (id: string): FacingId => facingId(id);

export const posObservation = (
  facing: string,
  overrides: Partial<DetectionObservationOf<'pos_movement'>> = {},
): DetectionObservationOf<'pos_movement'> => ({
  facingId: facingId(facing),
  confidence: confidence(1),
  productId: PRODUCT,
  unitsSold: 10,
  expectedUnitsSold: 10,
  windowMillis: millis(60 * 60 * 1000),
  ...overrides,
});
