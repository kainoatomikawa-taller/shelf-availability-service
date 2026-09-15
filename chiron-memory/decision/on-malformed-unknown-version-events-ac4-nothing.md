---
id: 6bca2d8e-090d-4cdb-b6be-be784bcbf93a-6
type: decision
title: On malformed/unknown-version events (AC4), nothing that is a property of the *data*…
tags: [decision]
created: 2026-09-15
---
On malformed/unknown-version events (AC4), nothing that is a property of the *data* throws inside the consumer — those are dead-lettered; only infrastructure failures (ingestion port or dead-letter sink itself failing) propagate, leaving the batch uncommitted for safe redelivery.

## Why
This is safe specifically because the ingestion use case (`DetectionIngestionService`) is idempotent, so redelivering an uncommitted batch after an infra failure does not double-apply signals.
