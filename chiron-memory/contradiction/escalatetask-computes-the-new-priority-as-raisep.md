---
id: bd3545d9-c982-4453-b7da-b4a543c2ec35-14
type: contradiction
title: escalateTask computes the new priority as raisePriority(task.priority,…
tags: [contradiction]
created: 2026-09-15
resource: src/domain/task/task.ts (escalateTask), src/domain/task/task-type.ts (raisePriority) — worth confirming against the already-recorded 'raises its priority one rung' decision
---
escalateTask computes the new priority as raisePriority(task.priority, next.failedVerifications) — derived from the task's cumulative failed-verification count — which may not match a strict 'always raises one rung per re-escalation' characterization if failedVerifications can jump by more than one between escalations

## Where
src/domain/task/task.ts (escalateTask), src/domain/task/task-type.ts (raisePriority) — worth confirming against the already-recorded 'raises its priority one rung' decision
