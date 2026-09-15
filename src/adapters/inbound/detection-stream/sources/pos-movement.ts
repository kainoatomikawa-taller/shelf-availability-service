import { facingId, productId, retailerId, storeId } from '../../../../domain/common/ids.js';
import { elapsed, toISO } from '../../../../domain/common/time.js';
import { CERTAIN } from '../../../../domain/facing/signals.js';
import type { DetectionEventOf } from '../../../../ports/inbound/detection-ingestion.port.js';
import { envelopeFrom, type DecodeContext, type SourceAdapter } from '../source-adapter.js';
import { detectionTopic } from '../topics.js';
import {
  WireViolationError,
  isoInstant,
  nonNegativeInt,
  nonNegativeNum,
  obj,
  objectsIn,
  optional,
  str,
  wireObject,
} from '../wire.js';

/**
 * POS sell-through, published by the retailer's own aggregation job.
 *
 * The one source that is not an observation of a shelf at all: it is an
 * inference from the registers, and it is how phantom inventory gets caught —
 * a facing the system believes is stocked, selling nothing while its neighbours
 * sell normally.
 *
 * The adaptation that matters is time. The job reports a window as two
 * timestamps; the domain wants a duration plus a single observation instant, and
 * that instant is the window's *close*, not its open. Taking the open would
 * backdate an hour of evidence and let a stale reading overwrite a fresher
 * detection in the facing history, which orders by `occurredAt`. A window that
 * ends before it starts is rejected rather than clamped — a negative duration
 * means the job is broken, and a silently zeroed one would make its output look fine.
 *
 * ```json
 * {
 *   "feed": "pos.movement",
 *   "feedVersion": "2024-06",
 *   "retailer": "acme-grocery",
 *   "store": "acme-0042",
 *   "job": { "name": "pos-agg-hourly", "build": "1.9.0" },
 *   "batchId": "posb-31",
 *   "window": { "start": "2026-03-02T08:00:00.000Z", "end": "2026-03-02T09:00:00.000Z" },
 *   "emittedAt": "2026-03-02T09:01:00.000Z",
 *   "lines": [
 *     { "facingId": "acme-0042:a12:b3:s2:p1", "gtin": "sku-oat-milk-64oz",
 *       "unitsSold": 0, "forecastUnits": 9.4 }
 *   ]
 * }
 * ```
 */
export const posMovementAdapter: SourceAdapter<'pos_movement'> = {
  source: 'pos_movement',
  topic: detectionTopic('pos_movement'),
  supportedWireVersions: ['pos.movement@2024-06'],

  wireVersion(payload: unknown): string | null {
    const root = wireObject(payload, '');
    const feed = optional(root, 'feed', str);
    const feedVersion = optional(root, 'feedVersion', str);
    return feed === null || feedVersion === null ? null : `${feed}@${feedVersion}`;
  },

  decode(payload: unknown, context: DecodeContext): DetectionEventOf<'pos_movement'> {
    const root = wireObject(payload, '');
    const job = obj(root, 'job');
    const window = obj(root, 'window');

    const windowStart = isoInstant(window, 'start');
    const windowEnd = isoInstant(window, 'end');
    if (windowEnd < windowStart) {
      throw new WireViolationError(
        'window.end',
        `window ends before it starts: ${toISO(windowStart)} .. ${toISO(windowEnd)}`,
      );
    }
    const windowMillis = elapsed(windowStart, windowEnd);

    return {
      envelope: envelopeFrom({
        source: 'pos_movement',
        producerEventId: str(root, 'batchId'),
        retailerId: retailerId(str(root, 'retailer')),
        storeId: storeId(str(root, 'store')),
        instanceId: str(job, 'name'),
        softwareVersion: str(job, 'build'),
        // The window's close: sell-through is evidence about the shelf as of the
        // end of the period it covers, not as of the moment it opened.
        occurredAt: windowEnd,
        producedAt: optional(root, 'emittedAt', isoInstant) ?? context.record.timestamp,
        correlationId: str(root, 'batchId'),
      }),
      source: 'pos_movement',
      observations: objectsIn(root, 'lines').map((line) => ({
        facingId: facingId(str(line, 'facingId')),
        // Registers count; they do not estimate.
        confidence: CERTAIN,
        productId: productId(str(line, 'gtin')),
        unitsSold: nonNegativeInt(line, 'unitsSold'),
        // A forecast is fractional by nature — 9.4 units in the hour — and is
        // deliberately not rounded on the way in.
        expectedUnitsSold: nonNegativeNum(line, 'forecastUnits'),
        windowMillis,
      })),
    };
  },
};
