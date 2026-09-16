---
id: 63094f91-5ed0-4b9a-80ca-784123f72f65-6
type: decision
title: Detection topics are provisioned with exactly one partition per retailer topic.
tags: [decision]
created: 2026-09-16
resource: src/platform/event-bus.ts
---
Detection topics are provisioned with exactly one partition per retailer topic.

## Why
Producers key by `retailerId`, so a whole retailer's stream lives on one partition anyway — extra partitions would sit empty. `assertTopicFitsOnePartition` projects each tenant's peak throughput against a 5,000 rec/s ceiling and fails the deployment plan rather than letting it surface later as consumer lag.

## Learned
The documented way out if a tenant exceeds the ceiling is keying by store instead of retailer, since that still preserves the per-facing event ordering the domain relies on.

## Where
src/platform/event-bus.ts
