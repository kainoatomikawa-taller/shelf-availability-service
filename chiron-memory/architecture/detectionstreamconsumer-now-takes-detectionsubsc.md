---
id: 63094f91-5ed0-4b9a-80ca-784123f72f65-11
type: architecture
title: `DetectionStreamConsumer` now takes `DetectionSubscription`s (topic + retailer + source…
tags: [architecture]
created: 2026-09-16
resource: src/adapters/inbound/detection-stream/consumer.ts, src/ports/outbound/dead-letter.port.ts.
---
`DetectionStreamConsumer` now takes `DetectionSubscription`s (topic + retailer + source binding) and derives the batch's `retailerId` from the subscription rather than from the decoded payload, adding a third partition-integrity check (`topic_retailer_mismatch` dead-letter reason) that the topic and the envelope's retailer must agree.

## Why
With per-retailer topics, the topic name itself becomes an authoritative signal of tenancy that must be cross-checked against the envelope, not just trusted.

## Where
src/adapters/inbound/detection-stream/consumer.ts, src/ports/outbound/dead-letter.port.ts.
