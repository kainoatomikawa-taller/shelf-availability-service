---
id: bd3545d9-c982-4453-b7da-b4a543c2ec35-9
type: decision
title: Baseline/availability-index establishment reuses the same computeAvailabilityIndex used…
tags: [decision]
created: 2026-09-15
resource: src/application/availability-baseline.use-case.ts
---
Baseline/availability-index establishment reuses the same computeAvailabilityIndex used for the live index rather than a separate computation path, and will not mark a baseline as 'established' below half coverage or under a full trading week of data — but still publishes the computed number along with its shortfalls

## Where
src/application/availability-baseline.use-case.ts
