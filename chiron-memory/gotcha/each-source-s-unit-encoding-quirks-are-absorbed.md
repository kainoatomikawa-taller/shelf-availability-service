---
id: 6bca2d8e-090d-4cdb-b6be-be784bcbf93a-3
type: gotcha
title: Each source's unit/encoding quirks are absorbed entirely inside its adapter
tags: [gotcha]
created: 2026-09-15
---
Each source's unit/encoding quirks are absorbed entirely inside its adapter: Arpalus sends `void_pct` as 0–100 (must convert to a ratio) with the store nested under `site`; Caper sends epoch-millis timestamps and `gapWidthMm` in millimeters (must convert to cm); Carrot Tags encodes status/lamp as vendor codes and prices as decimal strings like `"5.99"` (must become 599 cents) and mints no event id itself (the adapter must derive one); POS sends a start/end window and the adapter records the duration observed at the window's close; shopper-scan events carry one item per event and must be wrapped into the port's array shape, with vendor status `REPLACED` mapped to the domain's `substituted`.

## Why
Each of these is a *valid* number/value if left unconverted, so a missed conversion fails silently rather than crashing — e.g. an unconverted 33.5% void reads as a void ratio of 33.5 and empties an otherwise two-thirds-full shelf.

## Learned
Tests for these adapters must assert the resulting shelf/domain state, not just that the field round-trips.
