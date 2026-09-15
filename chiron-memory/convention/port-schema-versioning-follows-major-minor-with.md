---
id: f1821784-434c-4a25-9d5a-54bf9a6a0ed4-22
type: convention
title: Port schema versioning follows major.minor with a declared sunset window, published at…
tags: [convention]
created: 2026-09-15
resource: src/ports/inbound/detection-ingestion.port.ts, src/ports/inbound/audit-export.port.ts.
---
Port schema versioning follows major.minor with a declared sunset window, published at runtime via a `describeSchemaContract()` function on each port.

## Where
src/ports/inbound/detection-ingestion.port.ts, src/ports/inbound/audit-export.port.ts.
