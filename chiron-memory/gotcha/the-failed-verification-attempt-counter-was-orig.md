---
id: f1821784-434c-4a25-9d5a-54bf9a6a0ed4-11
type: gotcha
title: The failed-verification-attempt counter was originally stored only inside the task's…
tags: [gotcha]
created: 2026-09-15
resource: src/domain/task/task.ts (now `failedVerifications` field on Task)
---
The failed-verification-attempt counter was originally stored only inside the task's 'reopened' state, so it silently reset to 0 whenever the task cycled back through assign→resolve

## Learned
counters that must persist across a task's full lifecycle (not just one state) belong on the Task aggregate itself, not nested in a single state variant; this was caught by a unit test (`accumulates failed attempts across successive rework cycles`)

## Where
src/domain/task/task.ts (now `failedVerifications` field on Task)
