---
id: f1821784-434c-4a25-9d5a-54bf9a6a0ed4-19
type: decision
title: DetectionSource (the five ingestion source types) is derived as `Exclude<SignalSource,…
tags: [decision]
created: 2026-09-15
resource: src/ports/inbound/detection-ingestion.port.ts.
---
DetectionSource (the five ingestion source types) is derived as `Exclude<SignalSource, 'planogram_record'>` rather than listed independently.

## Why
A planogram record is authored reference data on a merchandising cadence, not an observation of a shelf, so it is deliberately excluded from detection ingestion; deriving by exclusion forces an explicit decision if a new signal source is ever added.

## Where
src/ports/inbound/detection-ingestion.port.ts.
