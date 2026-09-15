import type { RetailerId } from '../../../domain/common/ids.js';
import {
  DETECTION_SOURCES,
  type DetectionSource,
} from '../../../ports/inbound/detection-ingestion.port.js';

/**
 * Topic naming for the detection stream.
 *
 * Two axes, both of them load-bearing.
 *
 * **Per retailer**, because a topic is the smallest thing a broker can put an ACL,
 * a retention setting and a quota on. One topic per source with a retailer
 * partition key would give ordering but nothing else: every producer credential
 * would be able to read every retailer's shelf data, and a single misrouted
 * publish would be a cross-tenant leak that only application code could catch. A
 * retailer-scoped topic makes isolation the broker's job — `osa.<retailer>.*` is
 * exactly one tenant's namespace, and a credential scoped to that prefix cannot
 * name another tenant's topic at all.
 *
 * **Per source**, because a vendor shipping a bad build then poisons only its own
 * topic and its own consumer lag, and because per-source retention and partition
 * counts genuinely differ — POS movement is hourly and small, Caper frames are
 * continuous and large.
 *
 * The source segment is derived from `DETECTION_SOURCES`, so a sixth source
 * cannot be added without a topic, and the name in the broker and the
 * discriminant in the code cannot drift apart. The retailer segment comes from
 * the tenant registry (`src/platform/tenancy.ts`), which is where the stricter
 * slug rules live; what is enforced here is only this grammar's own rule — one
 * segment, no separator inside it — because a segment containing a dot would
 * silently re-parse as a different retailer.
 */

/** Root of every topic this service owns. */
export const TOPIC_NAMESPACE = 'osa';

/** The segment that marks a retailer's detection topics apart from anything else in their namespace. */
export const DETECTION_SEGMENT = 'detections';

/** The segment carrying records that could not be turned into detection events. */
export const DEAD_LETTER_SEGMENT = 'dead-letters';

const SEGMENT_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Rejects a retailer segment that would break the grammar.
 *
 * Deliberately a throw rather than a sanitised fallback: silently rewriting
 * `acme.eu` to `acme_eu` would route two tenants' producers onto one topic, which
 * is the exact outcome the per-retailer split exists to prevent.
 */
export const assertTopicSegment = (segment: string, what: string): string => {
  if (!SEGMENT_PATTERN.test(segment)) {
    throw new TypeError(
      `${what} must be one lower-case topic segment matching ${SEGMENT_PATTERN.source}, got "${segment}"`,
    );
  }
  return segment;
};

/**
 * Every topic belonging to one retailer, as a prefix.
 *
 * The unit an ACL is granted on: a producer credential scoped here can publish to
 * its own retailer's topics and cannot name another's.
 */
export const retailerTopicPrefix = (retailer: string): string =>
  `${TOPIC_NAMESPACE}.${assertTopicSegment(retailer, 'retailer topic segment')}.`;

export const detectionTopic = (retailer: string, source: DetectionSource): string =>
  `${retailerTopicPrefix(retailer)}${DETECTION_SEGMENT}.${source}`;

export const deadLetterTopic = (retailer: string, source: DetectionSource): string =>
  `${retailerTopicPrefix(retailer)}${DEAD_LETTER_SEGMENT}.${source}`;

/** One retailer's detection topics; every source unless the retailer runs fewer. */
export const detectionTopicsFor = (
  retailer: string,
  sources: readonly DetectionSource[] = DETECTION_SOURCES,
): readonly string[] => sources.map((source) => detectionTopic(retailer, source));

export interface ParsedDetectionTopic {
  readonly retailer: string;
  readonly source: DetectionSource;
}

const isDetectionSource = (value: string): value is DetectionSource =>
  (DETECTION_SOURCES as readonly string[]).includes(value);

/**
 * Reads a topic name back into the retailer and source it encodes, or `null` if
 * it is not one of ours.
 *
 * `null` rather than a throw: an unexpected topic is an operational fact — a
 * pattern subscription that matched too much, a stale runner — and the consumer's
 * answer to it is a dead letter, not a crash.
 */
export const parseDetectionTopic = (topic: string): ParsedDetectionTopic | null => {
  const segments = topic.split('.');
  if (segments.length !== 4) return null;
  const [namespace, retailer, kind, source] = segments as [string, string, string, string];
  if (namespace !== TOPIC_NAMESPACE || kind !== DETECTION_SEGMENT) return null;
  if (!SEGMENT_PATTERN.test(retailer) || !isDetectionSource(source)) return null;
  return { retailer, source };
};

/**
 * One topic the consumer reads, and what the broker has already established about
 * everything on it.
 *
 * The consumer is handed these rather than parsing names, so the retailer a topic
 * belongs to is a deployment fact carried in the wiring instead of a string
 * convention re-derived at runtime — and so a renamed topic is a wiring change
 * rather than a silent mis-attribution.
 */
export interface DetectionSubscription {
  readonly topic: string;
  readonly source: DetectionSource;
  /** The only retailer whose events may legitimately appear on this topic. */
  readonly retailerId: RetailerId;
}

/**
 * The partition key every producer must publish under.
 *
 * Stated here so the contract lives in the same module the consumer checks it
 * from. Within a retailer's topic the key is what keeps one retailer's events on
 * one broker partition and therefore in order; across retailers the topic name
 * already did that job.
 */
export const partitionKeyFor = (retailerId: string): string => retailerId;
