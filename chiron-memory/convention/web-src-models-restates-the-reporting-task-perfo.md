---
id: 56f75b13-1677-40f5-92b5-d5debce3f1e5-1
type: convention
title: `web/src/models` restates the reporting/task-performance read-side shapes as its own…
tags: [convention]
created: 2026-09-16
resource: web/src/models/*, cross-checked by web/src/services/contract-conformance.ts.
---
`web/src/models` restates the reporting/task-performance read-side shapes as its own types rather than importing them directly from `src/domain` or `src/ports`.

## Why
Decouples the dashboard from internal domain types while still guaranteeing they don't drift.

## Where
web/src/models/*, cross-checked by web/src/services/contract-conformance.ts.
