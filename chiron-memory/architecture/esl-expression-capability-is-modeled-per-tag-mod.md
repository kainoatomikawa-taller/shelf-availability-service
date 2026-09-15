---
id: e296a351-330a-4e25-910f-e33a1630cbb5-0
type: architecture
title: ESL expression capability is modeled per tag-model (the actual hardware bound to a…
tags: [architecture]
created: 2026-09-15
resource: src/adapters/outbound/esl/ (tag-model.ts, fleet-adapter.ts)
---
ESL expression capability is modeled per tag-model (the actual hardware bound to a facing), not per store or fleet

## Why
a store mid-refresh runs two tag generations at once, so a store-level 'supports pick-to-light' claim is true for new tags and false for old ones on the same shelf

## Learned
every expression must be planned against the specific tag model bound to the facing; EslFleetCapabilities reported at store level is a union for planning/reporting only, never used to decide an individual expression.

## Where
src/adapters/outbound/esl/ (tag-model.ts, fleet-adapter.ts)
