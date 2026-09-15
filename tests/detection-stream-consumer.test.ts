import { describe, expect, it } from 'vitest';
import {
  DETECTION_SOURCES,
  DETECTION_SOURCE_ADAPTERS,
  DetectionIngestionService,
  DetectionStreamConsumer,
  detectionTopic,
  eventId,
  instantFromISO,
  streamSignalId,
  type ConsumedBatch,
  type DeadLetterReason,
  type DetectionSource,
  type Facing,
  type FacingId,
  type RecordDisposition,
  type RetailerId,
  type SignalOf,
} from '../src/index.js';
import { ACME, RIVAL, STORE, facingWith, hour } from './support/fixtures.js';
import { InMemoryFacingRepository, InMemoryIngestionLedger } from './support/in-memory-ports.js';
import {
  InMemoryEventStream,
  RecordingDeadLetterSink,
  RecordingIngestion,
  ScriptedIngestion,
  acceptedAt,
  rateLimited,
  streamBatch,
  streamRecord,
} from './support/in-memory-stream.js';
import {
  ACME_CODE,
  FACING_REF,
  RIVAL_CODE,
  arpalusScan,
  arpalusSegment,
  caperDetection,
  caperFrame,
  carrotLabel,
  carrotSweep,
  posBatch,
  posLine,
  shopperItemScan,
} from './support/producer-payloads.js';

/**
 * Integration tests for the detection-stream consumers.
 *
 * Wired to the real `DetectionIngestionService` over the in-memory repository and
 * ledger, not to a stubbed port: what these need to establish is that a vendor's
 * bytes on a topic end up as a shelf state on a facing, and every seam in between
 * is somewhere that can break.
 */

const NOW = hour(12);

interface Harness {
  readonly consumer: DetectionStreamConsumer;
  readonly stream: InMemoryEventStream;
  readonly deadLetters: RecordingDeadLetterSink;
  readonly ingestion: RecordingIngestion;
  readonly facings: InMemoryFacingRepository;
}

const harnessOver = (facings: readonly Facing[] = [facingWith(FACING_REF, hour(0))]): Harness => {
  const repository = new InMemoryFacingRepository(facings);
  const ingestion = new RecordingIngestion(
    new DetectionIngestionService({
      facings: repository,
      ledger: new InMemoryIngestionLedger(),
      now: () => NOW,
      nextSignalId: streamSignalId,
      nextEventId: (facing: Facing) =>
        eventId(`${facing.facingId}:${facing.history.events.length + 1}`),
    }),
  );
  const stream = new InMemoryEventStream();
  const deadLetters = new RecordingDeadLetterSink();

  return {
    consumer: new DetectionStreamConsumer({
      stream,
      ingestion,
      deadLetters,
      now: () => NOW,
    }),
    stream,
    deadLetters,
    ingestion,
    facings: repository,
  };
};

/** Consumes one payload on one source's topic, keyed as a producer would key it. */
const consumeOne = async (
  harness: Harness,
  source: DetectionSource,
  payload: unknown,
  key: string | null = ACME_CODE,
): Promise<ConsumedBatch> => {
  const topic = detectionTopic(source);
  return harness.consumer.consume(streamBatch(topic, [streamRecord(topic, key, payload)]));
};

const only = (consumed: ConsumedBatch): RecordDisposition => {
  const [disposition] = consumed.dispositions;
  if (disposition === undefined) throw new Error('expected exactly one disposition');
  return disposition;
};

const facingAfter = async (
  harness: Harness,
  retailerId: RetailerId = ACME,
  facingId: FacingId = FACING_REF as FacingId,
): Promise<Facing> => {
  const facing = await harness.facings.load(retailerId, facingId);
  if (facing === null) throw new Error(`no facing ${facingId} in ${retailerId}`);
  return facing;
};

