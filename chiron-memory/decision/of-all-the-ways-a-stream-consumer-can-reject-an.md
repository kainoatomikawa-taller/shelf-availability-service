---
id: 6bca2d8e-090d-4cdb-b6be-be784bcbf93a-4
type: decision
title: Of all the ways a stream consumer can reject an event, only rate-limiting failures hold…
tags: [decision]
created: 2026-09-15
resource: `src/adapters/inbound/detection-stream/consumer.ts`.
---
Of all the ways a stream consumer can reject an event, only rate-limiting failures hold back the commit watermark (so a later attempt can retry and succeed); every other rejection (malformed payload, unknown schema version, cross-partition mismatch, etc.) is treated as a fact about the event itself, is dead-lettered, and is stepped over.

## Why
Retrying a permanently-bad message forever would wedge the whole partition behind it, whereas rate-limiting is the one condition where retrying later can actually change the outcome.

## Where
`src/adapters/inbound/detection-stream/consumer.ts`.
