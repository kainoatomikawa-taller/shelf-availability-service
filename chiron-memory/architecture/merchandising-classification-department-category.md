---
id: ebdcf5b4-01ca-4940-9da8-272aa1a78dd3-5
type: architecture
title: Merchandising classification (department/category) is deliberately not a field on the…
tags: [architecture]
created: 2026-09-15
resource: src/domain/merchandising/classification.ts, src/domain/facing/
---
Merchandising classification (department/category) is deliberately not a field on the `Facing` aggregate; it lives in its own module (src/domain/merchandising/classification.ts)

## Why
classification is retailer taxonomy that can be re-cut (e.g. a merchandising re-org) without anything physically changing on the shelf, and storing it on Facing would let a taxonomy change rewrite the append-only facing history

## Where
src/domain/merchandising/classification.ts, src/domain/facing/
