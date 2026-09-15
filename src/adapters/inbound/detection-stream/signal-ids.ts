import { signalId, type SignalId } from '../../../domain/common/ids.js';
import type {
  DetectionEventEnvelope,
  DetectionSource,
} from '../../../ports/inbound/detection-ingestion.port.js';

/**
 * Signal ids for events that arrived off the stream.
 *
 * Derived entirely from the envelope and the observation's position, never from a
 * counter or a clock, because redelivery is normal at this boundary. A random id
 * would make the same Arpalus scan produce different signals on its second
 * delivery, and the facing history — which dedupes on what it has already seen —
 * would fork rather than recognise the replay.
 *
 * Wire this into `DetectionIngestionService` whenever its events come from the
 * stream; the service takes the minting function as a dependency precisely so the
 * driving adapter gets to decide what "the same event twice" means.
 */
export const streamSignalId = (
  envelope: DetectionEventEnvelope,
  source: DetectionSource,
  index: number,
): SignalId => signalId(`${source}:${envelope.eventId}#${index}`);
