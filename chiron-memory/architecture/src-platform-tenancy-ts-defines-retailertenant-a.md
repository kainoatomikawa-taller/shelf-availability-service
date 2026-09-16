---
id: 63094f91-5ed0-4b9a-80ca-784123f72f65-2
type: architecture
title: `src/platform/tenancy.ts` defines `RetailerTenant` and `namespacesOf`, the single…
tags: [architecture]
created: 2026-09-16
resource: src/platform/tenancy.ts
---
`src/platform/tenancy.ts` defines `RetailerTenant` and `namespacesOf`, the single derivation point for every physical name (DB schema, DB role, topic prefix, consumer group) from one strictly-validated `TenantSlug`.

## Why
Prevents naming drift — one place decides how a retailer's slug becomes a schema name, a topic prefix, etc., instead of each subsystem inventing its own convention.

## Learned
`assertDistinctTenants` refuses a shared slug, id, or encryption key across tenants, catching pilot misconfiguration at plan time.

## Where
src/platform/tenancy.ts
