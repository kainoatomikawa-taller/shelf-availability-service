---
id: b2e7ca83-fe96-4ba2-94dc-5d5ff8ab2099-8
type: gotcha
title: The Vusion ESL vendor adapter's `encodeExpression` converts an absolute `expiresAt`…
tags: [gotcha]
created: 2026-09-16
resource: src/adapters/outbound/esl/vendors/vusion.ts.
---
The Vusion ESL vendor adapter's `encodeExpression` converts an absolute `expiresAt` Instant into a lifetime-in-seconds field (the format Vusion's API actually takes) and rounds that duration up, not down.

## Why
rounding down would let the expression lapse a beat before the closed loop expects to refresh it.

## Where
src/adapters/outbound/esl/vendors/vusion.ts.
