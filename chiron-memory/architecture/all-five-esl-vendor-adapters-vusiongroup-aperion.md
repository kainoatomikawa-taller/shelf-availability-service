---
id: e296a351-330a-4e25-910f-e33a1630cbb5-3
type: architecture
title: All five ESL vendor adapters (VusionGroup, Aperion, Solum, Pricer, Hashow) share one…
tags: [architecture]
created: 2026-09-15
resource: src/adapters/outbound/esl/fleet-adapter.ts, src/adapters/outbound/esl/vendors/*.ts, src/adapters/outbound/esl/registry.ts
---
All five ESL vendor adapters (VusionGroup, Aperion, Solum, Pricer, Hashow) share one policy engine (fleet-adapter.ts) — degradation ladder walk, per-(taskId, facingId) leasing/idempotency, batch limits, per-tag command interval — and differ only via a per-vendor EslVendorProfile (tag-model catalogue, wire dialect, refusal codes)

## Why
keeps a sixth vendor a data table addition instead of a copy-pasted lease/idempotency implementation

## Where
src/adapters/outbound/esl/fleet-adapter.ts, src/adapters/outbound/esl/vendors/*.ts, src/adapters/outbound/esl/registry.ts
