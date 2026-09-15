---
id: f1821784-434c-4a25-9d5a-54bf9a6a0ed4-7
type: decision
title: The availability index formula is Σ in-stock facing-time / Σ measured facing-time, with…
tags: [decision]
created: 2026-09-15
resource: src/domain/availability/availability-index.ts
---
The availability index formula is Σ in-stock facing-time / Σ measured facing-time, with 'unknown' time excluded from both numerator and denominator (not scored as either state), coverage reported alongside the index, and null returned instead of 0 when nothing was measured

## Why
avoids conflating 'never measured' with 'measured and out of stock'

## Where
src/domain/availability/availability-index.ts
