---
id: bd3545d9-c982-4453-b7da-b4a543c2ec35-2
type: gotcha
title: Lane resolution rejects a color lane that resolves onto the reserved green lane at…
tags: [gotcha]
created: 2026-09-15
resource: src/application/create-tasks.use-case.ts
---
Lane resolution rejects a color lane that resolves onto the reserved green lane at dispatch time, not only at lane-map authoring time

## Why
lane maps can arrive from storage, so an invalid mapping could reach dispatch even if validated once elsewhere

## Where
src/application/create-tasks.use-case.ts
