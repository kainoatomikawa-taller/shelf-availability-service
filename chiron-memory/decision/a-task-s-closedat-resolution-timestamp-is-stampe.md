---
id: bd3545d9-c982-4453-b7da-b4a543c2ec35-11
type: decision
title: A task's closedAt/resolution timestamp is stamped at the instant the qualifying second…
tags: [decision]
created: 2026-09-15
resource: src/application/verification-loop.use-case.ts
---
A task's closedAt/resolution timestamp is stamped at the instant the qualifying second clean pass actually landed, not at the instant the verification evaluator happens to run

## Why
keeps detection-to-resolution timing accurate even when the evaluator executes late relative to the passes it's judging

## Where
src/application/verification-loop.use-case.ts
