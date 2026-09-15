import { carrotTagId, facingId, retailerId, storeId } from '../../../../domain/common/ids.js';
import { toISO } from '../../../../domain/common/time.js';
import { CERTAIN } from '../../../../domain/facing/signals.js';
import type { LedColor } from '../../../../domain/task/color-lane.js';
import type {
  CarrotTagLabelObservation,
  DetectionEventOf,
} from '../../../../ports/inbound/detection-ingestion.port.js';
import { envelopeFrom, type DecodeContext, type SourceAdapter } from '../source-adapter.js';
import {
  WireViolationError,
  decimalAsCents,
  isoInstant,
  mapped,
  obj,
  objectsIn,
  optional,
  str,
  wireObject,
} from '../wire.js';

/** Gateway status codes to the label states the domain models. */
const LABEL_STATES: Readonly<Record<string, CarrotTagLabelObservation['labelState']>> = {
  OK: 'nominal',
  PRICE_MISMATCH: 'price_mismatch',
  UNBOUND: 'unbound',
  BATTERY_LOW: 'battery_low',
  OFFLINE: 'offline',
};

/**
 * Lamp codes to LED colours. `OFF` is a lit lane of `null` rather than a colour —
 * a dark tag is a real, distinct state, not a missing reading.
 */
const LAMPS: Readonly<Record<string, LedColor | null>> = {
  OFF: null,
  RED: 'red',
  AMBER: 'amber',
  GREEN: 'green',
  BLUE: 'blue',
  PURPLE: 'purple',
  CYAN: 'cyan',
  WHITE: 'white',
  PINK: 'pink',
  TEAL: 'teal',
};

/**
 * Carrot Tags electronic-label state sweeps.
 *
 * The gateway polls every tag it owns and reports what each one is displaying, so
 * this source tells us about label health and which lane a tag is currently lit
 * for — never about stock. `interpretSignal` returns `no_stock_evidence` for it
 * by design; it is here because a price mismatch or an unbound tag is a task, and
 * because a lit lane is how the closed loop reads back what it asked for.
 *
 * Three adaptations. The gateway mints no event id, so one is derived from the
 * sweep reference — or, failing that, from the gateway and its observation
 * instant — which is what makes a replayed sweep dedupe instead of re-applying.
 * Price arrives as a decimal string in major units and the domain holds integer
 * cents. And confidence is not reported at all: a tag reporting its own display
 * is not inferring anything, so it is `CERTAIN` rather than a number invented here.
 *
 * ```json
 * {
 *   "msg_type": "label_state",
 *   "proto": "carrot/3",
 *   "gateway": { "id": "gw-2", "fw": "9.0.3" },
 *   "retailer_code": "acme-grocery",
 *   "store_code": "acme-0042",
 *   "observed": "2026-03-02T09:00:00.000Z",
 *   "sweep_ref": "sweep-5",
 *   "labels": [
 *     { "tag": "tag-551", "facing": "acme-0042:a12:b3:s2:p1",
 *       "status": "PRICE_MISMATCH", "price": "5.99", "lamp": "RED" }
 *   ]
 * }
 * ```
 */
export const carrotTagsAdapter: SourceAdapter<'carrot_tag_label'> = {
  source: 'carrot_tag_label',
  supportedWireVersions: ['carrot/3'],

  wireVersion(payload: unknown): string | null {
    const root = wireObject(payload, '');
    return optional(root, 'proto', str);
  },

  decode(payload: unknown, context: DecodeContext): DetectionEventOf<'carrot_tag_label'> {
    const root = wireObject(payload, '');

    // The topic carries one message type; anything else on it is a routing bug
    // upstream, and guessing at its shape would be worse than dead-lettering it.
    const messageType = str(root, 'msg_type');
    if (messageType !== 'label_state') {
      throw new WireViolationError(
        'msg_type',
        `expected "label_state" on the label-state topic, got "${messageType}"`,
      );
    }

    const gateway = obj(root, 'gateway');
    const gatewayId = str(gateway, 'id');
    const observedAt = isoInstant(root, 'observed');
    const sweepRef = optional(root, 'sweep_ref', str);

    return {
      envelope: envelopeFrom({
        source: 'carrot_tag_label',
        producerEventId: sweepRef ?? `${gatewayId}@${toISO(observedAt)}`,
        retailerId: retailerId(str(root, 'retailer_code')),
        storeId: storeId(str(root, 'store_code')),
        instanceId: gatewayId,
        softwareVersion: str(gateway, 'fw'),
        occurredAt: observedAt,
        // The gateway reports no emit time of its own; the broker's append time
        // is the only honest answer, and it is used for latency reporting alone.
        producedAt: context.record.timestamp,
        correlationId: sweepRef,
      }),
      source: 'carrot_tag_label',
      observations: objectsIn(root, 'labels').map((label) => ({
        facingId: facingId(str(label, 'facing')),
        // A tag reporting its own display is not inferring anything.
        confidence: CERTAIN,
        tagId: carrotTagId(str(label, 'tag')),
        labelState: mapped(label, 'status', LABEL_STATES),
        displayedPriceCents: decimalAsCents(label, 'price'),
        litLane: mapped(label, 'lamp', LAMPS),
      })),
    };
  },
};