const signalFrom = async <S extends DetectionSource>(
  harness: Harness,
  source: S,
): Promise<SignalOf<S>> => {
  const facing = await facingAfter(harness);
  const signal = facing.signals[source];
  if (signal === null) throw new Error(`no ${source} signal reached the facing`);
  return signal;
};

/** The payload each source's producer publishes, in that producer's own dialect. */
const PAYLOAD_BY_SOURCE: { readonly [S in DetectionSource]: () => unknown } = {
  shopper_scan: () => shopperItemScan(),
  arpalus_detection: () => arpalusScan([arpalusSegment()]),
  caper_frame: () => caperFrame([caperDetection()]),
  carrot_tag_label: () => carrotSweep([carrotLabel()]),
  pos_movement: () => posBatch([posLine()]),
};

describe('subscribing to every detection source', () => {
  it('binds one adapter, on its own topic, to each of the five sources', () => {
    // A mapped type over `DetectionSource` backs the registry, so this is really
    // asserting the compiler's guarantee holds at runtime too — and that no two
    // adapters landed on the same topic, which would silently shadow one source.
    const topics = DETECTION_SOURCES.map((source) => DETECTION_SOURCE_ADAPTERS[source].topic);

    expect(DETECTION_SOURCES).toHaveLength(5);
    expect(new Set(topics).size).toBe(5);
    for (const source of DETECTION_SOURCES) {
      expect(DETECTION_SOURCE_ADAPTERS[source].source).toBe(source);
    }
  });

  it('subscribes to all five topics when started', async () => {
    const harness = harnessOver();
    const subscription = await harness.consumer.start();

    expect([...subscription.topics].sort()).toEqual(
      DETECTION_SOURCES.map(detectionTopic).sort(),
    );
    expect(harness.stream.topics).toHaveLength(5);
  });

  it.each(DETECTION_SOURCES)(
    'deserializes a %s payload and routes it into the ingestion use case',
    async (source) => {
      const harness = harnessOver();

      const consumed = await consumeOne(harness, source, PAYLOAD_BY_SOURCE[source]());

      expect(only(consumed).outcome.status).toBe('ingested');
      // The proof the event reached the domain and not just the port: the facing
      // is holding this source's latest signal.
      const signal = await signalFrom(harness, source);
      expect(signal.source).toBe(source);
      expect(signal.retailerId).toBe(ACME);
      expect(signal.storeId).toBe(STORE);
      expect(signal.observedAt).toBe(instantFromISO('2026-03-02T09:00:00.000Z'));
    },
  );

  it('stamps every decoded event with the layer-owned schema version, not the producer version', async () => {
    const harness = harnessOver();

    await consumeOne(harness, 'arpalus_detection', arpalusScan([arpalusSegment()]));

    const [batch] = harness.ingestion.batches;
    const event = batch?.events[0];
    expect(event?.envelope.schemaVersion).toBe('1.0');
    // Namespaced by source: producer ids are unique only within a producer, and
    // the ledger's key space is shared across all five of them.
    expect(event?.envelope.idempotencyKey).toBe('arpalus_detection:scan-8821');
    expect(event?.envelope.producer).toEqual({
      system: 'arpalus_detection',
      instanceId: 'cam-7',
      softwareVersion: '2.11.0',
    });
  });
});

