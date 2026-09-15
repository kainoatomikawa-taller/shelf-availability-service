---
id: f1821784-434c-4a25-9d5a-54bf9a6a0ed4-17
type: convention
title: Domain code splits error handling by kind
tags: [convention]
created: 2026-09-15
resource: src/domain/common/errors.ts, src/domain/task/task.ts
---
Domain code splits error handling by kind: invariant violations (cross-retailer access, out-of-order events, invalid task transitions, lane mapping conflicts) throw DomainError subclasses, while expected/control-flow outcomes (e.g. applying a task command) are returned as a Result instead of thrown

## Why
keeps expected rejection paths type-checked by callers while treating true invariant breaks as exceptional

## Where
src/domain/common/errors.ts, src/domain/task/task.ts
