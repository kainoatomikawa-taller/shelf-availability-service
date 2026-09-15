---
id: bd3545d9-c982-4453-b7da-b4a543c2ec35-10
type: architecture
title: ReportDimension (inbound reporting port) gained a 'department' member, and a narrower…
tags: [architecture]
created: 2026-09-15
resource: src/ports/inbound/reporting.port.ts, src/application/outcome-metrics.ts
---
ReportDimension (inbound reporting port) gained a 'department' member, and a narrower OutcomeDimension type restricts outcome-metric breakdowns to only the dimensions an outcome record can actually key on

## Why
resolved-gap-rate-by-department was required by the task but the reporting port only had category before; the narrower type makes requesting an unsupported breakdown (e.g. aisle) a compile-time error instead of a silently empty result

## Where
src/ports/inbound/reporting.port.ts, src/application/outcome-metrics.ts
