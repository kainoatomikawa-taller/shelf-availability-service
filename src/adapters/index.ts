/**
 * Adapters — the outermost ring of the hexagon.
 *
 * The only layer allowed to know a producer's field names, a vendor's enum
 * spellings, a broker's record shape or a wire encoding. Everything inward of
 * here is expressed in the domain's own vocabulary, which is what lets a vendor
 * rename a field, change its units or ship a new payload version without a single
 * line changing in `src/domain` or `src/application`.
 *
 * Driving (inbound) — the outside world calling in:
 *  - `detection-stream/`  event-stream consumers for the five detection producers
 *
 * Driven (outbound) — this service calling out:
 *  - `esl/`  actuation adapters for the five shelf-edge fleets
 *
 * Read side — `reporting/` implements both inbound read ports over one retained
 * read model. It is filed on its own rather than under `inbound/` because it does
 * not call a port, it *is* the implementation behind two of them, and reads a
 * store to answer: an adapter on both edges of the hexagon at once.
 */
export * from './inbound/detection-stream/index.js';
export * from './outbound/esl/index.js';
export * from './reporting/index.js';
