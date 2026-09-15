---
id: bd3545d9-c982-4453-b7da-b4a543c2ec35-6
type: architecture
title: Outcome metric records accumulate incrementally as the verification loop runs…
tags: [architecture]
created: 2026-09-15
resource: src/application/outcome-metrics.ts
---
Outcome metric records accumulate incrementally as the verification loop runs (openOutcome → withTask → withTransition) rather than being re-derived from history after the fact

## Where
src/application/outcome-metrics.ts
