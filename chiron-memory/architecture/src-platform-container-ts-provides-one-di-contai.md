---
id: 63094f91-5ed0-4b9a-80ca-784123f72f65-7
type: architecture
title: `src/platform/container.ts` provides one DI container instance per retailer
tags: [architecture]
created: 2026-09-16
resource: src/platform/container.ts
---
`src/platform/container.ts` provides one DI container instance per retailer; `PortProviders` is a mapped type over `PortName` so every port must be bound or the file fails to typecheck.

## Why
Guarantees at compile time that all 10 ports have adapter bindings before a container can be constructed, instead of discovering a missing binding at runtime.

## Where
src/platform/container.ts
