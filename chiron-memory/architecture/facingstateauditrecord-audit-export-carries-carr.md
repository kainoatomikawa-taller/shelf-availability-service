---
id: f1821784-434c-4a25-9d5a-54bf9a6a0ed4-29
type: architecture
title: `FacingStateAuditRecord` (audit export) carries carry-in state, every timestamped…
tags: [architecture]
created: 2026-09-15
resource: src/ports/inbound/audit-export.port.ts, tests/ports-contract.test.ts.
---
`FacingStateAuditRecord` (audit export) carries carry-in state, every timestamped transition with its evidence, and the reported totals for a SKU/period.

## Why
Must be sufficient to reconstruct the reported availability index independently, and this is verified by a test that rebuilds a FacingTimeline from only what the record carries and runs it through the domain's `computeFacingAvailability`, asserting it matches `reportedIndex`; a companion test drops carry-in state and shows the answer changes, justifying why that field exists.

## Where
src/ports/inbound/audit-export.port.ts, tests/ports-contract.test.ts.
