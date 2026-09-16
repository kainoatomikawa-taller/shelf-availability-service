---
id: 63094f91-5ed0-4b9a-80ca-784123f72f65-12
type: convention
title: Platform-layer invariants (tenant distinctness, topic-partition sizing, retention…
tags: [convention]
created: 2026-09-16
resource: src/platform/tenancy.ts, src/platform/event-bus.ts, src/platform/deployment.ts.
---
Platform-layer invariants (tenant distinctness, topic-partition sizing, retention coherence, no-cross-retailer-pooling) are each enforced by a dedicated `assert*` guard function (`assertDistinctTenants`, `assertTopicFitsOnePartition`, `assertBusRetentionFits`, `assertNoCrossRetailerPooling`) that throws at plan/construction time rather than validating opportunistically at runtime.

## Why
Surfaces a misconfigured pilot (duplicate slug, oversized tenant, retention mismatch) as a deployment-plan failure instead of a production incident.

## Where
src/platform/tenancy.ts, src/platform/event-bus.ts, src/platform/deployment.ts.
