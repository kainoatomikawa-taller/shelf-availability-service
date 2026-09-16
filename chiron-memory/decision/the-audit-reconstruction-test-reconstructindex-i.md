---
id: b2e7ca83-fe96-4ba2-94dc-5d5ff8ab2099-2
type: decision
title: The audit-reconstruction test (reconstructIndex) is written purely from what…
tags: [decision]
created: 2026-09-16
resource: tests/integration/audit-reconstruction.test.ts.
---
The audit-reconstruction test (reconstructIndex) is written purely from what FacingStateAuditRecord documents itself to mean, and must not call any domain function like computeFacingAvailability.

## Why
delegating to the domain's own computation function would only prove that function is deterministic, not that the retained event log independently reconstructs the reported index — the whole point of the acceptance criterion.

## Learned
verified by mutation-checking — dropping carry-in state from the audit export causes 12 of 19 reconstruction tests to fail, confirming the test doesn't silently pass regardless of export content.

## Where
tests/integration/audit-reconstruction.test.ts.
