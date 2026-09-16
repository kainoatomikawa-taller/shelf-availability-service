---
id: 56f75b13-1677-40f5-92b5-d5debce3f1e5-15
type: gotcha
title: The initial task-queue urgency comparator sorted queues newest-first instead of…
tags: [gotcha]
created: 2026-09-16
resource: web/src/models/task-queue.ts (compareQueuesByUrgency).
---
The initial task-queue urgency comparator sorted queues newest-first instead of oldest-first (most-urgent = oldest unresolved item first).

## Why
caught by a unit test asserting queue order, not by manual inspection. · How to apply: urgency ordering must be ascending by age/staleness, not by recency.

## Where
web/src/models/task-queue.ts (compareQueuesByUrgency).
