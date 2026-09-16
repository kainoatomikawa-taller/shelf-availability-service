---
id: 56f75b13-1677-40f5-92b5-d5debce3f1e5-16
type: architecture
title: The four dashboard service clients (`AvailabilityClient`, `OperationsClient`,…
tags: [architecture]
created: 2026-09-16
resource: web/src/services (client composition), web/src/state/effects.ts.
---
The four dashboard service clients (`AvailabilityClient`, `OperationsClient`, `TaskPerformanceClient`, `ReportingClient`) are composed into a single `DashboardApi` facade object that the state effects layer consumes, rather than the state layer wiring up each client individually.

## Where
web/src/services (client composition), web/src/state/effects.ts.
