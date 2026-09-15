---
id: f1821784-434c-4a25-9d5a-54bf9a6a0ed4-3
type: architecture
title: SignalSnapshot is a mapped type over the six-member SignalSource union (shopper scan,…
tags: [architecture]
created: 2026-09-15
resource: src/domain/facing/shelf-state.ts, src/domain/facing/facing.ts
---
SignalSnapshot is a mapped type over the six-member SignalSource union (shopper scan, Arpalus, Caper, planogram, Carrot Tags, POS)

## Why
makes it a compile error to add a seventh signal source without every Facing gaining a slot for it

## Where
src/domain/facing/shelf-state.ts, src/domain/facing/facing.ts
