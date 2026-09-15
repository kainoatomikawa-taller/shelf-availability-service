---
id: f1821784-434c-4a25-9d5a-54bf9a6a0ed4-13
type: gotcha
title: The verification rule's 24-hour boundary is exact-inclusive
tags: [gotcha]
created: 2026-09-15
resource: src/domain/availability/verification.ts, tests/verification.test.ts
---
The verification rule's 24-hour boundary is exact-inclusive: a second pass at exactly 24h from the first still counts, but 24h+1ms does not

## Where
src/domain/availability/verification.ts, tests/verification.test.ts
