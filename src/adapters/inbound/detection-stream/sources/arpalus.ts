import { facingId, productId, retailerId, storeId } from '../../../../domain/common/ids.js';
import type { DetectionEventOf } from '../../../../ports/inbound/detection-ingestion.port.js';
import { envelopeFrom, type DecodeContext, type SourceAdapter } from '../source-adapter.js';
import { detectionTopic } from '../topics.js';
import {
  isoInstant,
  obj,
  objectsIn,
  optional,
  percentAsRatio,
  nonNegativeInt,
  ratio,
  str,
  wireObject,
} from '../wire.js';

/**
 * Arpalus shelf-vision scans.
 *
 * A scan is one pass of a camera over a bay, so one payload carries many
 * segments that share a capture instant — the shape the port was designed around.
 *
 * Two adaptations carry real risk if they were left to the producer. Void space
 * arrives as a percentage (`void_pct`, 0–100) and the domain works in ratios, so
 * an unconverted 33.5 would read as a void ratio far past the out-of-stock
 * threshold and empty a shelf that is two-thirds full. And Arpalus scopes its
 * site under a `site` object, so a scan that names no retailer fails here rather
 * than inheriting one from the connection.
 *
 * ```json
 * {
 *   "schema": "arpalus.shelf-scan.v2",
 *   "scan_id": "scan-8821",
 *   "site": { "retailer": "acme-grocery", "store": "acme-0042" },
 *   "sensor": { "camera_id": "cam-7", "agent_version": "2.11.0" },
 *   "captured_at": "2026-03-02T09:00:00.000Z",
 *   "published_at": "2026-03-02T09:00:04.000Z",
 *   "pass_id": "pass-99",
 *   "segments": [
 *     { "facing_ref": "acme-0042:a12:b3:s2:p1", "sku": "sku-oat-milk-64oz",
 *       "score": 0.92, "facings_detected": 2, "facings_expected": 3, "void_pct": 33.5 }
 *   ]
 * }
 * ```
 */
export const arpalusAdapter: SourceAdapter<'arpalus_detection'> = {
  source: 'arpalus_detection',
  topic: detectionTopic('arpalus_detection'),
  supportedWireVersions: ['arpalus.shelf-scan.v2'],

  wireVersion(payload: unknown): string | null {
    const root = wireObject(payload, '');
    return optional(root, 'schema', str);
  },

  decode(payload: unknown, context: DecodeContext): DetectionEventOf<'arpalus_detection'> {
    const root = wireObject(payload, '');
    const site = obj(root, 'site');
    const sensor = obj(root, 'sensor');

    return {
      envelope: envelopeFrom({
        source: 'arpalus_detection',
        producerEventId: str(root, 'scan_id'),
        retailerId: retailerId(str(site, 'retailer')),
        storeId: storeId(str(site, 'store')),
        instanceId: str(sensor, 'camera_id'),
        softwareVersion: str(sensor, 'agent_version'),
        occurredAt: isoInstant(root, 'captured_at'),
        // A scan is uploaded after the store pass finishes, sometimes minutes
        // later; when the batch job omits the upload time, the broker's append
        // time is the closest honest stand-in.
        producedAt: optional(root, 'published_at', isoInstant) ?? context.record.timestamp,
        // The store pass this scan belonged to, which is how an operator ties a
        // suspicious run of voids back to one trip round the aisles.
        correlationId: optional(root, 'pass_id', str),
      }),
      source: 'arpalus_detection',
      observations: objectsIn(root, 'segments').map((segment) => ({
        facingId: facingId(str(segment, 'facing_ref')),
        confidence: ratio(segment, 'score'),
        productId: productId(str(segment, 'sku')),
        detectedFacings: nonNegativeInt(segment, 'facings_detected'),
        expectedFacings: nonNegativeInt(segment, 'facings_expected'),
        voidRatio: percentAsRatio(segment, 'void_pct'),
      })),
    };
  },
};
