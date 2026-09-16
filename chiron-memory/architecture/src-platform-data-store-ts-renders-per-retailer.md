---
id: 63094f91-5ed0-4b9a-80ca-784123f72f65-5
type: architecture
title: `src/platform/data-store.ts` renders per-retailer DDL
tags: [architecture]
created: 2026-09-16
resource: src/platform/data-store.ts
---
`src/platform/data-store.ts` renders per-retailer DDL: dedicated schema + role, `REVOKE PUBLIC`, pinned `search_path`, per-table `CHECK (retailer_id = '…')`, and `FORCE ROW LEVEL SECURITY`.

## Why
Enforces logical partitioning at the database level (not just application filtering) so no query can accidentally read across retailers.

## Learned
Retailer ids are escaped before being interpolated into a SQL literal to avoid injection when generating DDL.

## Where
src/platform/data-store.ts
