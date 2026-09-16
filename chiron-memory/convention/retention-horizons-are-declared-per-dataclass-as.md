---
id: 63094f91-5ed0-4b9a-80ca-784123f72f65-4
type: convention
title: Retention horizons are declared per `DataClass` as a TypeScript mapped type in…
tags: [convention]
created: 2026-09-16
resource: src/platform/retention.ts
---
Retention horizons are declared per `DataClass` as a TypeScript mapped type in src/platform/retention.ts.

## Why
A new `DataClass` added without a retention horizon becomes a compile error, forcing an explicit retention decision rather than defaulting silently.

## Learned
There's a coherence ladder plus a bridge to the existing `AuditRetentionPolicy` port type so retention rules stay consistent across data classes.

## Where
src/platform/retention.ts
