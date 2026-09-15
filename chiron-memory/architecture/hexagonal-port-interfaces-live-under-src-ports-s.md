---
id: f1821784-434c-4a25-9d5a-54bf9a6a0ed4-18
type: architecture
title: Hexagonal port interfaces live under src/ports/, split into inbound/, outbound/, and…
tags: [architecture]
created: 2026-09-15
resource: src/ports/index.ts, src/ports/inbound/, src/ports/outbound/, src/ports/common/.
---
Hexagonal port interfaces live under src/ports/, split into inbound/, outbound/, and common/ subdirectories, re-exported from src/ports/index.ts.

## Why
Separates the ingestion/reporting/audit boundary (inbound) from actuation (outbound) and shared primitives (common), keeping ports interface-only and free of implementation.

## Where
src/ports/index.ts, src/ports/inbound/, src/ports/outbound/, src/ports/common/.
