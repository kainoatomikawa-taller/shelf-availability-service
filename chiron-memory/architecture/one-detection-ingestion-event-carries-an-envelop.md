---
id: f1821784-434c-4a25-9d5a-54bf9a6a0ed4-20
type: architecture
title: One detection ingestion event carries an envelope plus many observations, since a single…
tags: [architecture]
created: 2026-09-15
resource: src/ports/inbound/detection-ingestion.port.ts.
---
One detection ingestion event carries an envelope plus many observations, since a single Arpalus pass or Caper frame covers a whole bay.

## Where
src/ports/inbound/detection-ingestion.port.ts.
