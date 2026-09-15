---
id: bd3545d9-c982-4453-b7da-b4a543c2ec35-0
type: decision
title: Dispatch sends the caller's unfiltered ESL degradation ladder to the fleet rather than…
tags: [decision]
created: 2026-09-15
resource: src/application/create-tasks.use-case.ts
---
Dispatch sends the caller's unfiltered ESL degradation ladder to the fleet rather than pre-trimming it to the store's known capabilities

## Why
pre-filtering the ladder to what the fleet supports would make every command report degraded: false, destroying the exact signal the port exists to surface

## Where
src/application/create-tasks.use-case.ts
