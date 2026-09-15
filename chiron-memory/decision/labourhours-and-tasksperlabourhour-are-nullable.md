---
id: f1821784-434c-4a25-9d5a-54bf9a6a0ed4-28
type: decision
title: `labourHours` and `tasksPerLabourHour` are nullable rather than estimated when a…
tags: [decision]
created: 2026-09-15
resource: src/ports/inbound/reporting.port.ts.
---
`labourHours` and `tasksPerLabourHour` are nullable rather than estimated when a retailer's workforce feed isn't connected.

## Where
src/ports/inbound/reporting.port.ts.
