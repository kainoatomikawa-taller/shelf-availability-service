---
id: f1821784-434c-4a25-9d5a-54bf9a6a0ed4-6
type: decision
title: Retailer LED-lane overrides are validated against the merged (standard defaults +…
tags: [decision]
created: 2026-09-15
resource: src/domain/task/task-type.ts
---
Retailer LED-lane overrides are validated against the merged (standard defaults + overrides) map for lane exclusivity, and green is held back as a reserved lane for shopper pick guidance rather than being assignable to a task type

## Where
src/domain/task/task-type.ts
