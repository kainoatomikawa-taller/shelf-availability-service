---
id: b2e7ca83-fe96-4ba2-94dc-5d5ff8ab2099-6
type: architecture
title: `AuditExportPort` produces an attestable export of the retained event log, and…
tags: [architecture]
created: 2026-09-16
resource: src/ports/inbound/audit-export.port.ts, src/adapters/reporting/artifacts.ts.
---
`AuditExportPort` produces an attestable export of the retained event log, and `FacingStateAuditRecord`/audit artifacts must carry enough carried-in state to let a FacingTimeline be rebuilt from only what the export contains, independent of any live domain computation.

## Where
src/ports/inbound/audit-export.port.ts, src/adapters/reporting/artifacts.ts.
