/**
 * Hexagonal boundary of the on-shelf availability service.
 *
 * Interfaces and contract constants only — no behaviour, no adapters. Every port
 * is expressed in terms of the domain entities in `src/domain`, so the boundary
 * cannot describe a concept the domain does not have.
 *
 * Inbound (driving) — what the outside world asks of this service:
 *  - `DetectionIngestionPort`  detection events from the five shelf-observing producers
 *  - `AvailabilityQueryPort` / `TaskPerformanceQueryPort`  the read side
 *  - `AuditExportPort`  attestable export of the retained event log
 *
 * Outbound (driven) — what this service asks of the outside world:
 *  - `EslActuationPort`  expressing a task at the shelf edge
 *  - `FacingRepositoryPort` / `IngestionLedgerPort`  the state the use cases fold over
 */
export * from './common/paging.js';
export * from './common/schema-contract.js';

export * from './inbound/detection-ingestion.port.js';
export * from './inbound/reporting.port.js';
export * from './inbound/audit-export.port.js';

export * from './outbound/esl-actuation.port.js';
export * from './outbound/facing-repository.port.js';
export * from './outbound/ingestion-ledger.port.js';
