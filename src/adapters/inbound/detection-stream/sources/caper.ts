import { facingId, productId, retailerId, storeId } from '../../../../domain/common/ids.js';
import type { DetectionEventOf } from '../../../../ports/inbound/detection-ingestion.port.js';
import { envelopeFrom, type DecodeContext, type SourceAdapter } from '../source-adapter.js';
import {
  bool,
  epochMillisInstant,
  int,
  nonNegativeNum,
  obj,
  objectsIn,
  optional,
  ratio,
  str,
  wireObject,
} from '../wire.js';

/**
 * Caper smart-cart camera frames.
 *
 * A frame is whatever the cart saw as it rolled past a bay, so like an Arpalus
 * scan it covers several facings at one instant — but unlike Arpalus it arrives
 * continuously, keyed to a shopper's trip rather than a scheduled pass.
 *
 * The version marker is split across two fields (`eventType` plus a numeric
 * `version`), which is exactly why recognising it belongs to the adapter and not
 * to the consumer. Gap width arrives in millimetres against a domain that works
 * in centimetres: uncorrected, a 120 mm gap would read as 120 cm and call a void
 * on every shelf with a fingersbreadth of space.
 *
 * ```json
 * {
 *   "eventType": "caper.frame",
 *   "version": 1,
 *   "frameId": "frm-4410",
 *   "tenant": "acme-grocery",
 *   "storeNumber": "acme-0042",
 *   "cart": { "cartId": "cart-3", "firmware": "4.2.1" },
 *   "capturedAtEpochMs": 1772442000000,
 *   "tripId": "trip-11",
 *   "detections": [
 *     { "facing": "acme-0042:a12:b3:s2:p1", "upc": "sku-oat-milk-64oz",
 *       "confidence": 0.85, "productVisible": false, "gapWidthMm": 180 }
 *   ]
 * }
 * ```
 */
export const caperAdapter: SourceAdapter<'caper_frame'> = {
  source: 'caper_frame',
  supportedWireVersions: ['caper.frame.v1'],

  wireVersion(payload: unknown): string | null {
    const root = wireObject(payload, '');
    const eventType = optional(root, 'eventType', str);
    const version = optional(root, 'version', int);
    return eventType === null || version === null ? null : `${eventType}.v${version}`;
  },

  decode(payload: unknown, context: DecodeContext): DetectionEventOf<'caper_frame'> {
    const root = wireObject(payload, '');
    const cart = obj(root, 'cart');

    return {
      envelope: envelopeFrom({
        source: 'caper_frame',
        producerEventId: str(root, 'frameId'),
        retailerId: retailerId(str(root, 'tenant')),
        storeId: storeId(str(root, 'storeNumber')),
        instanceId: str(cart, 'cartId'),
        softwareVersion: str(cart, 'firmware'),
        occurredAt: epochMillisInstant(root, 'capturedAtEpochMs'),
        // The cart buffers frames while it is out of Wi-Fi range and flushes on
        // reconnect, so emit time is whenever the broker took delivery.
        producedAt: context.record.timestamp,
        // The shopper trip, so a whole trip's frames can be quarantined together
        // when a cart's camera turns out to have been occluded.
        correlationId: optional(root, 'tripId', str),
      }),
      source: 'caper_frame',
      observations: objectsIn(root, 'detections').map((detection) => ({
        facingId: facingId(str(detection, 'facing')),
        confidence: ratio(detection, 'confidence'),
        productId: productId(str(detection, 'upc')),
        productVisible: bool(detection, 'productVisible'),
        gapWidthCm: nonNegativeNum(detection, 'gapWidthMm') / 10,
      })),
    };
  },
};
