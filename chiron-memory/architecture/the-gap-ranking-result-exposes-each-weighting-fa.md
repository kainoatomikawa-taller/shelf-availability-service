---
id: ebdcf5b4-01ca-4940-9da8-272aa1a78dd3-13
type: architecture
title: The gap ranking result exposes each weighting factor (departmentWeight, kindWeight,…
tags: [architecture]
created: 2026-09-15
resource: src/domain/gap/ranking.ts
---
The gap ranking result exposes each weighting factor (departmentWeight, kindWeight, salesVelocity, evidenceFactor) individually in a `components` field alongside the final score

## Why
makes it possible to audit why a given gap ranked where it did instead of only seeing the collapsed score

## Where
src/domain/gap/ranking.ts
