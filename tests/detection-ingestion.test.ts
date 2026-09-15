import { describe, expect, it } from 'vitest';
import {
  DETECTION_SCHEMA_CONTRACT,
  DetectionIngestionService,
  confidence,
  currentState,
  eventId,
  normalizeDetectionEvent,
  passesFromDetectionEvent,
  signalId,
  type DetectionEvent,
  type Facing,
  type IngestionOutcome,
  type Instant,
} from '../src/index.js';
import {
  ACME,
  RIVAL,
  arpalusObservation,
  detectionEvent,
  facingIdOf,
  facingWith,
  hour,
  scanObservation,
} from './support/fixtures.js';
import { InMemoryFacingRepository, InMemoryIngestionLedger } from './support/in-memory-ports.js';

const ids = {
  nextSignalId: (envelope: { eventId: string }, source: string, index: number) =>
    signalId(`${envelope.eventId}:${source}:${index}`),
  nextEventId: (facing: Facing) => eventId(`${facing.facingId}:${facing.history.events.length + 1}`),
};

const serviceOver = (
  facings: readonly Facing[],
  now: Instant = hour(12),
): {
  service: DetectionIngestionService;
  facings: InMemoryFacingRepository;
  ledger: InMemoryIngestionLedger;
} => {
  const repository = new InMemoryFacingRepository(facings);
  const ledger = new InMemoryIngestionLedger();
  return {
    service: new DetectionIngestionService({
      facings: repository,
      ledger,
      now: () => now,
      nextSignalId: ids.nextSignalId,
      nextEventId: ids.nextEventId,
    }),
    facings: repository,
    ledger,
  };
};

const accepted = (outcome: IngestionOutcome) => {
  if (outcome.status !== 'accepted') throw new Error(`expected acceptance, got ${outcome.status}`);
  return outcome;
};

const voidRun = (at: Instant, facings: readonly string[], key?: string): DetectionEvent =>
  detectionEvent(
    'arpalus_detection',
    at,
    facings.map((facing) =>
      arpalusObservation(facing, { detectedFacings: 0, voidRatio: confidence(0.95) }),
    ),
    key === undefined ? {} : { idempotencyKey: key },
  );

describe('normalizing detection events into domain signals', () => {
  it('takes the observation time from the envelope, not from each observation', () => {
    // One Arpalus pass covers a whole bay: every facing in it was seen at the
    // same instant, and per-observation timestamps would invite a producer to
    // claim sub-frame precision it does not have.
    const signals = normalizeDetectionEvent(voidRun(hour(3), ['bay-0', 'bay-1', 'bay-2']), {
      nextSignalId: ids.nextSignalId,
      receivedAt: hour(4),
    });

    expect(signals).toHaveLength(3);
    expect(signals.map((signal) => signal.observedAt)).toEqual([hour(3), hour(3), hour(3)]);
    expect(signals.map((signal) => signal.receivedAt)).toEqual([hour(4), hour(4), hour(4)]);
    expect(signals.map((signal) => signal.facingId)).toEqual(['bay-0', 'bay-1', 'bay-2']);
  });

  it('carries each source’s own fields across the boundary', () => {
    const [scan] = normalizeDetectionEvent(
      detectionEvent('shopper_scan', hour(5), [scanObservation('bay-0', 'not_found')]),
      { nextSignalId: ids.nextSignalId, receivedAt: hour(5) },
    );

    expect(scan).toMatchObject({
      source: 'shopper_scan',
      retailerId: ACME,
      outcome: 'not_found',
    });
  });

  it('counts every observation as a pass, whatever it concluded', () => {
    // Revisit density measures how often we could have seen a problem, so a
    // frame that found a full shelf is as much a pass as one that found a void.
    const stocked = detectionEvent('arpalus_detection', hour(2), [
      arpalusObservation('bay-0'),
      arpalusObservation('bay-1'),
    ]);

    expect(passesFromDetectionEvent(stocked)).toEqual([
      { retailerId: ACME, storeId: expect.anything(), facingId: 'bay-0', at: hour(2), source: 'arpalus_detection' },
      { retailerId: ACME, storeId: expect.anything(), facingId: 'bay-1', at: hour(2), source: 'arpalus_detection' },
    ]);
  });
});

