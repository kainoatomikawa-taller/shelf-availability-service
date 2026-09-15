---
id: e296a351-330a-4e25-910f-e33a1630cbb5-5
type: decision
title: Audit artifacts are canonically serialised and content-addressed by sha-256
tags: [decision]
created: 2026-09-15
resource: src/adapters/reporting/artifacts.ts
---
Audit artifacts are canonically serialised and content-addressed by sha-256

## Why
re-sealing an already-closed reporting period must be idempotent — it should return the identical bytes and identical artifact id, not a new one

## Where
src/adapters/reporting/artifacts.ts
