---
id: f1821784-434c-4a25-9d5a-54bf9a6a0ed4-30
type: decision
title: Wire payload types for ports are written out explicitly rather than derived from internal…
tags: [decision]
created: 2026-09-15
resource: src/ports/inbound/ and src/ports/outbound/ port files.
---
Wire payload types for ports are written out explicitly rather than derived from internal domain signal types, using exported conformance type-aliases that fail the build if the domain gains a required field the wire can't supply.

## Why
A published external contract shouldn't shift silently under an internal domain refactor, even though this causes some structural duplication across five wire payload types.

## Where
src/ports/inbound/ and src/ports/outbound/ port files.
