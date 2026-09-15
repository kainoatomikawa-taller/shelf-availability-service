---
id: bd3545d9-c982-4453-b7da-b4a543c2ec35-3
type: decision
title: A task auto-closes on two consecutive clean shopper/camera passes within 24h, with the…
tags: [decision]
created: 2026-09-15
resource: src/application/verification-loop.use-case.ts
---
A task auto-closes on two consecutive clean shopper/camera passes within 24h, with the 24h deadline measured from resolvedAt (the fix attempt), not from the first clean pass

## Why
same window length as the verification rule's inter-pass window but deliberately a separate question — the deadline tracks how long the fix has been live, not pass spacing

## Where
src/application/verification-loop.use-case.ts
