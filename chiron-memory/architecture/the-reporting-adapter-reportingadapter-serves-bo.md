---
id: e296a351-330a-4e25-910f-e33a1630cbb5-4
type: architecture
title: The reporting adapter (ReportingAdapter) serves both ReportingPort and AuditExportPort…
tags: [architecture]
created: 2026-09-15
resource: src/adapters/reporting/reporting.adapter.ts, src/adapters/reporting/read-model.ts
---
The reporting adapter (ReportingAdapter) serves both ReportingPort and AuditExportPort from a single ReportingReadModel, and every reported figure delegates to the same domain/application computations (computeAvailabilityIndex, outcome-metrics) used elsewhere

## Why
guarantees the published report and the audit artifact that substantiates it are always the same arithmetic over the same events; an auditor recomputing from the export must land on the same number as the report

## Where
src/adapters/reporting/reporting.adapter.ts, src/adapters/reporting/read-model.ts
