---
id: 6bca2d8e-090d-4cdb-b6be-be784bcbf93a-1
type: convention
title: `DETECTION_SOURCE_ADAPTERS` is a mapped type over the `DetectionSource` union, one…
tags: [convention]
created: 2026-09-15
resource: `src/adapters/inbound/detection-stream/registry.ts`.
---
`DETECTION_SOURCE_ADAPTERS` is a mapped type over the `DetectionSource` union, one adapter per source (Arpalus, Caper, Carrot Tags, POS, shopper scan).

## Why
Adding a sixth source without writing its adapter becomes a TypeScript compile error, instead of a topic silently going unconsumed.

## Where
`src/adapters/inbound/detection-stream/registry.ts`.
