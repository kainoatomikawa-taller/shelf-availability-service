---
id: e296a351-330a-4e25-910f-e33a1630cbb5-10
type: gotcha
title: After a battery swap rebinds a facing to a new physical tag, the adapter could treat the…
tags: [gotcha]
created: 2026-09-15
resource: src/adapters/outbound/esl/fleet-adapter.ts
---
After a battery swap rebinds a facing to a new physical tag, the adapter could treat the facing's expression as already-active (based on stale lease state) and simply renew the lease on the old tag id instead of re-expressing on the new tag

## Why
this would silently leave the shelf dark while believing the task is still lit

## Learned
lease/idempotency keys must be validated against the currently-bound tag id, not just (taskId, facingId), before treating a prior expression as still valid.

## Where
src/adapters/outbound/esl/fleet-adapter.ts
