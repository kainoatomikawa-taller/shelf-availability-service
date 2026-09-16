---
id: 56f75b13-1677-40f5-92b5-d5debce3f1e5-0
type: architecture
title: The store-operations dashboard lives in a separate `web/` npm workspace (React 19 + Vite)…
tags: [architecture]
created: 2026-09-16
resource: web/package.json, root package.json.
---
The store-operations dashboard lives in a separate `web/` npm workspace (React 19 + Vite) alongside the root domain package, wired into the root `package.json` workspaces with `typecheck:web`/`test:web`/`dev:web` scripts.

## Why
Keeps the pure domain package (no IO, no framework) decoupled from the dashboard's UI/framework code.

## Where
web/package.json, root package.json.
