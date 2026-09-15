/**
 * Application layer — the use cases that drive the domain across the hexagonal
 * boundary.
 *
 * Thin by design. Everything that decides what a signal means, what a transition
 * is, or what a gap is worth lives in `src/domain`; what lives here is the
 * sequencing between the ports and that logic — normalize, fold, persist, rank.
 * Anything in this directory that starts making a judgement call belongs one
 * layer down.
 */
export * from './signal-normalization.js';
export * from './detection-ingestion.service.js';
export * from './rank-gaps.use-case.js';
export * from './create-tasks.use-case.js';
export * from './verification-loop.use-case.js';
export * from './outcome-metrics.js';
export * from './availability-baseline.use-case.js';
