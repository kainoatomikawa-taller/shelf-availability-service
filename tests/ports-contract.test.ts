import { describe, expect, it } from 'vitest';
import {
  AUDIT_EXPORT_SCHEMA_CONTRACT,
  CURRENT_AUDIT_EXPORT_SCHEMA_VERSION,
  CURRENT_DETECTION_SCHEMA_VERSION,
  DETECTION_SCHEMA_CONTRACT,
  DETECTION_SOURCES,
  ESL_EXPRESSION_MODES,
  SIGNAL_SOURCES,
  STANDARD_DEGRADATION_LADDER,
  WIRE_ENCODING,
  computeFacingAvailability,
  confidence,
  eventId,
  millis,
  signalId,
  timeWindow,
  type AuditedTransition,
  type DetectionEvent,
  type DetectionSource,
  type EslExpressionMode,
  type EslFleetCapabilities,
  type ExpressTaskCommand,
  type FacingStateAuditRecord,
  type FacingStateEvent,
  type FacingTimeline,
  type SchemaContract,
} from '../src/index.js';
import { ACME, FACING, PRODUCT, STORE, TASK, hour } from './support/fixtures.js';

describe('detection ingestion contract', () => {
  it('covers the five shelf-observing producers', () => {
    expect(DETECTION_SOURCES).toHaveLength(5);
    expect([...DETECTION_SOURCES].sort()).toEqual(
      ['arpalus_detection', 'caper_frame', 'carrot_tag_label', 'pos_movement', 'shopper_scan'].sort(),
    );
  });

  it('excludes planogram records, which are reference data rather than detections', () => {
    expect(DETECTION_SOURCES).not.toContain('planogram_record');

    const detectionSources = new Set<string>(DETECTION_SOURCES);
    const missing = SIGNAL_SOURCES.filter(
      (source) => source !== 'planogram_record' && !detectionSources.has(source),
    );

    // Every other domain signal source must have a way in through this port.
    expect(missing).toEqual([]);
  });

  it('accepts an event for every declared source', () => {
    const envelope = {
      schemaVersion: CURRENT_DETECTION_SCHEMA_VERSION,
      eventId: 'producer-evt-1',
      idempotencyKey: 'producer-evt-1',
      retailerId: ACME,
      storeId: STORE,
      producer: { system: 'caper_frame', instanceId: 'cart-17', softwareVersion: '4.2.0' },
      occurredAt: hour(9),
      producedAt: hour(9),
      correlationId: null,
    } as const;

    const events: { readonly [S in DetectionSource]: DetectionEvent } = {
      shopper_scan: {
        envelope: { ...envelope, producer: { ...envelope.producer, system: 'shopper_scan' } },
        source: 'shopper_scan',
        observations: [],
      },
      arpalus_detection: {
        envelope: { ...envelope, producer: { ...envelope.producer, system: 'arpalus_detection' } },
        source: 'arpalus_detection',
        observations: [],
      },
      caper_frame: { envelope, source: 'caper_frame', observations: [] },
      carrot_tag_label: {
        envelope: { ...envelope, producer: { ...envelope.producer, system: 'carrot_tag_label' } },
        source: 'carrot_tag_label',
        observations: [],
      },
      pos_movement: {
        envelope: { ...envelope, producer: { ...envelope.producer, system: 'pos_movement' } },
        source: 'pos_movement',
        observations: [],
      },
    };

    for (const source of DETECTION_SOURCES) {
      expect(events[source].source).toBe(source);
      expect(events[source].envelope.retailerId).toBe(ACME);
    }
  });

  it('publishes a coherent versioning contract', () => {
    const contracts: readonly SchemaContract[] = [
      DETECTION_SCHEMA_CONTRACT,
      AUDIT_EXPORT_SCHEMA_CONTRACT,
    ];

    for (const contract of contracts) {
      expect(contract.supported).toContain(contract.current);
      // Forward compatible: producers may add fields without a coordinated release.
      expect(contract.unknownFields).toBe('ignore');
      expect(contract.encoding).toEqual(WIRE_ENCODING);
      for (const sunset of contract.sunsets) {
        expect(contract.supported).toContain(sunset.version);
      }
    }

    expect(DETECTION_SCHEMA_CONTRACT.current).toBe(CURRENT_DETECTION_SCHEMA_VERSION);
    expect(AUDIT_EXPORT_SCHEMA_CONTRACT.current).toBe(CURRENT_AUDIT_EXPORT_SCHEMA_VERSION);
  });
});

