---
id: f1821784-434c-4a25-9d5a-54bf9a6a0ed4-8
type: decision
title: In the two-consecutive-clean-passes-within-24h verification rule, a dirty pass occurring…
tags: [decision]
created: 2026-09-15
resource: src/domain/availability/verification.ts
---
In the two-consecutive-clean-passes-within-24h verification rule, a dirty pass occurring after resolution is treated as decisive (task becomes 'regressed', requiring the caller to reopen it) rather than allowing a later clean streak to silently rescue/overwrite it

## Where
src/domain/availability/verification.ts
