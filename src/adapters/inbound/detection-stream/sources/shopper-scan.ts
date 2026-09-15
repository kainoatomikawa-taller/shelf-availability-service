import { facingId, productId, retailerId, shopperId, storeId } from '../../../../domain/common/ids.js';
import type {
  DetectionEventOf,
  ShopperScanObservation,
} from '../../../../ports/inbound/detection-ingestion.port.js';
import { envelopeFrom, type DecodeContext, type SourceAdapter } from '../source-adapter.js';
import {
  int,
  isoInstant,
  mapped,
  obj,
  optional,
  ratio,
  str,
  wireObject,
} from '../wire.js';

/** Pick outcomes as the shopper app spells them. */
const SCAN_RESULTS: Readonly<Record<string, ShopperScanObservation['outcome']>> = {
  FOUND: 'found',
  NOT_FOUND: 'not_found',
  // The app calls it a replacement; the domain calls it a substitution. Both mean
  // the shopper stood at the shelf and could not pick what was ordered, which is
  // the strongest out-of-stock evidence this service receives.
  REPLACED: 'substituted',
};

/**
 * Instacart shopper item scans.
 *
 * The only source with a human at the shelf, and the only one that reports a
 * single facing per event: a shopper scans one item at a time. It is wrapped into
 * an array of one rather than given its own single-observation event shape,
 * because a producer-specific shape at the port would be the boundary bending to
 * a producer — precisely the coupling this layer exists to prevent.
 *
 * ```json
 * {
 *   "type": "pick.item_scan",
 *   "v": 3,
 *   "scan_id": "scan-abc",
 *   "retailer_id": "acme-grocery",
 *   "store_id": "acme-0042",
 *   "order_id": "ord-77",
 *   "shopper": { "id": "shopper-9", "app_build": "ios-2026.9.1" },
 *   "scanned_at": "2026-03-02T09:00:00.000Z",
 *   "item": { "facing_id": "acme-0042:a12:b3:s2:p1", "product_id": "sku-oat-milk-64oz",
 *             "result": "NOT_FOUND", "confidence": 0.95 }
 * }
 * ```
 */
export const shopperScanAdapter: SourceAdapter<'shopper_scan'> = {
  source: 'shopper_scan',
  supportedWireVersions: ['pick.item_scan.v3'],

  wireVersion(payload: unknown): string | null {
    const root = wireObject(payload, '');
    const type = optional(root, 'type', str);
    const version = optional(root, 'v', int);
    return type === null || version === null ? null : `${type}.v${version}`;
  },

  decode(payload: unknown, context: DecodeContext): DetectionEventOf<'shopper_scan'> {
    const root = wireObject(payload, '');
    const shopper = obj(root, 'shopper');
    const item = obj(root, 'item');

    return {
      envelope: envelopeFrom({
        source: 'shopper_scan',
        producerEventId: str(root, 'scan_id'),
        retailerId: retailerId(str(root, 'retailer_id')),
        storeId: storeId(str(root, 'store_id')),
        // The shopper's handset, which is what a bad app rollout is isolated by.
        instanceId: str(shopper, 'id'),
        softwareVersion: str(shopper, 'app_build'),
        occurredAt: isoInstant(root, 'scanned_at'),
        // The app queues scans while the shopper is between aisles on bad signal.
        producedAt: optional(root, 'sent_at', isoInstant) ?? context.record.timestamp,
        // The order being picked, so a run of not-founds can be read as one trip.
        correlationId: optional(root, 'order_id', str),
      }),
      source: 'shopper_scan',
      observations: [
        {
          facingId: facingId(str(item, 'facing_id')),
          confidence: ratio(item, 'confidence'),
          shopperId: shopperId(str(shopper, 'id')),
          productId: productId(str(item, 'product_id')),
          outcome: mapped(item, 'result', SCAN_RESULTS),
        },
      ],
    };
  },
};
