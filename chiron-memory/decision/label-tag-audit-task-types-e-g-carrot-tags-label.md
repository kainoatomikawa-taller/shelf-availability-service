---
id: f1821784-434c-4a25-9d5a-54bf9a6a0ed4-9
type: decision
title: Label/tag/audit task types (e.g
tags: [decision]
created: 2026-09-15
resource: src/domain/availability/verification.ts
---
Label/tag/audit task types (e.g. Carrot Tags label updates, audit tasks) are exempted from the shelf-verification rule

## Why
those task types don't correspond to a shelf in-stock/out-of-stock condition that the two-pass rule can meaningfully verify

## Where
src/domain/availability/verification.ts
