---
id: 63094f91-5ed0-4b9a-80ca-784123f72f65-13
type: gotcha
title: An early version of `planPilotDeployment`'s sizing logic matched each tenant's throughput…
tags: [gotcha]
created: 2026-09-16
resource: src/platform/deployment.ts.
---
An early version of `planPilotDeployment`'s sizing logic matched each tenant's throughput data to it by array index across parallel arrays, which is fragile if the arrays ever drift out of order; it was reworked to associate sizing data directly with each tenant instead.

## Why
Index-based correlation between separately-built arrays silently breaks if one array is filtered, reordered, or extended without the other.

## Where
src/platform/deployment.ts.
