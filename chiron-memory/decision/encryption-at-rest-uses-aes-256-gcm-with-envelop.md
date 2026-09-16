---
id: 63094f91-5ed0-4b9a-80ca-784123f72f65-3
type: decision
title: Encryption at rest uses AES-256-GCM with envelope encryption, a per-retailer…
tags: [decision]
created: 2026-09-16
resource: src/platform/encryption.ts
---
Encryption at rest uses AES-256-GCM with envelope encryption, a per-retailer customer-managed key (data and backup keyed separately), and 90-day key rotation.

## Why
This is the control designed to fail closed if the other isolation controls (topic naming, RLS, schema partitioning) are bypassed — encryption is per-retailer even if something else leaks across tenants.

## Where
src/platform/encryption.ts
