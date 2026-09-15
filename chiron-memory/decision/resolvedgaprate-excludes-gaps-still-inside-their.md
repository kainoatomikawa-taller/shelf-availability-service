---
id: f1821784-434c-4a25-9d5a-54bf9a6a0ed4-27
type: decision
title: `resolvedGapRate` excludes gaps still inside their verification window from the…
tags: [decision]
created: 2026-09-15
resource: src/ports/inbound/reporting.port.ts.
---
`resolvedGapRate` excludes gaps still inside their verification window from the denominator, reporting them separately as `awaitingVerification`.

## Why
Without this exclusion, a gap detected shortly before its verification window closes would count as unresolved and understate the rate; anyone comparing this metric to an existing one will see a different number because of this choice.

## Where
src/ports/inbound/reporting.port.ts.
