---
id: 56f75b13-1677-40f5-92b5-d5debce3f1e5-3
type: decision
title: The wire payload format for dashboard reporting endpoints was undefined in the backend…
tags: [decision]
created: 2026-09-16
resource: web/src/services/endpoints.ts, web/src/services/report-decoders.ts, web/src/services/operations-decoders.ts.
---
The wire payload format for dashboard reporting endpoints was undefined in the backend (no HTTP adapters exist yet), so the endpoint layout and JSON shapes were authored to follow the domain's existing `WIRE_ENCODING` conventions: ISO-8601 UTC instants, opaque string ids, decimal ratios, integer-millisecond durations.

## Why
No real HTTP contract to consume yet; this is the best-effort assumption until a real adapter exists.

## Where
web/src/services/endpoints.ts, web/src/services/report-decoders.ts, web/src/services/operations-decoders.ts.
