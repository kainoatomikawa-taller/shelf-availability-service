---
id: ebdcf5b4-01ca-4940-9da8-272aa1a78dd3-1
type: decision
title: The service-level revisit-density floor is fixed at 2 passes/facing/day, derived from…
tags: [decision]
created: 2026-09-15
resource: src/domain/merchandising/service-level.ts
---
The service-level revisit-density floor is fixed at 2 passes/facing/day, derived from STANDARD_VERIFICATION_RULE rather than chosen independently

## Why
two clean passes within 24h is what closes a verification task, so a category sparser than that structurally cannot close a loop in a day

## Learned
this constant is fixed platform-wide, not part of retailer-tunable policy.

## Where
src/domain/merchandising/service-level.ts
