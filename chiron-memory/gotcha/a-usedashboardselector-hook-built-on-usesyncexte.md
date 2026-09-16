---
id: 56f75b13-1677-40f5-92b5-d5debce3f1e5-6
type: gotcha
title: A `useDashboardSelector` hook built on `useSyncExternalStore` looped infinitely ("Maximum…
tags: [gotcha]
created: 2026-09-16
resource: web/src/state/react/context.tsx.
---
A `useDashboardSelector` hook built on `useSyncExternalStore` looped infinitely ("Maximum update depth exceeded") when a selector returned a newly-allocated derived array/object on every call, since each snapshot compared unequal to the last.

## Why
`useSyncExternalStore` requires a stable snapshot reference for unchanged state. · How to apply: memoize the selector's snapshot keyed on state identity before returning it from the hook.

## Learned
caught only by an integration test that mounted a real component tree, not by unit tests of the reducer alone.

## Where
web/src/state/react/context.tsx.
