---
id: 56f75b13-1677-40f5-92b5-d5debce3f1e5-14
type: gotcha
title: `web`'s nested `node_modules` can silently hoist a `vite` version (7.3.6) that violates…
tags: [gotcha]
created: 2026-09-16
resource: web/package.json, package-lock.json.
---
`web`'s nested `node_modules` can silently hoist a `vite` version (7.3.6) that violates the pinned `^5.4.21` in `web/package.json`, because `@vitejs/plugin-react`'s broad peer range (`^4.2.0 || ^5.0.0 || ^6.0.0 || ^7.0.0 || ^8.0.0`) doesn't stop npm from installing a mismatched nested copy.

## Why
npm workspace hoisting picked a version satisfying the plugin's peer range but not the app's own pin, so `npm ls vite --all` showed two different versions in the same tree. · How to apply: after `npm install`, verify with `npm ls vite --all`; if mismatched, force with `npm install --workspace @osa/dashboard --save-dev vite@^5.4.21`.

## Where
web/package.json, package-lock.json.
