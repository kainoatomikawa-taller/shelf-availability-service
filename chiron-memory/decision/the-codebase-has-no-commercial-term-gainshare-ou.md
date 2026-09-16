---
id: b2e7ca83-fe96-4ba2-94dc-5d5ff8ab2099-5
type: decision
title: The codebase has no commercial-term/gainshare/outcome-linked-pricing concept, so the…
tags: [decision]
created: 2026-09-16
---
The codebase has no commercial-term/gainshare/outcome-linked-pricing concept, so the acceptance criterion "before any outcome-linked commercial term is active" was interpreted as a stated deadline for when reconstruction must already work, not as something to model in code or tests.

## Why
grepping for outcome-linked/commercial/gainshare/contingent across src and README turned up nothing — there's nothing to test against. How to apply: this reading is documented in the new audit-reconstruction test suite's header comment and in the README rather than left implicit; don't attempt to add a commercial-term domain concept for this reason alone.
