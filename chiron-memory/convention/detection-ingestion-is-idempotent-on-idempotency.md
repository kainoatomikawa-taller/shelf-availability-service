---
id: f1821784-434c-4a25-9d5a-54bf9a6a0ed4-21
type: convention
title: Detection ingestion is idempotent on `idempotencyKey`, events are ordered by…
tags: [convention]
created: 2026-09-15
resource: src/ports/inbound/detection-ingestion.port.ts.
---
Detection ingestion is idempotent on `idempotencyKey`, events are ordered by `occurredAt`, and batches are single-partition by construction.

## Where
src/ports/inbound/detection-ingestion.port.ts.
