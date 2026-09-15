---
id: f1821784-434c-4a25-9d5a-54bf9a6a0ed4-16
type: convention
title: Discriminated unions (SignalSource, TaskState, etc.) are switched over using a shared…
tags: [convention]
created: 2026-09-15
resource: src/domain/common/exhaustive.ts, used in src/domain/facing/interpretation.ts, src/domain/facing/facing.ts, src/domain/task/task.ts
---
Discriminated unions (SignalSource, TaskState, etc.) are switched over using a shared assertNever exhaustiveness helper so adding a new union member becomes a compile error at every unhandled switch

## Where
src/domain/common/exhaustive.ts, used in src/domain/facing/interpretation.ts, src/domain/facing/facing.ts, src/domain/task/task.ts
