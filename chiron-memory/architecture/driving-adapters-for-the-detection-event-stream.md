---
id: 6bca2d8e-090d-4cdb-b6be-be784bcbf93a-0
type: architecture
title: Driving adapters for the detection event stream live in a new…
tags: [architecture]
created: 2026-09-15
---
Driving adapters for the detection event stream live in a new `src/adapters/inbound/detection-stream/` package (source-specific adapters in `sources/*.ts`, plus `consumer.ts`, `registry.ts`, `wire.ts`, `topics.ts`, `signal-ids.ts`) and drive two new outbound ports, `EventStreamConsumerPort` and `DeadLetterPort` (in `src/ports/outbound/`).

## Why
This is the outermost ring of the hexagon — it adapts each upstream producer's wire format to the layer-owned event schema and feeds the existing `DetectionIngestionService` use case, rather than requiring producers to conform to the domain shape.