describe('ingesting detection events through the port', () => {
  it('folds a signal into the facing and appends the transition it caused', async () => {
    const { service, facings } = serviceOver([
      facingWith('bay-0', hour(0), { initialState: 'in_stock' }),
    ]);

    const outcome = accepted(await service.ingest(voidRun(hour(3), ['bay-0'])));

    expect(outcome.results).toEqual([
      {
        facingId: 'bay-0',
        signalId: expect.stringContaining('arpalus_detection:0'),
        application: 'transitioned',
        resultingState: 'out_of_stock',
        emittedEventId: 'bay-0:1',
      },
    ]);

    const stored = await facings.load(ACME, facingIdOf('bay-0'));
    expect(stored?.state).toBe('out_of_stock');
    expect(stored?.history.events).toHaveLength(1);
    expect(stored?.history.events[0]).toMatchObject({ from: 'in_stock', to: 'out_of_stock', at: hour(3) });
  });

  it('keeps the history a record of transitions, not of observations', async () => {
    const { service, facings } = serviceOver([
      facingWith('bay-0', hour(0), { initialState: 'in_stock' }),
    ]);

    await service.ingest(voidRun(hour(3), ['bay-0'], 'run-1'));
    const second = accepted(await service.ingest(voidRun(hour(5), ['bay-0'], 'run-2')));

    expect(second.results[0]?.application).toBe('reaffirmed');
    expect(second.results[0]?.emittedEventId).toBeNull();
    const stored = await facings.load(ACME, facingIdOf('bay-0'));
    expect(stored?.history.events).toHaveLength(1);
    expect(currentState(stored!.history)).toBe('out_of_stock');
  });

  it('reports one result per observation, in submission order', async () => {
    const { service } = serviceOver([
      facingWith('bay-0', hour(0), { initialState: 'in_stock' }),
      facingWith('bay-1', hour(0), { initialState: 'out_of_stock' }),
      facingWith('bay-2', hour(0), { initialState: 'in_stock' }),
    ]);

    const outcome = accepted(await service.ingest(voidRun(hour(3), ['bay-0', 'bay-1', 'bay-2'])));

    expect(outcome.results.map((result) => result.facingId)).toEqual(['bay-0', 'bay-1', 'bay-2']);
    expect(outcome.results.map((result) => result.application)).toEqual([
      'transitioned',
      'reaffirmed',
      'transitioned',
    ]);
  });

  it('answers a redelivery with the original acceptance rather than ingesting twice', async () => {
    const { service, facings } = serviceOver([
      facingWith('bay-0', hour(0), { initialState: 'in_stock' }),
    ]);
    const event = voidRun(hour(3), ['bay-0'], 'same-key');

    const first = accepted(await service.ingest(event));
    const second = await service.ingest(event);

    expect(second).toEqual({
      status: 'duplicate',
      idempotencyKey: 'same-key',
      firstAcceptedAt: first.acceptedAt,
    });
    expect(facings.saveCount).toBe(1);
  });

  it('rejects the whole event when one facing is unknown, applying none of it', async () => {
    // One event is one decision about a bay. Half-applying it would leave a
    // history no replay of the event stream can reproduce.
    const { service, facings } = serviceOver([
      facingWith('bay-0', hour(0), { initialState: 'in_stock' }),
    ]);

    const outcome = await service.ingest(voidRun(hour(3), ['bay-0', 'bay-missing']));

    expect(outcome).toEqual({
      status: 'rejected',
      rejection: { reason: 'unknown_facing', facingId: 'bay-missing' },
    });
    expect((await facings.load(ACME, facingIdOf('bay-0')))?.state).toBe('in_stock');
    expect(facings.saveCount).toBe(0);
  });

  it('rejects a schema version it does not support', async () => {
    const { service } = serviceOver([facingWith('bay-0', hour(0))]);
    // Deliberately out of contract: what a stale producer actually sends.
    const stale = detectionEvent('arpalus_detection', hour(3), [arpalusObservation('bay-0')], {
      schemaVersion: '0.9' as '1.0',
    });

    expect(await service.ingest(stale)).toEqual({
      status: 'rejected',
      rejection: {
        reason: 'unsupported_schema_version',
        received: '0.9',
        supported: DETECTION_SCHEMA_CONTRACT.supported,
      },
    });
  });

  it('rejects a producer whose declared system is not what it sent', async () => {
    const { service } = serviceOver([facingWith('bay-0', hour(0))]);
    const misrouted = detectionEvent('arpalus_detection', hour(3), [arpalusObservation('bay-0')], {
      producer: { system: 'caper_frame', instanceId: 'cart-3', softwareVersion: '4.2.1' },
    });

    const outcome = await service.ingest(misrouted);
    expect(outcome).toMatchObject({
      status: 'rejected',
      rejection: { reason: 'schema_violation', field: 'envelope.producer.system' },
    });
  });

  it('publishes the versioning contract producers negotiate against', async () => {
    const { service } = serviceOver([]);
    expect(await service.describeSchemaContract()).toBe(DETECTION_SCHEMA_CONTRACT);
  });
});

describe('ingesting a batch', () => {
  it('answers positionally, accepting and rejecting events individually', async () => {
    // One malformed frame must not stall a whole store's stream.
    const { service } = serviceOver([facingWith('bay-0', hour(0), { initialState: 'in_stock' })]);

    const outcomes = await service.ingestBatch({
      retailerId: ACME,
      events: [
        voidRun(hour(3), ['bay-0'], 'good-1'),
        voidRun(hour(4), ['bay-missing'], 'bad-1'),
        detectionEvent('shopper_scan', hour(5), [scanObservation('bay-0', 'found')], {
          idempotencyKey: 'good-2',
        }),
      ],
    });

    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      'accepted',
      'rejected',
      'accepted',
    ]);
  });

  it('applies events to the same facing in submission order', async () => {
    const { service, facings } = serviceOver([
      facingWith('bay-0', hour(0), { initialState: 'in_stock' }),
    ]);

    await service.ingestBatch({
      retailerId: ACME,
      events: [
        voidRun(hour(3), ['bay-0'], 'run-1'),
        detectionEvent('shopper_scan', hour(6), [scanObservation('bay-0', 'found')], {
          idempotencyKey: 'run-2',
        }),
      ],
    });

    const stored = await facings.load(ACME, facingIdOf('bay-0'));
    expect(stored?.history.events.map((event) => event.to)).toEqual(['out_of_stock', 'in_stock']);
    expect(stored?.state).toBe('in_stock');
  });

  it('rejects an event carrying a different retailer than the batch it arrived in', async () => {
    const { service, facings } = serviceOver([facingWith('bay-0', hour(0))]);

    const outcomes = await service.ingestBatch({
      retailerId: ACME,
      events: [voidRun(hour(3), ['bay-0'], 'theirs')].map((event) => ({
        ...event,
        envelope: { ...event.envelope, retailerId: RIVAL },
      })) as readonly DetectionEvent[],
    });

    expect(outcomes[0]).toEqual({
      status: 'rejected',
      rejection: { reason: 'cross_retailer_mismatch', expected: ACME, actual: RIVAL },
    });
    expect(facings.saveCount).toBe(0);
  });
});