describe('translating each producer dialect', () => {
  it('reads Arpalus void space as a ratio, not as the percentage it arrives as', async () => {
    // 33.5% void is a two-thirds-full shelf. Taken at face value it is 33.5,
    // far past the 0.7 out-of-stock threshold, and the shelf reads as empty.
    const harness = harnessOver();

    await consumeOne(harness, 'arpalus_detection', arpalusScan([arpalusSegment()]));

    const signal = await signalFrom(harness, 'arpalus_detection');
    expect(signal.voidRatio).toBeCloseTo(0.335, 10);
    expect(signal.detectedFacings).toBe(2);
    expect(signal.expectedFacings).toBe(3);
    expect((await facingAfter(harness)).state).toBe('in_stock');
  });

  it('calls a void from Arpalus once the converted ratio clears the threshold', async () => {
    const harness = harnessOver();

    await consumeOne(
      harness,
      'arpalus_detection',
      arpalusScan([arpalusSegment({ void_pct: 94, facings_detected: 0 })]),
    );

    expect((await facingAfter(harness)).state).toBe('out_of_stock');
  });

  it('converts Caper gap widths from millimetres to centimetres', async () => {
    // 180 mm is 18 cm, past the 12 cm void threshold. Unconverted it is 180 cm,
    // which would call a void on anything and would never be noticed in testing,
    // because the wrong answer and the right one agree on this case.
    const harness = harnessOver();

    await consumeOne(
      harness,
      'caper_frame',
      caperFrame([caperDetection({ productVisible: false, gapWidthMm: 180 })]),
    );

    const signal = await signalFrom(harness, 'caper_frame');
    expect(signal.gapWidthCm).toBe(18);
    expect((await facingAfter(harness)).state).toBe('out_of_stock');
  });

  it('leaves a narrow Caper gap short of a void call', async () => {
    const harness = harnessOver();

    await consumeOne(
      harness,
      'caper_frame',
      caperFrame([caperDetection({ productVisible: false, gapWidthMm: 80 })]),
    );

    const signal = await signalFrom(harness, 'caper_frame');
    expect(signal.gapWidthCm).toBe(8);
    // 8 cm is a fingersbreadth, not a hole: no stock evidence, so the facing
    // stays where it was rather than being called empty.
    expect((await facingAfter(harness)).state).toBe('unknown');
  });

  it('reads a Caper frame from epoch millis while the other producers send ISO-8601', async () => {
    const harness = harnessOver();

    await consumeOne(harness, 'caper_frame', caperFrame([caperDetection()]));

    const signal = await signalFrom(harness, 'caper_frame');
    expect(signal.observedAt).toBe(instantFromISO('2026-03-02T09:00:00.000Z'));
  });

  it('translates Carrot Tags status codes, decimal prices and lamp colours', async () => {
    const harness = harnessOver();

    await consumeOne(
      harness,
      'carrot_tag_label',
      carrotSweep([carrotLabel({ status: 'PRICE_MISMATCH', price: '5.99', lamp: 'RED' })]),
    );

    const signal = await signalFrom(harness, 'carrot_tag_label');
    expect(signal.labelState).toBe('price_mismatch');
    // Parsed off the string: `5.99 * 100` is 598.9999999999999, and a price a
    // cent low on the shelf edge is exactly the defect this service catches.
    expect(signal.displayedPriceCents).toBe(599);
    expect(signal.litLane).toBe('red');
    expect(signal.confidence).toBe(1);
  });

  it('reads a dark Carrot Tag as an unlit lane rather than a missing reading', async () => {
    const harness = harnessOver();

    await consumeOne(harness, 'carrot_tag_label', carrotSweep([carrotLabel({ lamp: 'OFF' })]));

    expect((await signalFrom(harness, 'carrot_tag_label')).litLane).toBeNull();
  });

  it('never lets a Carrot Tags sweep move the stock timeline', async () => {
    const harness = harnessOver();

    await consumeOne(
      harness,
      'carrot_tag_label',
      carrotSweep([carrotLabel({ status: 'OFFLINE' })]),
    );

    // Label health is a task, not evidence about stock. The signal lands on the
    // facing; the state does not move.
    const facing = await facingAfter(harness);
    expect(facing.signals.carrot_tag_label).not.toBeNull();
    expect(facing.state).toBe('unknown');
    expect(facing.history.events).toHaveLength(0);
  });

  it('turns the POS window into a duration observed at its close', async () => {
    const harness = harnessOver();

    await consumeOne(harness, 'pos_movement', posBatch([posLine({ unitsSold: 0 })]));

    const signal = await signalFrom(harness, 'pos_movement');
    expect(signal.windowMillis).toBe(60 * 60 * 1000);
    // The window's close, not its open: backdating an hour would let a stale
    // reading lose to — or worse, overwrite — a fresher detection in a history
    // that orders by observation time.
    expect(signal.observedAt).toBe(instantFromISO('2026-03-02T09:00:00.000Z'));
    expect(signal.expectedUnitsSold).toBe(9.4);
    // A facing forecast to sell 9.4 units that sold none is phantom inventory.
    expect((await facingAfter(harness)).state).toBe('out_of_stock');
  });

  it('rejects a POS window that ends before it starts rather than clamping it', async () => {
    const harness = harnessOver();

    const consumed = await consumeOne(
      harness,
      'pos_movement',
      posBatch([posLine()], {
        window: { start: '2026-03-02T09:00:00.000Z', end: '2026-03-02T08:00:00.000Z' },
      }),
    );

    expect(only(consumed).outcome).toMatchObject({
      status: 'dead_lettered',
      reason: 'schema_violation',
    });
    // Zeroing it would leave a broken job's output looking perfectly healthy.
    expect(harness.deadLetters.letters[0]?.detail).toContain('window.end');
  });

  it('maps a shopper replacement onto a substitution, as one observation', async () => {
    const harness = harnessOver();

    await consumeOne(harness, 'shopper_scan', shopperItemScan({
      item: {
        facing_id: FACING_REF,
        product_id: 'sku-oat-milk-64oz',
        result: 'REPLACED',
        confidence: 0.95,
      },
    }));

    const signal = await signalFrom(harness, 'shopper_scan');
    expect(signal.outcome).toBe('substituted');
    // A shopper scans one item at a time; the single observation is wrapped into
    // the port's array shape rather than the port growing a producer-specific one.
    expect(harness.ingestion.batches[0]?.events[0]?.observations).toHaveLength(1);
    expect((await facingAfter(harness)).state).toBe('out_of_stock');
  });

  it('covers a whole bay from one Arpalus scan', async () => {
    const harness = harnessOver([
      facingWith('bay-0', hour(0)),
      facingWith('bay-1', hour(0)),
      facingWith('bay-2', hour(0)),
    ]);

    const consumed = await consumeOne(
      harness,
      'arpalus_detection',
      arpalusScan(
        ['bay-0', 'bay-1', 'bay-2'].map((facing) =>
          arpalusSegment({ facing_ref: facing, void_pct: 90, facings_detected: 0 }),
        ),
      ),
    );

    const disposition = only(consumed).outcome;
    expect(disposition.status).toBe('ingested');
    if (disposition.status !== 'ingested') throw new Error('unreachable');
    expect(disposition.results).toHaveLength(3);
    for (const facingId of ['bay-0', 'bay-1', 'bay-2']) {
      expect((await facingAfter(harness, ACME, facingId as FacingId)).state).toBe('out_of_stock');
    }
  });
});

