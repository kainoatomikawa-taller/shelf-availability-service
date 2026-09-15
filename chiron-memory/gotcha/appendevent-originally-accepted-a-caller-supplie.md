---
id: f1821784-434c-4a25-9d5a-54bf9a6a0ed4-10
type: gotcha
title: appendEvent originally accepted a caller-supplied sequence number without validating it…
tags: [gotcha]
created: 2026-09-15
resource: src/domain/facing/event-history.ts
---
appendEvent originally accepted a caller-supplied sequence number without validating it against the history, allowing gaps/duplicates

## Learned
sequence numbers must be validated against the current history state on every append, not trusted from the caller

## Where
src/domain/facing/event-history.ts
