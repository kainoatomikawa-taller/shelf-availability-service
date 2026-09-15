---
id: bd3545d9-c982-4453-b7da-b4a543c2ec35-13
type: convention
title: New application-layer use cases in src/application split a pure decision function (e.g.…
tags: [convention]
created: 2026-09-15
resource: src/application/create-tasks.use-case.ts, src/application/verification-loop.use-case.ts
---
New application-layer use cases in src/application split a pure decision function (e.g. planTasks, decideVerification) from a separate side-effecting function that performs the actual port I/O (e.g. dispatchTasks)

## Why
keeps the core decision logic unit-testable without fakes, with port calls isolated to a thin wrapper

## Where
src/application/create-tasks.use-case.ts, src/application/verification-loop.use-case.ts
