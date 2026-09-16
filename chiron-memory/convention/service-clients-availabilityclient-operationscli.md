---
id: 56f75b13-1677-40f5-92b5-d5debce3f1e5-9
type: convention
title: Service clients (`AvailabilityClient`, `OperationsClient`, `TaskPerformanceClient`,…
tags: [convention]
created: 2026-09-16
resource: web/src/services/http-client.ts, web/src/services/errors.ts, web/src/services/*.client.ts.
---
Service clients (`AvailabilityClient`, `OperationsClient`, `TaskPerformanceClient`, `ReportingClient`) return errors as values via a `ServiceError`/Result type rather than throwing, backed by one hand-rolled HTTP client that takes injected `fetch`/`sleep`, retries with bounded backoff honoring `Retry-After`, and supports per-request cancellation via `AbortController`/`signal`.

## Where
web/src/services/http-client.ts, web/src/services/errors.ts, web/src/services/*.client.ts.
