---
id: b2e7ca83-fe96-4ba2-94dc-5d5ff8ab2099-9
type: convention
title: New integration-level test suites in this repo are validated by deliberately mutating the…
tags: [convention]
created: 2026-09-16
resource: applied when writing tests/integration/detection-sources.integration.test.ts, partition-isolation.test.ts, and audit-reconstruction.test.ts.
---
New integration-level test suites in this repo are validated by deliberately mutating the source behavior under test (e.g. reverting a retailer-trust check or a unit conversion), confirming the suite fails, then reverting the mutation — before the suite is considered complete.

## Why
a first-draft suite can pass regardless of the behavior it's meant to protect (e.g. threshold-clearing payloads mask a dropped unit conversion), so passing alone doesn't prove the test is load-bearing.

## Where
applied when writing tests/integration/detection-sources.integration.test.ts, partition-isolation.test.ts, and audit-reconstruction.test.ts.
