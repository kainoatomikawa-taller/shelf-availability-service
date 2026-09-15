/**
 * Detection-stream consumers — the driving adapters for all five detection sources.
 *
 * One `SourceAdapter` per producer translates that vendor's dialect into the
 * layer-owned event schema; one `DetectionStreamConsumer` reads the stream and
 * drives `DetectionIngestionPort` with the result. The dependency runs one way:
 * the adapters know about the producers, and no producer knows about us.
 *
 * `wire.ts` is deliberately not re-exported. Its combinators are named for
 * reading (`str`, `num`, `obj`, `optional`), which is right inside an adapter and
 * wrong in a package's public namespace; only the error type crosses the boundary.
 */
export { WireViolationError } from './wire.js';

export * from './source-adapter.js';
export * from './topics.js';
export * from './registry.js';
export * from './signal-ids.js';
export * from './consumer.js';

export { arpalusAdapter } from './sources/arpalus.js';
export { caperAdapter } from './sources/caper.js';
export { carrotTagsAdapter } from './sources/carrot-tags.js';
export { posMovementAdapter } from './sources/pos-movement.js';
export { shopperScanAdapter } from './sources/shopper-scan.js';
