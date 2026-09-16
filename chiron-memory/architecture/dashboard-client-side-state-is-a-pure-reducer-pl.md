---
id: 56f75b13-1677-40f5-92b5-d5debce3f1e5-5
type: architecture
title: Dashboard client-side state is a pure reducer plus a small framework-agnostic store,…
tags: [architecture]
created: 2026-09-16
resource: web/src/state/store.ts, web/src/state/reducer.ts, web/src/state/react/context.tsx.
---
Dashboard client-side state is a pure reducer plus a small framework-agnostic store, exposed to React via a `useSyncExternalStore`-based binding rather than a state-management library.

## Where
web/src/state/store.ts, web/src/state/reducer.ts, web/src/state/react/context.tsx.
