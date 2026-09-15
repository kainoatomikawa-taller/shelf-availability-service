---
id: bd3545d9-c982-4453-b7da-b4a543c2ec35-12
type: decision
title: Resolved-gap-rate in outcome metrics cohorts gaps by the gap's detection time, not by…
tags: [decision]
created: 2026-09-15
resource: src/application/outcome-metrics.ts
---
Resolved-gap-rate in outcome metrics cohorts gaps by the gap's detection time, not by when it was later resolved

## Why
so a period's report reflects what was detected within that period even if the fix and verification land afterward

## Where
src/application/outcome-metrics.ts
