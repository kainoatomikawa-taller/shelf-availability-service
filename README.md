# Closed-Loop On-Shelf Availability Service

This project turns Instacart’s existing shelf detection technology into a closed-loop service that identifies inventory issues, assigns store employees tasks to fix them, and verifies resolution.

This repository currently contains the **domain substrate**: the facing-level model, its
time-ordered event history, the typed task lifecycle, the Carrot Tags LED lane mapping, the
availability index and the verification rule — all as pure, dependency-free domain logic.

```
npm install
npm run typecheck   # tsc --noEmit, strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
npm test            # vitest
npm run build       # emits dist/
```

## The model

```
signal (×6 sources) ──▶ Facing ──▶ FacingStateEvent ──▶ Task ──▶ VerificationPass ──▶ verified
                          │                                                              │
                          └──────────────▶ AvailabilityIndex            AuditLogEntry ◀──┘
```

### Facing — the addressable unit

`src/domain/facing/facing.ts`

One product, in one slot, on one shelf, in one store, for one retailer. Every upstream system
reports against the same facing identity, and the aggregate holds the latest observation from each
of the six sources plus the full transition history — so a facing answers both *"what does every
system currently say?"* and *"what has actually happened here?"* without a join.

| Source | Signal | Contributes |
| --- | --- | --- |
| `shopper_scan` | Shopper picking an order at the shelf | Highest-trust in/out-of-stock evidence |
| `arpalus_detection` | Shelf-vision run | In/out of stock via void ratio and detected facings |
| `caper_frame` | Smart-cart camera frame | In/out of stock via visibility and gap width |
| `planogram_record` | Authored shelf plan | Expectation; parks delisted facings in `unknown` |
| `carrot_tag_label` | Electronic label health and lit lane | Task triggers only — never the stock timeline |
| `pos_movement` | Sell-through vs. forecast | Phantom-inventory detection |

`SignalSnapshot` is a mapped type over the `SignalSource` union, so a seventh source cannot be added
without every facing gaining a slot for it.

### Event history

`src/domain/facing/event-history.ts`

Append-only and strictly time-ordered per facing. Events record **transitions only** — a
re-observation of the state the facing is already in is not an event — which keeps the history an
exact description of the step function the availability index integrates over. Appending validates
partition, facing identity, non-decreasing observation time, sequence number, and that the event's
`from` matches the facing's current state.

`unknown` is a first-class state alongside `in_stock` and `out_of_stock`: a facing nobody can see is
materially different from one observed to be stocked.

### Task lifecycle

`src/domain/task/task-state.ts`, `task.ts`

```
created ──▶ assigned ⇄ acknowledged ──▶ in_progress ──▶ awaiting_verification ──▶ verified
   │            │            │               │                    │
   └────────────┴────────────┴───────────────┴──▶ cancelled       └──▶ reopened ──▶ assigned
                                                  expired
```

`TaskState` is a discriminated union, not a status string beside a bag of nullable columns: each
state carries exactly the data that state can have. There is no way to read an assignee off a task
nobody has been assigned, or the verifying pass ids off a task that has not passed verification.
`applyTaskCommand` is total — every (state, command) pair has a defined answer — and returns a
`Result`, so the caller decides whether a rejection is a conflict or a swallowed retry.

Task types that do not touch physical stock (`price_label_correction`, `tag_maintenance`,
`audit_count`) close on resolution; the rest must survive verification.

### LED colour lanes

`src/domain/task/color-lane.ts`

| Task type | Standard lane |
| --- | --- |
| `restock_out_of_stock` | red |
| `replenish_low_stock` | amber |
| `misplaced_product` | blue |
| `planogram_correction` | purple |
| `price_label_correction` | cyan |
| `tag_maintenance` | white |
| `spoilage_removal` | pink |
| `audit_count` | teal |

**Green is reserved** for shopper pick guidance — it already means "pick this for an order" on every
Carrot Tag in the estate, so binding it to an OSA lane would make one light mean two things on the
same shelf. Retailers may override any other lane; `resolveColorLaneMap` merges the override onto the
standard map and validates the **result**, because a partial override can collide with a lane it
never mentions.

### Availability index

`src/domain/availability/availability-index.ts`

```
index = Σ in-stock facing-time / Σ measured facing-time
measured facing-time = in-stock + out-of-stock   (unknown time excluded)
```

Facing-time weighted, not facing-count averaged: a facing observed for ten minutes should not swing
the number as hard as one observed all day. Unknown time is excluded from both numerator and
denominator rather than counted as available (which flatters the score) or unavailable (which
punishes a retailer for a camera outage) — `coverage` is reported alongside so a high index computed
from a sliver of the window is visibly untrustworthy. An index over no measured time is `null`,
never `0`.

### Verification rule

`src/domain/availability/verification.ts`

**Two consecutive clean passes within 24 hours**, held as data (`STANDARD_VERIFICATION_RULE`) so a
retailer can tighten it without forking the evaluator. The decisions worth naming:

- Passes at or before `resolvedAt` are ignored — the loop closes on evidence gathered *after* the fix.
- "Consecutive" means no dirty pass in between. A dirty pass is decisive: the outcome is `regressed`
  and the caller reopens, rather than waiting out a fix that already failed once.
- A pair that drifts past 24h does not fail; the older pass is dropped and the newer one anchors a
  fresh streak.
- Two passes sharing an instant are not independent looks at the shelf. Duplicate `passId`s are
  deduplicated first, since redelivery is normal at the ingestion edge.

### Audit log

`src/domain/audit/audit-log.ts`

A domain entity, not a logging concern: retailers are shown why a facing was called out of stock,
why an employee was dispatched, and on what evidence the task was declared verified.

## Retailer partitioning

`retailerId` is a first-class field on every entity — facing, history, event, signal, task, lane map,
verification pass, availability index, audit log and audit entry all satisfy `RetailerPartitioned`.
Isolation is a modelling invariant rather than a query-time filter: there is no path in the domain
that pools data across retailers, so `assertSameRetailer` throws `CrossRetailerAccessError` instead
of quietly producing a wrong aggregate.

## Conventions

- **Pure domain, no IO.** No clock, no database, no network. Instants, ids and policies are passed in,
  which is what lets the same functions serve live ingestion, replay and back-testing.
- **Values, not mutable objects.** Every operation returns a new aggregate.
- **Branded ids and times.** `FacingId` cannot be passed where a `TaskId` is expected, and an
  `Instant` cannot be passed where a duration is.
- **Exhaustive unions.** Adding a signal source, task type, task state or LED colour is a compile-time
  breaking change everywhere it matters.

## Layout

```
src/domain/common/        brands, ids, time, errors, partition guard, Result
src/domain/facing/        shelf state, six signal sources, interpretation, event history, aggregate
src/domain/task/          task types, LED colour lanes, typed lifecycle states, task entity
src/domain/availability/  availability index, verification rule
src/domain/audit/         audit log entities
tests/                    unit tests (111), fixtures under tests/support
```
