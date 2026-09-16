---
id: 56f75b13-1677-40f5-92b5-d5debce3f1e5-17
type: convention
title: Decoders in `web/src/services/decode.ts` throw a `DecodeFailure` wrapper on malformed…
tags: [convention]
created: 2026-09-16
resource: web/src/services/decode.ts, web/src/services/http-client.ts.
---
Decoders in `web/src/services/decode.ts` throw a `DecodeFailure` wrapper on malformed payloads; `http-client.ts` catches that specific error type and converts it into a `ServiceError` Result rather than letting it propagate as an uncaught exception, so decode errors follow the same Result-based contract as network/HTTP errors.

## Where
web/src/services/decode.ts, web/src/services/http-client.ts.
