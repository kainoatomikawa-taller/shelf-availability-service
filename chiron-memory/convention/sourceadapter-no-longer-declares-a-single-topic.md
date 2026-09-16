---
id: 63094f91-5ed0-4b9a-80ca-784123f72f65-10
type: convention
title: `SourceAdapter` no longer declares a single `topic` field.
tags: [convention]
created: 2026-09-16
resource: src/adapters/inbound/detection-stream/source-adapter.ts, src/adapters/inbound/detection-stream/topics.ts.
---
`SourceAdapter` no longer declares a single `topic` field.

## Why
Since topics are now per-retailer as well as per-source, there is no single topic name a source adapter could meaningfully own — topic names are derived per retailer via `detectionTopic(slug, source)` instead.

## Where
src/adapters/inbound/detection-stream/source-adapter.ts, src/adapters/inbound/detection-stream/topics.ts.
