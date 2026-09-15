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
 */
export * from './inbound/detection-stream/index.js';
