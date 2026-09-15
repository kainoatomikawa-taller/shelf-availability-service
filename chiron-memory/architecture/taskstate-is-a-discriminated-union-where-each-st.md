---
id: f1821784-434c-4a25-9d5a-54bf9a6a0ed4-5
type: architecture
title: TaskState is a discriminated union where each state carries exactly its own data, and…
tags: [architecture]
created: 2026-09-15
resource: src/domain/task/task-state.ts, src/domain/task/task.ts
---
TaskState is a discriminated union where each state carries exactly its own data, and applyTaskCommand is a total function returning a Result

## Where
src/domain/task/task-state.ts, src/domain/task/task.ts
