---
id: ebdcf5b4-01ca-4940-9da8-272aa1a78dd3-0
type: decision
title: Revisit density is computed as passes ÷ (facings × days), where the facing count in the…
tags: [decision]
created: 2026-09-15
resource: src/domain/merchandising/revisit-density.ts
---
Revisit density is computed as passes ÷ (facings × days), where the facing count in the denominator is every facing in the category, not just ones that were actually passed

## Why
dividing by only the facings that were observed would score a category with 1-of-400 facings swept 12×/day as well-covered, defeating the purpose of the threshold

## Where
src/domain/merchandising/revisit-density.ts
