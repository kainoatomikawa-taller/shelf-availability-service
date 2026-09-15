---
id: e296a351-330a-4e25-910f-e33a1630cbb5-8
type: gotcha
title: Building batch results with a plain array via .map over sparse/undefined slots silently…
tags: [gotcha]
created: 2026-09-15
resource: src/adapters/outbound/esl/fleet-adapter.ts
---
Building batch results with a plain array via .map over sparse/undefined slots silently drops entries instead of erroring, producing a task that is neither expressed nor reported

## Why
found during self-review of the fleet adapter's batch dispatch path

## Learned
guard against sparse arrays explicitly in batch result construction rather than trusting map to surface every input.

## Where
src/adapters/outbound/esl/fleet-adapter.ts
