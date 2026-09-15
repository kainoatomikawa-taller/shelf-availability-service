---
id: f1821784-434c-4a25-9d5a-54bf9a6a0ed4-26
type: architecture
title: Reporting is split into `AvailabilityQueryPort` (index + per-facing records) and…
tags: [architecture]
created: 2026-09-15
resource: src/ports/inbound/reporting.port.ts.
---
Reporting is split into `AvailabilityQueryPort` (index + per-facing records) and `TaskPerformanceQueryPort` (work rate, resolved-gap rate, detection-to-resolution), composed together by a single `ReportingPort` for callers wanting the whole read side.

## Why
Split by cohesion rather than exposing one fat port.

## Where
src/ports/inbound/reporting.port.ts.
