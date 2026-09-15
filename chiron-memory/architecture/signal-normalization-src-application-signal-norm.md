---
id: ebdcf5b4-01ca-4940-9da8-272aa1a78dd3-7
type: architecture
title: Signal normalization (src/application/signal-normalization.ts) maps wire detection events…
tags: [architecture]
created: 2026-09-15
resource: src/application/signal-normalization.ts
---
Signal normalization (src/application/signal-normalization.ts) maps wire detection events to domain signals via one exhaustive switch over event type, with `observedAt` taken from the envelope timestamp rather than derived per-observation

## Why
a single Arpalus pass observes an entire bay at one instant, so the envelope time is the correct observation time for every signal it produces; the exhaustive switch ensures each source's branch only narrows to the observations that source is contractually able to send

## Where
src/application/signal-normalization.ts
