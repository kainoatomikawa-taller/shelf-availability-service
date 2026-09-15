---
id: ebdcf5b4-01ca-4940-9da8-272aa1a78dd3-11
type: architecture
title: signal-normalization.ts exports two functions derived from the same wire event
tags: [architecture]
created: 2026-09-15
resource: src/application/signal-normalization.ts
---
signal-normalization.ts exports two functions derived from the same wire event: `normalizeDetectionEvent` (event → domain signals) and `passesFromDetectionEvent` (event → density-measurement pass records)

## Why
the same envelope that yields signals for the facing history also yields the pass records revisit-density needs, so both are derived once from one incoming event rather than recomputed separately

## Where
src/application/signal-normalization.ts
