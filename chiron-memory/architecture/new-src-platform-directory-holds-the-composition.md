---
id: 63094f91-5ed0-4b9a-80ca-784123f72f65-1
type: architecture
title: New `src/platform/` directory holds the composition root and infrastructure config…
tags: [architecture]
created: 2026-09-16
resource: src/platform/*.ts
---
New `src/platform/` directory holds the composition root and infrastructure config (tenancy, encryption, retention, data-store, event-bus, container, deployment) with no driver or client-library dependency — a real deployment supplies drivers via `RetailerInfrastructure`.

## Why
Keeps the hexagon (domain/application/ports/adapters) free of infra wiring; platform is the only layer that knows about pilot-scale deployment concerns.

## Where
src/platform/*.ts
