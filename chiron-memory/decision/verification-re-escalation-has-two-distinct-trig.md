---
id: bd3545d9-c982-4453-b7da-b4a543c2ec35-4
type: decision
title: Verification re-escalation has two distinct triggers
tags: [decision]
created: 2026-09-15
resource: src/application/verification-loop.use-case.ts
---
Verification re-escalation has two distinct triggers: a dirty pass observed after the fix ('condition_persisted') and the 24h deadline elapsing without two clean passes ('verification_window_lapsed'); evidence that later arrives late still closes the task if present, i.e. present evidence beats a missed deadline

## Where
src/application/verification-loop.use-case.ts
