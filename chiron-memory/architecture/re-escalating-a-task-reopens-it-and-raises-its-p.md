---
id: bd3545d9-c982-4453-b7da-b4a543c2ec35-5
type: architecture
title: Re-escalating a task reopens it and raises its priority one rung via a new escalateTask…
tags: [architecture]
created: 2026-09-15
resource: src/domain/task/task.ts (escalateTask), src/domain/task/task-type.ts (TASK_PRIORITIES, raisePriority)
---
Re-escalating a task reopens it and raises its priority one rung via a new escalateTask domain function composed over applyTaskCommand, rather than folding urgency-raising into the existing reopen command

## Where
src/domain/task/task.ts (escalateTask), src/domain/task/task-type.ts (TASK_PRIORITIES, raisePriority)
