---
id: 56f75b13-1677-40f5-92b5-d5debce3f1e5-4
type: config
title: In `web/tsconfig.json`, the path aliases point at subfolders, not the src root
tags: [config]
created: 2026-09-16
resource: web/tsconfig.json.
---
In `web/tsconfig.json`, the path aliases point at subfolders, not the src root: `@osa/domain/*` → `../src/domain/*` and `@osa/ports/*` → `../src/ports/*`.

## Why
Needed so `contract-conformance.ts` can import the actual port/domain types for the compile-time conformance check.

## Where
web/tsconfig.json.
