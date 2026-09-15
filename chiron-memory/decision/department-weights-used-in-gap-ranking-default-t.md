---
id: ebdcf5b4-01ca-4940-9da8-272aa1a78dd3-3
type: decision
title: Department weights used in gap ranking default to neutral (1.0) rather than shipping a…
tags: [decision]
created: 2026-09-15
resource: src/domain/gap/ranking.ts
---
Department weights used in gap ranking default to neutral (1.0) rather than shipping a hardcoded table of department names/weights

## Why
the platform doesn't own any given retailer's merchandising taxonomy, so a shipped weight table would be wrong for every retailer that didn't write it

## Where
src/domain/gap/ranking.ts
