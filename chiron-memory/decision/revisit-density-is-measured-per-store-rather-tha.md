---
id: ebdcf5b4-01ca-4940-9da8-272aa1a78dd3-10
type: decision
title: Revisit density is measured per-store rather than pooled across a retailer's stores
tags: [decision]
created: 2026-09-15
resource: src/domain/merchandising/revisit-density.ts
---
Revisit density is measured per-store rather than pooled across a retailer's stores

## Why
a facing swept heavily in one store must not offset an under-covered facing in another store — service-level qualification is a per-store guarantee

## Where
src/domain/merchandising/revisit-density.ts
