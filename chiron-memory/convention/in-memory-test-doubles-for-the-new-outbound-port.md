---
id: ebdcf5b4-01ca-4940-9da8-272aa1a78dd3-12
type: convention
title: In-memory test doubles for the new outbound ports (FacingRepositoryPort,…
tags: [convention]
created: 2026-09-15
resource: tests/support/in-memory-ports.ts
---
In-memory test doubles for the new outbound ports (FacingRepositoryPort, IngestionLedgerPort) live in tests/support/in-memory-ports.ts

## Why
lets application-layer services (detection-ingestion, rank-gaps) be tested without real infrastructure

## Where
tests/support/in-memory-ports.ts
