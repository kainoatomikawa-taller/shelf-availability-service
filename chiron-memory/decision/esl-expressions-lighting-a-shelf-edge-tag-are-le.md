---
id: f1821784-434c-4a25-9d5a-54bf9a6a0ed4-25
type: decision
title: ESL expressions (lighting a shelf-edge tag) are leased rather than fire-and-forget.
tags: [decision]
created: 2026-09-15
resource: src/ports/outbound/esl-actuation.port.ts.
---
ESL expressions (lighting a shelf-edge tag) are leased rather than fire-and-forget.

## Why
A crashed service should leave dark shelves rather than tags lit for work nobody is doing — failing safe toward inaction.

## Where
src/ports/outbound/esl-actuation.port.ts.