describe('surviving what producers actually send', () => {
  const deadLetterReasonOf = (consumed: ConsumedBatch): DeadLetterReason => {
    const outcome = only(consumed).outcome;
    if (outcome.status !== 'dead_lettered') {
      throw new Error(`expected a dead letter, got ${outcome.status}`);
    }
    return outcome.reason;
  };

  it('sets aside bytes that are not valid UTF-8', async () => {
    const harness = harnessOver();
    const topic = detectionTopic('arpalus_detection');
    const record = streamRecord(topic, ACME_CODE, null, {
      value: new Uint8Array([0xff, 0xfe, 0xfd]),
    });

    const consumed = await harness.consumer.consume(streamBatch(topic, [record]));

    expect(deadLetterReasonOf(consumed)).toBe('undecodable_bytes');
    // Still committed: no amount of retrying will make these bytes decode, and
    // blocking on them would stall every retailer behind this partition.
    expect(consumed.commitThrough).toBe(record.offset);
  });

  it('sets aside a payload that is not JSON', async () => {
    const harness = harnessOver();

    const consumed = await consumeOne(harness, 'caper_frame', '{"frameId": ');

    expect(deadLetterReasonOf(consumed)).toBe('malformed_payload');
  });

  it('sets aside a payload whose producer version we cannot read', async () => {
    const harness = harnessOver();

    const consumed = await consumeOne(
      harness,
      'arpalus_detection',
      arpalusScan([arpalusSegment()], { schema: 'arpalus.shelf-scan.v3' }),
    );

    expect(deadLetterReasonOf(consumed)).toBe('unsupported_wire_version');
    expect(harness.deadLetters.letters[0]?.detail).toContain('arpalus.shelf-scan.v3');
  });

  it('refuses to guess at a payload carrying no version marker', async () => {
    const harness = harnessOver();
    // A version marker split across two fields is still missing when one of them
    // is: reading fields out of an unrecognised shape is how a renamed field
    // becomes a wrong shelf state.
    const consumed = await consumeOne(
      harness,
      'caper_frame',
      caperFrame([caperDetection()], { version: null }),
    );

    expect(deadLetterReasonOf(consumed)).toBe('unsupported_wire_version');
  });

  it('names the offending field path when a payload is missing something', async () => {
    const harness = harnessOver();

    const consumed = await consumeOne(
      harness,
      'arpalus_detection',
      arpalusScan([arpalusSegment({ void_pct: undefined })]),
    );

    expect(deadLetterReasonOf(consumed)).toBe('schema_violation');
    // The audience for this string is the vendor engineer reading the queue.
    expect(harness.deadLetters.letters[0]?.detail).toBe(
      'segments[0].void_pct: expected a finite number, got nothing',
    );
  });

  it('reports a value outside its range rather than accepting it', async () => {
    const harness = harnessOver();

    const consumed = await consumeOne(
      harness,
      'arpalus_detection',
      arpalusScan([arpalusSegment({ void_pct: 140 })]),
    );

    expect(deadLetterReasonOf(consumed)).toBe('schema_violation');
    expect(harness.deadLetters.letters[0]?.detail).toContain('within [0, 100]');
  });

  it('lists the vocabulary it accepts when a producer sends an unknown enum member', async () => {
    const harness = harnessOver();

    const consumed = await consumeOne(
      harness,
      'carrot_tag_label',
      carrotSweep([carrotLabel({ status: 'FIRMWARE_UPDATING' })]),
    );

    expect(deadLetterReasonOf(consumed)).toBe('schema_violation');
    expect(harness.deadLetters.letters[0]?.detail).toContain('PRICE_MISMATCH');
  });

  it('sets aside a message that landed on the wrong topic', async () => {
    const harness = harnessOver();

    const consumed = await consumeOne(
      harness,
      'carrot_tag_label',
      carrotSweep([carrotLabel()], { msg_type: 'gateway_heartbeat' }),
    );

    expect(deadLetterReasonOf(consumed)).toBe('schema_violation');
  });

  it('sets aside every record from a topic no adapter is bound to', async () => {
    const harness = harnessOver();
    const batch = streamBatch('osa.detections.weather_feed', [
      streamRecord('osa.detections.weather_feed', ACME_CODE, { anything: true }),
    ]);

    const consumed = await harness.consumer.consume(batch);

    expect(deadLetterReasonOf(consumed)).toBe('unknown_topic');
    expect(consumed.commitThrough).not.toBeNull();
  });

  it('keeps consuming past a bad record instead of stalling the partition', async () => {
    const harness = harnessOver();
    const topic = detectionTopic('arpalus_detection');
    const good = (scanId: string, voidPct: number) =>
      streamRecord(
        topic,
        ACME_CODE,
        arpalusScan([arpalusSegment({ void_pct: voidPct, facings_detected: 0 })], {
          scan_id: scanId,
        }),
      );
    const records = [good('scan-1', 10), streamRecord(topic, ACME_CODE, 'not json at all'), good('scan-2', 95)];

    const consumed = await harness.consumer.consume(streamBatch(topic, records));

    expect(consumed.dispositions.map((d) => d.outcome.status)).toEqual([
      'ingested',
      'dead_lettered',
      'ingested',
    ]);
    // The whole batch commits: the poison record is filed, not retried forever.
    expect(consumed.commitThrough).toBe(records[2]?.offset);
    // And the good records really did land — the later scan moved the shelf.
    expect((await facingAfter(harness)).state).toBe('out_of_stock');
  });

  it('files dead letters once per batch, with the payload verbatim', async () => {
    const harness = harnessOver();
    const topic = detectionTopic('caper_frame');
    const records = [
      streamRecord(topic, ACME_CODE, 'broken one'),
      streamRecord(topic, ACME_CODE, 'broken two'),
    ];

    await harness.consumer.consume(streamBatch(topic, records));

    expect(harness.deadLetters.captureCalls).toBe(1);
    expect(harness.deadLetters.letters).toHaveLength(2);
    expect(harness.deadLetters.letters[0]).toMatchObject({
      topic,
      offset: records[0]?.offset,
      payload: 'broken one',
      failedAt: NOW,
    });
  });

  it('files a rejection ingestion will repeat, rather than retrying it forever', async () => {
    // No facing for this reference exists in the partition, and no amount of
    // redelivery will conjure one.
    const harness = harnessOver([facingWith('some-other-facing', hour(0))]);

    const consumed = await consumeOne(harness, 'arpalus_detection', arpalusScan([arpalusSegment()]));

    expect(only(consumed).outcome).toMatchObject({
      status: 'dead_lettered',
      reason: 'rejected_by_ingestion',
    });
    expect(harness.deadLetters.letters[0]?.detail).toContain('no facing');
    expect(harness.deadLetters.letters[0]?.retailerId).toBe(ACME);
  });
});