describe('ESL actuation contract', () => {
  it('declares a degradation ladder over every expression mode', () => {
    expect([...STANDARD_DEGRADATION_LADDER].sort()).toEqual([...ESL_EXPRESSION_MODES].sort());
    expect(new Set(STANDARD_DEGRADATION_LADDER).size).toBe(STANDARD_DEGRADATION_LADDER.length);
  });

  it('ends the ladder at "none", so degradation always terminates', () => {
    expect(STANDARD_DEGRADATION_LADDER.at(-1)).toBe('none');
  });

  it('lets a caller resolve a supported mode against a mono fleet', () => {
    // A mono fleet cannot render lane colour; the ladder must still land somewhere.
    const monoFleet: EslFleetCapabilities = {
      retailerId: ACME,
      storeId: STORE,
      fleetVendor: 'carrot-tags',
      supportedModes: ['mono_indicator', 'none'],
      renderableColours: [],
      supportedFlashPatterns: [],
      maxBadgeCharacters: null,
      degradationLadder: [...STANDARD_DEGRADATION_LADDER],
      minCommandIntervalMillis: millis(5_000),
      batchLimit: 200,
      expressionLeaseMillis: millis(30 * 60 * 1000),
      observedAt: hour(8),
    };

    const command: ExpressTaskCommand = {
      retailerId: ACME,
      storeId: STORE,
      taskId: TASK,
      facingId: FACING,
      tagId: null,
      taskType: 'restock_out_of_stock',
      lane: 'red',
      priority: 'high',
      flashPattern: 'fast',
      badge: null,
      modePreference: [...STANDARD_DEGRADATION_LADDER],
      expiresAt: hour(12),
      requestedAt: hour(9),
    };

    const supported = new Set<EslExpressionMode>(monoFleet.supportedModes);
    const resolved = command.modePreference.find((mode) => supported.has(mode));

    expect(resolved).toBe('mono_indicator');
    expect(resolved).not.toBe(command.modePreference[0]);
  });
});

describe('audit export contract', () => {
  /**
   * The guarantee the export exists to keep: an auditor holding a record can
   * recompute the index and land on the number the service reported.
   */
  const period = timeWindow(hour(0), hour(24));

  const transition = (
    sequence: number,
    at: ReturnType<typeof hour>,
    from: FacingStateAuditRecord['stateAtPeriodStart'],
    to: FacingStateAuditRecord['stateAtPeriodStart'],
  ): AuditedTransition => ({
    eventId: eventId(`evt-${sequence}`),
    sequence,
    at,
    from,
    to,
    source: 'arpalus_detection',
    signalId: signalId(`sig-${sequence}`),
    confidence: confidence(0.92),
    producerInstanceId: 'camera-3',
    producerSoftwareVersion: '7.1.2',
  });

  const record: FacingStateAuditRecord = {
    retailerId: ACME,
    storeId: STORE,
    facingId: FACING,
    productId: PRODUCT,
    location: { aisle: 'A12', bay: 'B3', shelf: 2, position: 1 },
    period,
    stateAtPeriodStart: 'in_stock',
    transitions: [
      transition(1, hour(9), 'in_stock', 'out_of_stock'),
      transition(2, hour(15), 'out_of_stock', 'in_stock'),
    ],
    reportedInStockMillis: millis(18 * 60 * 60 * 1000),
    reportedOutOfStockMillis: millis(6 * 60 * 60 * 1000),
    reportedUnknownMillis: millis(0),
    reportedMeasuredMillis: millis(24 * 60 * 60 * 1000),
    reportedIndex: 0.75,
  };

  /** The reconstruction an auditor performs, using only what the record carries. */
  const reconstruct = (source: FacingStateAuditRecord): FacingTimeline => ({
    retailerId: source.retailerId,
    storeId: source.storeId,
    facingId: source.facingId,
    stateAtWindowStart: source.stateAtPeriodStart,
    events: source.transitions.map<FacingStateEvent>((entry) => ({
      eventId: entry.eventId,
      retailerId: source.retailerId,
      storeId: source.storeId,
      facingId: source.facingId,
      sequence: entry.sequence,
      at: entry.at,
      from: entry.from,
      to: entry.to,
      cause: {
        source: entry.source,
        signalId: entry.signalId,
        confidence: entry.confidence,
      },
    })),
  });

  it('carries enough to recompute the reported index', () => {
    const recomputed = computeFacingAvailability(reconstruct(record), record.period);

    expect(recomputed.index).toBe(record.reportedIndex);
    expect(recomputed.inStockMillis).toBe(record.reportedInStockMillis);
    expect(recomputed.outOfStockMillis).toBe(record.reportedOutOfStockMillis);
    expect(recomputed.unknownMillis).toBe(record.reportedUnknownMillis);
    expect(recomputed.measuredMillis).toBe(record.reportedMeasuredMillis);
  });

  it('needs the carry-in state: dropping it changes the answer', () => {
    // Without stateAtPeriodStart an auditor would have to guess, and guessing
    // "unknown" loses the nine hours before the first transition.
    const guessed = computeFacingAvailability(
      { ...reconstruct(record), stateAtWindowStart: 'unknown' },
      record.period,
    );

    expect(guessed.index).not.toBe(record.reportedIndex);
  });

  it('keeps transitions time-ordered and sequenced', () => {
    const ats = record.transitions.map((entry) => entry.at);
    const sequences = record.transitions.map((entry) => entry.sequence);

    expect([...ats].sort((a, b) => a - b)).toEqual(ats);
    expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);
  });
});
