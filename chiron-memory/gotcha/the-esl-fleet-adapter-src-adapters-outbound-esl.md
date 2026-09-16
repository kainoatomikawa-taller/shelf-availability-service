---
id: 63094f91-5ed0-4b9a-80ca-784123f72f65-8
type: gotcha
title: The ESL fleet adapter (`src/adapters/outbound/esl/fleet-adapter.ts`) holds per-instance…
tags: [gotcha]
created: 2026-09-16
resource: src/platform/container.ts (memoizes the adapter per store), src/adapters/outbound/esl/fleet-adapter.ts
---
The ESL fleet adapter (`src/adapters/outbound/esl/fleet-adapter.ts`) holds per-instance state — active expression leases and per-tag command rate-limit intervals — in its own class fields.

## Why
Building a fresh adapter instance per call (instead of memoizing one per store) would silently drop both the lease state and the rate limiter, which is a correctness bug that wouldn't show up until production load.

## Learned
When wiring DI containers for adapters that hold mutable in-memory state, check whether the adapter needs per-scope memoization rather than per-request construction.

## Where
src/platform/container.ts (memoizes the adapter per store), src/adapters/outbound/esl/fleet-adapter.ts
