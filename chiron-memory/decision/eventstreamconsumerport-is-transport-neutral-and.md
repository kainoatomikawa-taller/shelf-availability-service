---
id: 6bca2d8e-090d-4cdb-b6be-be784bcbf93a-2
type: decision
title: `EventStreamConsumerPort` is transport-neutral and names no specific broker
tags: [decision]
created: 2026-09-15
---
`EventStreamConsumerPort` is transport-neutral and names no specific broker; no Kafka client dependency was added to the package.

## Why
The package had no existing broker dependency — Kafka is the expected real-world substrate, but wiring an actual client is left as a thin adapter implementing the port, keeping the domain/ports layer free of infra deps.