describe('preserving the retailer partition from consumption onward', () => {
  it('submits one single-partition batch per retailer in the delivery', async () => {
    const harness = harnessOver([
      facingWith(FACING_REF, hour(0)),
      facingWith(FACING_REF, hour(0), { retailerId: RIVAL, storeId: STORE }),
    ]);
    const topic = detectionTopic('arpalus_detection');
    const forRetailer = (code: string, retailer: string, scanId: string) =>
      streamRecord(
        topic,
        code,
        arpalusScan([arpalusSegment()], {
          scan_id: scanId,
          site: { retailer, store: 'acme-0042' },
        }),
      );

    const consumed = await harness.consumer.consume(
      streamBatch(topic, [
        forRetailer(ACME_CODE, ACME_CODE, 'scan-a'),
        forRetailer(RIVAL_CODE, RIVAL_CODE, 'scan-r'),
        forRetailer(ACME_CODE, ACME_CODE, 'scan-b'),
      ]),
    );

    expect(consumed.dispositions.every((d) => d.outcome.status === 'ingested')).toBe(true);
    // Two batches, never one pooled batch — the same no-cross-retailer-pooling
    // invariant the domain enforces internally, asserted where data enters.
    expect(harness.ingestion.batches).toHaveLength(2);
    for (const batch of harness.ingestion.batches) {
      expect(
        batch.events.every((event) => event.envelope.retailerId === batch.retailerId),
      ).toBe(true);
    }
    expect(harness.ingestion.batches.map((batch) => batch.retailerId)).toEqual([ACME, RIVAL]);
    expect(consumed.retailers).toEqual([ACME, RIVAL]);
  });

  it('refuses a record whose key and envelope name different retailers', async () => {
    const harness = harnessOver();

    // Keyed for the rival, carrying an Acme scan: a producer routing bug that
    // would put one retailer's shelf data in the other's partition.
    const consumed = await consumeOne(
      harness,
      'arpalus_detection',
      arpalusScan([arpalusSegment()]),
      RIVAL_CODE,
    );

    expect(only(consumed).outcome).toMatchObject({
      status: 'dead_lettered',
      reason: 'partition_key_mismatch',
    });
    // Neither value is honoured over the other, and nothing was ingested.
    expect(harness.ingestion.batches).toHaveLength(0);
    expect((await facingAfter(harness)).signals.arpalus_detection).toBeNull();
  });

  it('refuses an unkeyed record rather than inferring the partition', async () => {
    const harness = harnessOver();

    const consumed = await consumeOne(
      harness,
      'shopper_scan',
      shopperItemScan(),
      null,
    );

    expect(only(consumed).outcome).toMatchObject({
      status: 'dead_lettered',
      reason: 'partition_key_mismatch',
    });
    // The dead letter is still filed under the retailer the envelope claimed, so
    // it reaches the right operator even though the record could not be trusted.
    expect(harness.deadLetters.letters[0]?.retailerId).toBe(ACME);
  });
});

