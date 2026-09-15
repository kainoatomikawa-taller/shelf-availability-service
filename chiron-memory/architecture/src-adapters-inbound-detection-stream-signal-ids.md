---
id: 6bca2d8e-090d-4cdb-b6be-be784bcbf93a-8
type: architecture
title: `src/adapters/inbound/detection-stream/signal-ids.ts` is a dedicated module for deriving…
tags: [architecture]
created: 2026-09-15
resource: `src/adapters/inbound/detection-stream/signal-ids.ts`, `topics.ts`, `registry.ts`.
---
`src/adapters/inbound/detection-stream/signal-ids.ts` is a dedicated module for deriving event/signal ids for sources whose payloads don't carry their own id (Carrot Tags), separate from `topics.ts` (maps each `DetectionSource` to its stream topic name) and `registry.ts` (maps each source to its adapter).

## Why
Keeps id-derivation logic reusable/testable in one place instead of duplicated inline inside the Carrot Tags adapter, and keeps topic-naming changes from touching adapter-selection logic.

## Where
`src/adapters/inbound/detection-stream/signal-ids.ts`, `topics.ts`, `registry.ts`.
