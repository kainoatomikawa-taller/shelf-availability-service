---
id: ebdcf5b4-01ca-4940-9da8-272aa1a78dd3-2
type: decision
title: Gap ranking score = departmentWeight × kindWeight × salesVelocity × evidenceFactor, where…
tags: [decision]
created: 2026-09-15
resource: src/domain/gap/ranking.ts
---
Gap ranking score = departmentWeight × kindWeight × salesVelocity × evidenceFactor, where evidenceFactor = density/(density+threshold) saturates below 1

## Why
lets measurement coverage adjust confidence in the score without manufacturing artificial demand for under-observed facings

## Where
src/domain/gap/ranking.ts
