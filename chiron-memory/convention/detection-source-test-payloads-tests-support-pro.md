---
id: b2e7ca83-fe96-4ba2-94dc-5d5ff8ab2099-7
type: convention
title: Detection-source test payloads (tests/support/producer-payloads.ts) are deliberately…
tags: [convention]
created: 2026-09-16
resource: tests/support/producer-payloads.ts.
---
Detection-source test payloads (tests/support/producer-payloads.ts) are deliberately written in each vendor's own raw dialect — `void_pct`, `gapWidthMm`, `storeNumber`, `REPLACED`, a price as the string `"5.99"` — rather than normalized ahead of time.

## Why
normalized payloads would only exercise the domain logic, not prove the adapter's own decoding of heterogeneous vendor field names/units/types actually works.

## Where
tests/support/producer-payloads.ts.
