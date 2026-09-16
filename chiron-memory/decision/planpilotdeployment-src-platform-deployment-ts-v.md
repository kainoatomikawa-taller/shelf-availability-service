---
id: 63094f91-5ed0-4b9a-80ca-784123f72f65-9
type: decision
title: `planPilotDeployment` (src/platform/deployment.ts) validates and enforces 2–4 concurrent…
tags: [decision]
created: 2026-09-16
resource: src/platform/deployment.ts, src/platform/runtime.ts (`startDeployment` wires one container + one consumer per retailer).
---
`planPilotDeployment` (src/platform/deployment.ts) validates and enforces 2–4 concurrent retailers and a 9–15 month deployment window at plan time, emitting a JSON manifest.

## Why
Matches the pilot-scale acceptance criteria directly and fails fast on an invalid pilot configuration instead of letting an out-of-range deployment reach runtime.

## Where
src/platform/deployment.ts, src/platform/runtime.ts (`startDeployment` wires one container + one consumer per retailer).
