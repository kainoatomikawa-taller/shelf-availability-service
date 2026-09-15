---
id: e296a351-330a-4e25-910f-e33a1630cbb5-7
type: convention
title: EslUnavailableReason is treated as an open/additive union that adapters can extend (e.g.…
tags: [convention]
created: 2026-09-15
resource: src/ports/outbound/esl-actuation.port.ts
---
EslUnavailableReason is treated as an open/additive union that adapters can extend (e.g. new 'expression_expired' value for refresh on an unknown/lapsed expression) without an exhaustive switch elsewhere breaking

## Why
reporting a lapsed-expression refresh as 'tag_unbound' would misrepresent the failure cause; the union is designed so new reasons can be added safely

## Where
src/ports/outbound/esl-actuation.port.ts
