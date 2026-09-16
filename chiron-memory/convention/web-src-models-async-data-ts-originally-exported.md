---
id: 56f75b13-1677-40f5-92b5-d5debce3f1e5-18
type: convention
title: `web/src/models/async-data.ts` originally exported a helper named `fail`, which collided…
tags: [convention]
created: 2026-09-16
resource: web/src/models/async-data.ts, web/src/models/result.ts, web/src/models/index.ts, web/src/state/reducer.ts.
---
`web/src/models/async-data.ts` originally exported a helper named `fail`, which collided with `result.ts`'s `fail` when both were re-exported from the `models` barrel (`index.ts`); it was renamed to `failed`.

## Why
TypeScript barrel re-export ambiguity error (TS2308) on build.

## Where
web/src/models/async-data.ts, web/src/models/result.ts, web/src/models/index.ts, web/src/state/reducer.ts.
