---
id: 63094f91-5ed0-4b9a-80ca-784123f72f65-15
type: architecture
title: `event-bus.ts` provisions a dedicated dead-letter topic alongside each per-retailer,…
tags: [architecture]
created: 2026-09-16
resource: src/platform/event-bus.ts.
---
`event-bus.ts` provisions a dedicated dead-letter topic alongside each per-retailer, per-source detection topic, with its own ACLs and consumer group.

## Why
Keeps dead-letter isolation consistent with the same per-retailer tenancy boundary as the primary detection topics.

## Where
src/platform/event-bus.ts.
