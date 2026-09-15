---
id: ebdcf5b4-01ca-4940-9da8-272aa1a78dd3-9
type: convention
title: New orchestration logic for a use case lives under src/application/ (e.g.…
tags: [convention]
created: 2026-09-15
resource: src/application/
---
New orchestration logic for a use case lives under src/application/ (e.g. detection-ingestion.service.ts, rank-gaps.use-case.ts, signal-normalization.ts), separate from src/domain/ and src/ports/

## Why
keeps domain model, port interfaces, and application orchestration in distinct hexagonal layers

## Where
src/application/
