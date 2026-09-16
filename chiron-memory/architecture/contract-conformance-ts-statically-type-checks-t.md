---
id: 56f75b13-1677-40f5-92b5-d5debce3f1e5-2
type: architecture
title: `contract-conformance.ts` statically type-checks the dashboard's hand-written…
tags: [architecture]
created: 2026-09-16
resource: web/src/services/contract-conformance.ts.
---
`contract-conformance.ts` statically type-checks the dashboard's hand-written models/decoders against the real `TaskPerformanceQueryPort`/reporting port types so any drift becomes a compile error, without importing those types at runtime.

## Where
web/src/services/contract-conformance.ts.
