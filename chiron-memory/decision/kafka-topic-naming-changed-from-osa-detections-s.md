---
id: 63094f91-5ed0-4b9a-80ca-784123f72f65-0
type: decision
title: Kafka topic naming changed from `osa.detections.<source>` to…
tags: [decision]
created: 2026-09-16
resource: src/adapters/inbound/detection-stream/topics.ts, src/platform/event-bus.ts
---
Kafka topic naming changed from `osa.detections.<source>` to `osa.<retailer>.detections.<source>` (per-source AND per-retailer).

## Why
Buys broker-enforced isolation — a credential scoped to `osa.<retailer>.*` cannot even name another tenant's topic, giving cross-retailer isolation at the infrastructure layer rather than only in application logic.

## Learned
This is a breaking producer contract change — every existing/onboarding producer needs the new topic name and a credential scoped to its retailer prefix.

## Where
src/adapters/inbound/detection-stream/topics.ts, src/platform/event-bus.ts
