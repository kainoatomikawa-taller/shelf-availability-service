---
id: f1821784-434c-4a25-9d5a-54bf9a6a0ed4-23
type: decision
title: The ESL actuation port has the fleet declare `EslFleetCapabilities` and the caller…
tags: [decision]
created: 2026-09-15
resource: src/ports/outbound/esl-actuation.port.ts.
---
The ESL actuation port has the fleet declare `EslFleetCapabilities` and the caller declare an ordered `modePreference`; the result reports which rung of the degradation ladder was actually used via `mode` + `degraded`.

## Why
Abstracts pick-to-light vs fallback expression capabilities without callers needing to know fleet specifics up front.

## Where
src/ports/outbound/esl-actuation.port.ts.
