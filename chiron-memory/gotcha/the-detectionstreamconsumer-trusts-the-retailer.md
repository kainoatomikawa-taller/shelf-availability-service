---
id: b2e7ca83-fe96-4ba2-94dc-5d5ff8ab2099-4
type: gotcha
title: The DetectionStreamConsumer trusts the retailer named in a message's own envelope over…
tags: [gotcha]
created: 2026-09-16
resource: src/adapters/inbound/detection-stream/consumer.ts.
---
The DetectionStreamConsumer trusts the retailer named in a message's own envelope over the retailer implied by the topic/subscription it arrived on, and sets aside (does not process) any record whose envelope retailer doesn't match the topic's retailer.

## Learned
confirmed via mutation testing in tests/integration/partition-isolation.test.ts — reverting this check causes a cross-retailer leakage test to fail, so this behavior is load-bearing for partition isolation, not incidental.

## Where
src/adapters/inbound/detection-stream/consumer.ts.
