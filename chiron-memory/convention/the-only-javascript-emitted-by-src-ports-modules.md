---
id: f1821784-434c-4a25-9d5a-54bf9a6a0ed4-32
type: convention
title: The only JavaScript emitted by src/ports/ modules is published contract data (schema…
tags: [convention]
created: 2026-09-15
resource: src/ports/inbound/, src/ports/outbound/.
---
The only JavaScript emitted by src/ports/ modules is published contract data (schema version constants, the DETECTION_SOURCES list, the ESL degradation ladder, wire encoding) — no functions or classes are exported.

## Why
Enforces at the compiled-output level (not just type level) that ports are interface-only and free of implementation, verified during development via grep for exported functions/classes/consts.

## Where
src/ports/inbound/, src/ports/outbound/.
