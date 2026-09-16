---
id: 56f75b13-1677-40f5-92b5-d5debce3f1e5-11
type: gotcha
title: The chiron-memory MCP tools (`chiron-memory`, `chiron-ontology`) can be unavailable…
tags: [gotcha]
created: 2026-09-16
---
The chiron-memory MCP tools (`chiron-memory`, `chiron-ontology`) can be unavailable (`CONNECTION_CLOSED`), and the `chiron memory search` CLI can fail with "No project in scope" when run outside an active chiron session. · How to apply: fall back to reading the canonical memory markdown directly from the `chiron-memory/` directory in the repo (start from `chiron-memory/index.md` and the relevant `_index.md` per category).
