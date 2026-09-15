/**
 * The reporting adapter — one implementation behind both read ports.
 *
 * `ReportingAdapter` serves `ReportingPort` (the availability index, per-facing
 * records, and the three loop-outcome metrics) and `AuditExportPort` (the facing
 * state log, the action trail and sealed artifacts) from one retained read model,
 * so the figure in a report and the artifact that substantiates it are the same
 * arithmetic over the same events.
 */
export * from './read-model.js';
export * from './paging.js';
export * from './availability.js';
export * from './artifacts.js';
export * from './reporting.adapter.js';
