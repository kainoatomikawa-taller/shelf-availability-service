---
id: ebdcf5b4-01ca-4940-9da8-272aa1a78dd3-4
type: decision
title: Categories excluded from service-level scope for insufficient revisit density are still…
tags: [decision]
created: 2026-09-15
resource: src/application/rank-gaps.use-case.ts
---
Categories excluded from service-level scope for insufficient revisit density are still returned in a ranked `excluded` list, and are kept distinct from an `unmeasured` category (no pass data at all) vs `below_revisit_threshold` (measured but under the floor)

## Why
preserves visibility into gaps that exist but can't yet be committed to, and distinguishes 'no data' from 'known to be under-covered'

## Where
src/application/rank-gaps.use-case.ts
