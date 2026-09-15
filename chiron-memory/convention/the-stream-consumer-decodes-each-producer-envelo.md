---
id: 6bca2d8e-090d-4cdb-b6be-be784bcbf93a-5
type: convention
title: The stream consumer decodes each producer envelope, re-checks its declared schema version…
tags: [convention]
created: 2026-09-15
resource: `src/adapters/inbound/detection-stream/consumer.ts`, documented in README.md under "Adapters — consuming the detection stream" and "Retailer partitioning".
---
The stream consumer decodes each producer envelope, re-checks its declared schema version before reading any field, and re-asserts the retailer partition against the record's own key rather than trusting either the payload or the key alone; decoded events are grouped by partition before being handed to the ingestion use case, so no code path can pool two retailers' events together.

## Why
Partition isolation is a modelling invariant for this service — trusting only one of (payload retailer id, record key) would let one retailer's shelf data leak into another's partition.

## Where
`src/adapters/inbound/detection-stream/consumer.ts`, documented in README.md under "Adapters — consuming the detection stream" and "Retailer partitioning".
