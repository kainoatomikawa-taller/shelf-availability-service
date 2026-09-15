import { DETECTION_SOURCES, type DetectionSource } from '../../../ports/inbound/detection-ingestion.port.js';

/**
 * Topic naming for the detection stream.
 *
 * One topic per source rather than one shared topic with a discriminator field,
 * for two reasons that both bite in production: a vendor shipping a bad build
 * poisons only its own topic and its own consumer lag, and per-source retention
 * and partition counts can differ — POS movement is hourly and small, Caper frames
 * are continuous and large.
 *
 * Derived from `DETECTION_SOURCES` so a sixth source cannot be added without a
 * topic, and so the name in the broker and the discriminant in the code cannot
 * drift apart.
 */
export const DETECTION_TOPIC_PREFIX = 'osa.detections';

export const detectionTopic = (source: DetectionSource): string =>
  `${DETECTION_TOPIC_PREFIX}.${source}`;

export const DETECTION_TOPICS: readonly string[] = DETECTION_SOURCES.map(detectionTopic);

/**
 * The partition key every producer must publish under.
 *
 * Published here so the contract is stated once and in the same module the
 * consumer checks it from: keying by retailer is what makes per-retailer ordering
 * a property of the transport rather than something the service has to reconstruct.
 */
export const partitionKeyFor = (retailerId: string): string => retailerId;
