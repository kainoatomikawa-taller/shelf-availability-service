import type { DetectionSource } from '../../../ports/inbound/detection-ingestion.port.js';
import type { AnySourceAdapter, SourceAdapter } from './source-adapter.js';
import { arpalusAdapter } from './sources/arpalus.js';
import { caperAdapter } from './sources/caper.js';
import { carrotTagsAdapter } from './sources/carrot-tags.js';
import { posMovementAdapter } from './sources/pos-movement.js';
import { shopperScanAdapter } from './sources/shopper-scan.js';

/**
 * Every detection source, and the adapter that reads its producer's dialect.
 *
 * A mapped type over `DetectionSource` rather than an array, so "consumers cover
 * all five sources" is checked by the compiler: a sixth detection source is a
 * type error here until someone writes its adapter, instead of a topic nobody
 * notices is unsubscribed until a retailer asks why their scans stopped landing.
 */
export const DETECTION_SOURCE_ADAPTERS: {
  readonly [S in DetectionSource]: SourceAdapter<S>;
} = {
  shopper_scan: shopperScanAdapter,
  arpalus_detection: arpalusAdapter,
  caper_frame: caperAdapter,
  carrot_tag_label: carrotTagsAdapter,
  pos_movement: posMovementAdapter,
};

export const ALL_SOURCE_ADAPTERS: readonly AnySourceAdapter[] =
  Object.values(DETECTION_SOURCE_ADAPTERS);
