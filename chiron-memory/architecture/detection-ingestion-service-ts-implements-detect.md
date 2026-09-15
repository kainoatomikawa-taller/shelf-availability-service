---
id: ebdcf5b4-01ca-4940-9da8-272aa1a78dd3-6
type: architecture
title: `detection-ingestion.service.ts` implements DetectionIngestionPort by first loading every…
tags: [architecture]
created: 2026-09-15
resource: src/application/detection-ingestion.service.ts
---
`detection-ingestion.service.ts` implements DetectionIngestionPort by first loading every facing an incoming event batch touches, then applying all signals via recordSignal, then writing to the idempotency ledger only after the aggregates are updated

## Why
loading all facings up front means a rejection can't leave a batch half-applied; writing the ledger last means a replayed event is a safe no-op (history is transition-only) while a dropped observation never silently disappears

## Where
src/application/detection-ingestion.service.ts
