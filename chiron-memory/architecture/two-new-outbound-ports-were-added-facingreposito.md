---
id: ebdcf5b4-01ca-4940-9da8-272aa1a78dd3-8
type: architecture
title: Two new outbound ports were added
tags: [architecture]
created: 2026-09-15
resource: src/ports/outbound/facing-repository.port.ts, src/ports/outbound/ingestion-ledger.port.ts
---
Two new outbound ports were added — FacingRepositoryPort (load/save facing aggregates) and IngestionLedgerPort (idempotency tracking for ingested events) — both interface-only in src/ports/outbound/

## Why
needed to let the application-layer ingestion service and gap-ranking use case depend on abstractions rather than a concrete store

## Where
src/ports/outbound/facing-repository.port.ts, src/ports/outbound/ingestion-ledger.port.ts
