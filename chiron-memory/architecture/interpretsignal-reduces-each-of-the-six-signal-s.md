---
id: f1821784-434c-4a25-9d5a-54bf9a6a0ed4-4
type: architecture
title: interpretSignal reduces each of the six signal sources to shelf evidence under a tunable…
tags: [architecture]
created: 2026-09-15
resource: src/domain/facing/interpretation.ts, src/domain/facing/event-history.ts
---
interpretSignal reduces each of the six signal sources to shelf evidence under a tunable policy, and recordSignal folds that into an append-only, time-ordered event history that records only in-stock/out-of-stock transitions

## Where
src/domain/facing/interpretation.ts, src/domain/facing/event-history.ts
