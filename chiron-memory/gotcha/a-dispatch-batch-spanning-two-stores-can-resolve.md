---
id: e296a351-330a-4e25-910f-e33a1630cbb5-9
type: gotcha
title: A dispatch batch spanning two stores can resolve tag bindings against the wrong…
tags: [gotcha]
created: 2026-09-15
resource: src/adapters/outbound/esl/fleet-adapter.ts
---
A dispatch batch spanning two stores can resolve tag bindings against the wrong store/building if store scoping isn't enforced per-command inside the batch resolver

## Learned
fixed during self-review; batch processing must partition/validate store scope per item, not assume batch-level uniformity.

## Where
src/adapters/outbound/esl/fleet-adapter.ts
