---
id: b2e7ca83-fe96-4ba2-94dc-5d5ff8ab2099-3
type: gotcha
title: Unit-conversion bugs in detection-source adapters (e.g
tags: [gotcha]
created: 2026-09-16
---
Unit-conversion bugs in detection-source adapters (e.g. Caper's gap-width mm→cm conversion, Arpalus's void-percentage handling) fail silently rather than crashing, and test payloads built with an obviously-empty shelf (e.g. gapWidthMm: 180) don't catch a dropped conversion because both the raw and converted values clear the detection threshold.

## Why
mutation-testing the first draft of tests/integration/detection-sources.integration.test.ts showed removing the `/ 10` conversion left the whole suite green. How to apply: any new detection-source test payload must include values that straddle the interpretation threshold (e.g. gapWidthMm: 60, void_pct: 33.5) so a lost/incorrect unit conversion actually flips a facing's detected state and fails the test.
