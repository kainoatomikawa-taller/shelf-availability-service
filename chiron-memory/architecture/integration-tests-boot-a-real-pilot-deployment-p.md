---
id: b2e7ca83-fe96-4ba2-94dc-5d5ff8ab2099-0
type: architecture
title: Integration tests boot a real pilot deployment (planPilotDeployment + startDeployment)…
tags: [architecture]
created: 2026-09-16
resource: tests/integration/*.test.ts, tests/support/pilot-harness.ts
---
Integration tests boot a real pilot deployment (planPilotDeployment + startDeployment) with one container and one DetectionStreamConsumer per retailer, using the shipped source/vendor adapters and real generated topic names — only the store, broker, clock and vendor transport are test doubles.

## Why
proves the wiring and adapters actually work end to end rather than testing against mocked internals.

## Where
tests/integration/*.test.ts, tests/support/pilot-harness.ts
