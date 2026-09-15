---
id: e296a351-330a-4e25-910f-e33a1630cbb5-1
type: decision
title: When a vendor's tag cannot render the exact task color, the adapter drops to a text/blink…
tags: [decision]
created: 2026-09-15
resource: src/adapters/outbound/esl/degradation.ts
---
When a vendor's tag cannot render the exact task color, the adapter drops to a text/blink fallback rather than substituting the nearest available color

## Why
an amber task lit red is a worse failure than the same task shown as plain text — a wrong color reads as a false signal

## Where
src/adapters/outbound/esl/degradation.ts