describe('committing what was actually handled', () => {
  it('holds the watermark before the first record that needs a retry', async () => {
    const topic = detectionTopic('pos_movement');
    const records = [
      streamRecord(topic, ACME_CODE, posBatch([posLine()], { batchId: 'b1' })),
      streamRecord(topic, ACME_CODE, posBatch([posLine()], { batchId: 'b2' })),
      streamRecord(topic, ACME_CODE, posBatch([posLine()], { batchId: 'b3' })),
    ];
    const deadLetters = new RecordingDeadLetterSink();
    const consumer = new DetectionStreamConsumer({
      stream: new InMemoryEventStream(),
      // Rate limiting is the one rejection a later attempt can turn into an
      // acceptance, so it alone holds the commit back.
      ingestion: new ScriptedIngestion([acceptedAt(NOW), rateLimited(5_000), acceptedAt(NOW)]),
      deadLetters,
      now: () => NOW,
    });

    const consumed = await consumer.consume(streamBatch(topic, records));

    expect(consumed.dispositions.map((d) => d.outcome.status)).toEqual([
      'ingested',
      'retry',
      'ingested',
    ]);
    expect(consumed.commitThrough).toBe(records[0]?.offset);
    // A retry is not a poison message; nothing is filed.
    expect(deadLetters.letters).toHaveLength(0);
  });

  it('acks the subscription with the offset it is safe to commit through', async () => {
    const harness = harnessOver();
    await harness.consumer.start();
    const topic = detectionTopic('shopper_scan');
    const record = streamRecord(topic, ACME_CODE, shopperItemScan());

    const ack = await harness.stream.deliver(streamBatch(topic, [record]));

    expect(ack.commitThrough).toBe(record.offset);
    expect((await facingAfter(harness)).signals.shopper_scan).not.toBeNull();
  });

  it('treats a redelivered record as a duplicate instead of re-applying it', async () => {
    const harness = harnessOver();
    const topic = detectionTopic('arpalus_detection');
    const record = streamRecord(
      topic,
      ACME_CODE,
      arpalusScan([arpalusSegment({ void_pct: 95, facings_detected: 0 })]),
    );

    const first = await harness.consumer.consume(streamBatch(topic, [record]));
    const second = await harness.consumer.consume(streamBatch(topic, [record]));

    expect(only(first).outcome.status).toBe('ingested');
    // Redelivery is normal at this boundary — a cart reconnects, a gateway
    // replays its buffer — so the signal ids the adapter mints are derived from
    // the envelope and the replay is recognised rather than forking the history.
    expect(only(second).outcome.status).toBe('duplicate');
    expect((await facingAfter(harness)).history.events).toHaveLength(1);
  });
});
