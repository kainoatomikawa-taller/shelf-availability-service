---
id: 6bca2d8e-090d-4cdb-b6be-be784bcbf93a-7
type: convention
title: Vendor payload builders live in `tests/support/producer-payloads.ts` (one builder per…
tags: [convention]
created: 2026-09-15
resource: `tests/support/producer-payloads.ts`, `tests/support/in-memory-stream.ts`, used by `tests/detection-stream-consumer.test.ts`.
---
Vendor payload builders live in `tests/support/producer-payloads.ts` (one builder per producer dialect, constructing raw upstream envelopes exactly as each vendor would send them) and `tests/support/in-memory-stream.ts` provides the in-memory test double for the new stream/dead-letter ports.

## Why
Keeps adapter/consumer tests exercising the actual wire shape each vendor sends rather than the domain shape, so a test can't accidentally assert against pre-normalized data.

## Where
`tests/support/producer-payloads.ts`, `tests/support/in-memory-stream.ts`, used by `tests/detection-stream-consumer.test.ts`.
