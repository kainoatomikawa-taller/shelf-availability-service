# Closed-Loop On-Shelf Availability Service

This project turns Instacart’s existing shelf detection technology into a closed-loop service that identifies inventory issues, assigns store employees tasks to fix them, and verifies resolution.

This repository currently contains the **domain substrate** — the facing-level model, its
time-ordered event history, the typed task lifecycle, the Carrot Tags LED lane mapping, the
availability index, the verification rule, and the gap ranking that decides what gets worked first,
all as pure, dependency-free domain logic — the **hexagonal boundary** of ports around it, and the
**application layer** that drives one across the other.

```
npm install
npm run typecheck   # tsc --noEmit, strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
npm test            # vitest
npm run build       # emits dist/
```

## The model

```
signal (×6 sources) ──▶ Facing ──▶ FacingStateEvent ──▶ Task ──▶ VerificationPass ──▶ verified
                          │  │                            ▲                              │
                          │  │                            └───── re-escalated ───────────┘
                          │  └──▶ DetectedGap ──▶ RankedGap (department × velocity × revisit density)
                          │
                          └──────────────▶ AvailabilityIndex            AuditLogEntry
```

A task is raised from the ranked gap, expressed on its lane at the shelf edge, and closed only when
two clean passes say the shelf actually recovered — otherwise it comes back round one rung more
urgent.

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

### Gaps and their ranking

`src/domain/gap/gap.ts`, `src/domain/gap/ranking.ts`, `src/domain/merchandising/`

The three things the loop finds wrong at a facing — an **availability gap**, a **price mismatch**,
a **planogram drift** — are one union rather than three pipelines, because they compete for the same
scarce resource: an employee's next ten minutes. `detectGaps` reads them off the aggregate as it
stands and never re-interprets signals, so a gap cannot disagree with the history it came from. A
delisted facing raises no drift: the slot is *supposed* to look wrong.

```
score = departmentWeight × kindWeight × salesVelocityUnitsPerDay × evidenceFactor
evidenceFactor = density / (density + threshold)
```

Department weights are configuration with a neutral default — one banner's "fresh" is another's four
departments, and a shipped table of names would be wrong everywhere it was not written. Sales
velocity is read off the POS window in units per day; when the feed is silent the gap is scored on
the policy's assumption and flagged `assumed` rather than handed an invented rate. Every term comes
back in `components`, because a store manager who disagrees with the order needs to see which factor
put a gap where it is.

`evidenceFactor` saturates: zero coverage contributes nothing, a category on the service-level floor
scores 0.5, one swept six times a day scores 0.75, and it never reaches 1 — so no amount of camera
traffic lets a slow seller outrank a fast one on coverage alone. The gap has already been detected,
so density is not about finding it; it is how fresh the evidence is and how fast the loop can close.

Ties break on gap age, then on gap id, so a re-run never reshuffles the list under a picker's hands.

### Revisit density and service-level scope

`src/domain/merchandising/revisit-density.ts`, `service-level.ts`

```
revisit density = passes / (facings × days)
```

Per facing *and* per day: passes-per-day alone rewards a category for being big, passes-per-facing
alone rewards a longer window. The denominator is **every facing in the category**, not every facing
that happened to be passed — a category where one facing of four hundred is swept twelve times a day
is not covered, and dividing by the facings we saw would score it as if it were. Measured per store,
never per chain: a well-swept flagship must not carry a store nobody walks.

**The floor is fixed at two passes per facing per day** and is deliberately not a retailer tuning
knob. It follows from what the loop physically needs: the verification rule closes a task on two
consecutive clean passes within 24 hours, so a category passed less than twice a day cannot, on
average, produce the evidence that closes a single task inside a day. Committing to a service level
there would be selling a loop that cannot close.

Categories below the floor are excluded from the *commitment*, not from the service: `rankGaps`
returns them in `excluded`, ranked among themselves, with the density they managed and the density
required. An unmeasured category is reported as `unmeasured` rather than as a failure — absence of
evidence must never read as qualification, and a retailer needs to know which of the two happened.

### Audit log

`src/domain/audit/audit-log.ts`

A domain entity, not a logging concern: retailers are shown why a facing was called out of stock,
why an employee was dispatched, and on what evidence the task was declared verified.

## Ports — the hexagonal boundary

`src/ports/` declares the interfaces this layer owns. Types and contract constants only: no
behaviour, no adapters. Every port is expressed in terms of the domain entities above, so the
boundary cannot describe a concept the domain does not have. The only JavaScript these modules emit
is the published contract data — schema versions, the detection source list, the degradation ladder,
the wire encoding.

| Direction | Port | Responsibility |
| --- | --- | --- |
| Inbound | `DetectionIngestionPort` | Versioned detection event schema for the five shelf-observing producers |
| Inbound | `AvailabilityQueryPort` | Availability index and the per-facing records behind it |
| Inbound | `TaskPerformanceQueryPort` | Task work rate, resolved-gap rate, detection-to-resolution latency |
| Inbound | `AuditExportPort` | Attestable export of the retained facing-state event log |
| Outbound | `EslActuationPort` | Expressing a task at the shelf edge, with graceful degradation |
| Outbound | `FacingRepositoryPort` | Loading and storing facing aggregates, partition-scoped |
| Outbound | `IngestionLedgerPort` | The stored state behind the idempotency guarantee |
| Outbound | `EventStreamConsumerPort` | The stream the five detection producers publish to |
| Outbound | `DeadLetterSinkPort` | Where records that cannot become detection events are set aside |

### Detection ingestion

`src/ports/inbound/detection-ingestion.port.ts`

**This layer owns the boundary**: the five producers adapt to the schema, not the other way round.
`DetectionSource` is derived as `Exclude<SignalSource, 'planogram_record'>` — five sources, not six,
because a planogram record is authored reference data describing what *should* be on the shelf, not
an observation of what is. Deriving it by exclusion means a seventh signal source forces an explicit
decision about which side of the boundary it belongs on.

One event carries an envelope plus many observations, because a single Arpalus pass or Caper frame
routinely covers a whole bay. Ingestion is idempotent on `envelope.idempotencyKey` and ordered by
`occurredAt`, never by arrival. Batches are single-partition by construction.

The wire schema is written out explicitly rather than derived from the domain, because a published
contract must not shift whenever an internal type is refactored. Exported conformance aliases give
the other half of that bargain: if the domain gains a required field the wire cannot supply, the
build fails and the drift becomes a version decision instead of a runtime surprise.

**Versioning.** `major.minor`. Minor is additive and backward compatible; anything else is a major.
The service accepts the current major and the previous major until that major's declared sunset
instant, unknown fields are ignored, and `describeSchemaContract()` publishes the whole policy so a
producer can negotiate before it sends anything.

### ESL actuation

`src/ports/outbound/esl-actuation.port.ts`

Built around graceful degradation, because shelf-edge hardware is heterogeneous and unreliable by
nature. The fleet declares what it can express (`EslFleetCapabilities`), the caller declares an
ordered fallback ladder (`modePreference`), and the result reports which rung was actually used
(`mode` plus `degraded`). The ladder runs `pick_to_light → lane_colour_steady → label_badge →
mono_indicator → none` and always terminates: `none` is a real answer meaning "route this to the
handheld task list", not a failure. Expressions are leased rather than set-and-forget, so a crashed
service leaves dark shelves rather than tags lit for work nobody is doing.

### Reporting and query

`src/ports/inbound/reporting.port.ts`

Every query is scoped to exactly one retailer — the same no-cross-retailer-pooling rule the domain
enforces on its aggregates, applied to the read model. There is no shape in the module that can
express a question spanning two retailers.

Index points carry their numerator and denominator alongside the ratio, so callers can re-aggregate
without re-querying and a figure computed from a sliver of measured time is visibly untrustworthy.
`ResolvedGapRatePoint` reports `awaitingVerification` separately and excludes it from the
denominator: a gap detected an hour before the window closes cannot have completed a 24-hour
verification, and counting it as unresolved understates the rate. `DetectionToResolutionPoint`
breaks the loop into stages — detection lag, dispatch lag, employee response, verification lag — so
a slow number can be attributed rather than argued about, and reports percentiles rather than a mean
because the tail is what a store manager actually experiences.

Task work rate exposes `labourHours` and `tasksPerLabourHour` as nullable: labour comes from the
retailer's workforce feed, and the service does not estimate it when that feed is absent.

### Audit export

`src/ports/inbound/audit-export.port.ts`

The contract this port exists to keep: **an auditor holding an export can recompute the reported
availability index and get the same number.** `FacingStateAuditRecord` therefore carries the carry-in
state, every timestamped transition, and the evidence behind each one — and the reported totals, so
a verifier can recompute and compare rather than trust. `tests/ports-contract.test.ts` exercises
exactly that: it reconstructs a `FacingTimeline` from a record using only what the record carries,
feeds it to the domain's own `computeFacingAvailability`, and asserts the answer matches.

`AuditCompleteness` states known gaps rather than hiding them — an export that quietly omits what it
could not retrieve is worse than no export, because the auditor recomputes a different number and
cannot tell whether the service or the export is wrong. `sealArtifact` returns a manifest with a
content hash and a retrieval handle; the body is fetched separately, since a period-length export
across a full estate will not fit in a response.

## Application layer

`src/application/`

Thin by design. Everything that decides what a signal *means*, what a transition *is*, or what a gap
is *worth* lives in the domain; what lives here is the sequencing between the ports and that logic.

**`normalizeDetectionEvent`** is the one place the published wire schema and the internal model know
about each other — both are written out independently so the contract cannot shift under a domain
refactor, and this is the seam where that independence is paid for. The switch is over the event
rather than a bare source string, so each branch narrows to the observations that source is
contracted to send and a sixth detection source is a compile error rather than a field that quietly
never arrives. `observedAt` comes from the envelope: one Arpalus pass saw every facing in the bay at
the same instant, and per-observation timestamps would invite sub-frame precision nobody has.

**`DetectionIngestionService`** implements `DetectionIngestionPort`. It loads every facing an event
touches *before* applying any of it — one event is one decision about a bay, and half-applying it
would leave a history no replay of the stream can reproduce. The idempotency ledger is written
*after* the aggregates: a crash in between replays the event, and a replay is a no-op the domain
already handles, since history records transitions only. Recording first would trade that harmless
repeat for a silently dropped observation. Batches are processed sequentially, because events in one
batch routinely touch the same facing.

**`rankGapsForWindow`** measures revisit density from the pass stream rather than accepting it as an
input. That is the point of the use case: the scope a retailer is held to has to follow from traffic
that actually happened, not from a number somebody typed into a config table and never revisited. It
returns the committed worklist, the excluded gaps, the per-department cut and the coverage behind all
of it. Pure — no clock, no IO — so the same call ranks a live store, replays last Tuesday, or
back-tests a different threshold.

**`planTasks` / `dispatchTasks`** turn that worklist into typed tasks and light them at the shelf.
The task type follows from the gap kind and the lane from the task type, so nothing reaches a tag as
untyped work and nothing lands on the reserved green lane — the mapping is data, it can arrive from
storage, and one light meaning two things on the same shelf is not worth discovering on the floor.
Priority is banded by worklist position, configuration with a neutral default for the same reason
department weights are: the platform does not own the retailer's staffing. Dispatch groups by store
because capabilities belong to the fleet in a building, batches to the gateway's declared limit, and
sends the caller's *unfiltered* ladder so `degraded` still means something. A fleet whose ladder
bottoms out at `none` is never called at all, and every task the shelf could not carry comes back in
`routedElsewhere` — a dark tag is not a closed loop.

**`decideVerification` / `runVerificationLoop`** close the loop or put the work back. A task verifies
at the instant its second clean pass landed, not when the evaluator noticed, so a scheduler running
late cannot inflate the verification lag it reports; passes after the evaluation instant are invisible,
because an evaluation is a statement about a moment. Two things re-escalate: a dirty pass after the
fix (the condition persisted) and a deadline of `resolvedAt + 24h` passing without the evidence (the
window lapsed). Evidence beats the deadline — a late evaluation still closes a task whose passes are
there, since the deadline exists to escalate *absent* evidence, not to discard present evidence.
Re-escalation reopens **and** raises urgency one rung, so work that bounced does not go back out at
the priority that already failed. The shell then clears the lane on a close and lights it again,
more urgently, on a bounce.

**`openOutcome` / `withTransition` / `computeOutcomeMetrics`** accumulate the outcome metrics as the
loop runs, rather than re-deriving them later by joining task rows back to facing history. Stage
anchors are a decision, not an accident: dispatch and response lag anchor on the *first* assignment
— how long the store took to pick the work up — while resolution and verification lag anchor on the
attempt that actually held, and rework is counted in `reopenCount` instead of being smeared into
either. Percentiles are nearest-rank, so every reported figure is a latency some gap really had.
Gaps are cohorted by detection so both reports describe one population, and the reports come back in
the shapes `TaskPerformanceQueryPort` publishes, broken down by department by default.

**`establishAvailabilityBaseline`** computes the retailer's prior on the same facing-time in-stock
definition the live index uses — the same `computeAvailabilityIndex`, not a second implementation of
it, because every claim the service makes later is a comparison against this number. It refuses to
call a baseline *established* below half coverage, under a full trading week, or with nothing
measured, and still publishes the figure with the shortfalls attached: withholding it only moves the
computation into somebody's spreadsheet without the caveat. `compareToBaseline` will not compute a
lift against a prior that was never established.

## Adapters — consuming the detection stream

`src/adapters/inbound/detection-stream/`

The outermost ring, and the only layer allowed to know a producer's field names, a vendor's enum
spellings or a broker's record shape. **This layer adapts to upstream producers**: each of the five
keeps its own dialect, and nothing is asked of any of them.

| Source | Topic | Producer version marker | What the adapter absorbs |
| --- | --- | --- | --- |
| `shopper_scan` | `osa.<retailer>.detections.shopper_scan` | `type` + `v` | One item per event, wrapped into the port's array shape; `REPLACED` → `substituted` |
| `arpalus_detection` | `osa.<retailer>.detections.arpalus_detection` | `schema` URN | `void_pct` (0–100) → a ratio; site nested under `site` |
| `caper_frame` | `osa.<retailer>.detections.caper_frame` | `eventType` + `version` | Epoch millis → `Instant`; `gapWidthMm` → centimetres |
| `carrot_tag_label` | `osa.<retailer>.detections.carrot_tag_label` | `proto` | Status and lamp codes → domain enums; `"5.99"` → 599 cents; a derived event id |
| `pos_movement` | `osa.<retailer>.detections.pos_movement` | `feed` + `feedVersion` | A start/end window → a duration observed at its *close* |

Topics are cut on two axes. **Per source**, so a vendor shipping a bad build poisons only its own
topic and its own consumer lag, and so per-source retention and partition counts can differ.
**Per retailer**, because a topic is the smallest thing a broker will authorise, retain and meter
separately: a producer credential scoped to `osa.<retailer>.*` is physically unable to name another
tenant's topic, which makes cross-tenant isolation something the broker enforces on connect rather
than something the consumer detects afterwards.

`DETECTION_SOURCE_ADAPTERS` is a mapped type over `DetectionSource`, so a sixth source is a compile
error until someone writes its adapter. An adapter names no topic — with topics per retailer there is
no single one to name — so the topic-to-adapter binding is a `DetectionSubscription`, generated by
the bus topology and handed to the consumer as wiring.

Detection topics carry one partition, because producers key by `retailerId` and a retailer's topic
holds exactly one retailer: every record hashes to the same partition whatever the count. That is a
real ceiling rather than a free win, so `assertTopicFitsOnePartition` projects each tenant's peak
load against it and fails the plan rather than letting a pilot discover the limit as consumer lag.

The unit conversions are the ones worth naming, because in each case the unconverted value is still a
*valid* number and fails silently: an unconverted 33.5% void reads as a void ratio of 33.5, far past
the 0.7 threshold, and empties a two-thirds-full shelf.

### Nothing in a payload can stop the consumer

Every failure that is a property of the data — unreadable bytes, bad JSON, an unknown producer
version, a missing field, a partition key disagreeing with the envelope, a rejection ingestion will
repeat on every retry — produces a dead letter and a disposition, never a throw. Five vendors on five
release cadences publish here, and one of them shipping a bad build must cost that vendor its own
dead-letter queue rather than costing every retailer their shelf detections. Only infrastructure
failures propagate, and those leave the batch uncommitted for redelivery, which is safe because
ingestion is idempotent.

Versions are checked *before* any field is read. Reading fields out of a payload whose version is
unrecognised is guessing, and guessing at the boundary is how a renamed field becomes a wrong shelf
state. A dead letter keeps the payload verbatim and names the offending field path — the audience is
the vendor engineer who has to reproduce it.

**Commit watermark.** `commitThrough` stops at the first record needing a retry, and rate limiting is
the only rejection that qualifies: it is the one a later attempt can turn into an acceptance. Every
other rejection is a fact about the event, and retrying it forever would wedge the partition behind
one bad message.

### The partition survives the whole trip

Three independent statements of which retailer a record belongs to have to agree before it becomes an
event: the **topic** it arrived on, fixed by the deployment; the **key** the producer chose; and the
**envelope** the payload declares. Each can be got wrong on its own — a credential pointed at the
wrong namespace, a partitioner bug, a copied payload — and each is caught here rather than becoming
one retailer's shelf data inside another's partition. A topic disagreement is its own dead-letter
reason (`topic_retailer_mismatch`) because it sends the producer's owner after a different fix than a
key mismatch does, and because it is the more serious of the two.

The batch handed to ingestion takes its `retailerId` from the *subscription*, never from a payload.
The partition is therefore known before a byte is decoded, and every event disagreeing with it was
already set aside — which is what makes "single-partition by construction" a fact about the code
rather than a property of a grouping step that happened to work.

## Retailer partitioning

`retailerId` is a first-class field on every entity — facing, history, event, signal, task, lane map,
verification pass, availability index, audit log and audit entry all satisfy `RetailerPartitioned`,
as do the boundary types: detection envelopes and batches, report scopes, ESL commands and
capabilities, and audit export scopes and artifacts.
Isolation is a modelling invariant rather than a query-time filter: there is no path in the domain
that pools data across retailers, so `assertSameRetailer` throws `CrossRetailerAccessError` instead
of quietly producing a wrong aggregate.

The invariant starts at the broker, not at the repository. A retailer's producers publish into their
own topic namespace, key the stream by `retailerId`, and the consumer refuses any record whose topic,
key and envelope do not all agree — so the first thing data does on entering this process is prove
which retailer it belongs to, and nothing downstream has to take that on trust.

## Platform — provisioning, the bus and the composition root

`src/platform/`

Where a `RetailerId` stops being a partition key in a record and becomes a schema, a role, a KMS
alias, a topic prefix and a consumer group. Everything physical is derived from one slug, in one
function (`namespacesOf`), so reviewing tenant isolation means reviewing that derivation and the
uniqueness checks over it rather than trusting each provisioning script to have followed a rule.

No driver, no client library, no IO. A deployment supplies those through `RetailerInfrastructure`,
which is what keeps the whole layer unit-testable and keeps a database or broker choice out of the
domain.

### Isolation is four controls deep, under a fifth

| Control | What it stops | Where |
| --- | --- | --- |
| A schema per retailer (`osa_<slug>`, `osa_<slug>_ts`) | Nothing is named without naming a tenant | `renderTenantBootstrapDDL` |
| A role per retailer, granted only that schema | A hand-written query reaching another tenant | `GRANT USAGE` / `ALTER DEFAULT PRIVILEGES` |
| A partition `CHECK` pinning `retailer_id` to a literal | A wrong-tenant row being written at all | `renderTenantIsolationDDL` |
| Row-level security, `FORCE`d | The table owner — which every migration runs as — being exempt | `CREATE POLICY tenant_isolation` |
| **A per-retailer encryption key** | All four of the above being bypassed at once | `standardEncryption` |

The last one is the only control that fails *closed*. Schemas, roles, checks and policies are each
something a future migration or a well-meant `GRANT` can undo without anyone noticing; if two
retailers' rows ever do end up in one place, a per-retailer key makes the second retailer's bytes
ciphertext the first retailer's key cannot open, and the incident is a decrypt error in a log rather
than a quiet cross-tenant read. `assertDistinctTenants` refuses any configuration where two retailers
share one.

Keys are customer-managed (a provider-managed key is one the retailer cannot revoke), live data and
backups are keyed separately (or a leaked snapshot reads as freely as the live store), and encryption
is envelope-based and typed as the literal `true` so a deployment cannot turn it off.

### Retention

Stated per **data class** rather than per table, because the reason a thing is kept is what decides
how long it is kept. The horizons are a mapped type over `DataClass`, so a new class is a compile
error until someone decides how long it lives — the alternative being a table that silently inherits
"keep forever".

| Class | Horizon | Why |
| --- | --- | --- |
| `dead_letter` | 14d | A verbatim vendor payload — the least sanitised thing stored, so the briefest kept |
| `ingestion_ledger` | 30d | Must outlive the broker's own topic retention, or a replay re-ingests as new |
| `detection_event` | 90d | Long enough to reprocess a policy change and answer "what did you receive from us" |
| `outcome_record`, `read_model_rollup` | 400d | The loop's own figures |
| `facing_history`, `task_record`, `audit_trail` | 550d | Covers a 15-month pilot plus a quarter, so no month becomes unreportable |
| `audit_artifact` | 1100d | Outlives the pilot — an artifact is what a retailer shows a third party afterwards |

`assertRetentionIsCoherent` enforces a ladder between them, and each rung exists because the reverse
is silently wrong rather than merely untidy: history must outlive the raw events it is integrated
from, nothing may be reported that can no longer be recomputed, and a dead letter must not outlive
the events it failed to become. `assertBusRetentionFits` compares two numbers that live in different
modules and are set by different concerns — topic retention and the ledger horizon — because a replay
past the ledger would double a retailer's history and move their availability index with it.

### The composition root

`Container` is scoped to a tenant, not to the process. A single container holding one pool and one
consumer would be a component that can, by construction, see two retailers' data, and every control
below it would be spent making sure it never did. One container per retailer means the pool is bound
to that tenant's role and schema, the consumer runs under that tenant's group, and no object in the
wiring holds two tenants' state at once. `RetailerRuntimes.require` is the single lookup where more
than one tenant is reachable; everything downstream of it has exactly one in scope.

`PortProviders` is a mapped type over `PortName`, so a port added to `ServicePorts` is a compile error
until it is bound — "did we wire everything" is answered by the compiler rather than by whichever
request first reaches the port nobody registered. The container builds this service's own code
(ingestion service, reporting adapter, stream consumer, ESL fleet adapters) and is *given* the four
driven ports that genuinely need a driver.

The read side is typed as `ReportingPort & AuditExportPort` on purpose: `availabilityQuery`,
`taskPerformanceQuery` and `auditExport` all resolve to that one binding, which is what keeps a figure
in a report and the artifact substantiating it the same arithmetic over the same read model rather
than three bindings that happen to agree.

### The pilot deployment

`planPilotDeployment` turns a list of retailers into schemas, roles, DDL, keys, topics, ACLs, consumer
groups and sizing — or refuses the list. Two to four retailers and a nine-to-fifteen-month window are
enforced rather than documented: one retailer cannot demonstrate isolation because there is nothing to
leak into, past four the per-retailer isolation costs more in clusters and keys than a pilot can
staff, and both bounds are the sort of number that gets exceeded by one during a hopeful quarter with
the consequences landing on whoever is on call.

Everything is validated at plan time, because a plan that fails halfway leaves one retailer
provisioned and another half-provisioned — a worse state than not having started. That includes the
check nobody remembers until it is asked for: that the retention horizons outlive the pilot they are
for, so month one is still reportable in month fourteen.

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
src/domain/merchandising/ department/category, revisit density, service-level floor, sales velocity
src/domain/gap/           detected gaps and their ranking
src/domain/audit/         audit log entities
src/ports/common/         paging, shared schema-versioning contract
src/ports/inbound/        detection ingestion, reporting/query, audit export
src/ports/outbound/       ESL actuation, facing repository, ingestion ledger, event stream,
                          dead-letter sink
src/application/          signal normalization, ingestion, gap ranking, task dispatch,
                          verification loop, outcome metrics, availability baseline
src/adapters/inbound/     event-stream consumers and the five per-source payload adapters
src/adapters/outbound/    ESL actuation adapters for the five shelf-edge fleets
src/adapters/reporting/   the read side behind both read ports and the audit export
src/platform/             tenancy, encryption, retention, per-retailer data stores, the event
                          bus topology, the DI container, the pilot deployment plan and runtime
tests/                    unit and integration tests (462), fixtures, in-memory ports, tenant
                          and infrastructure doubles, producer payloads under tests/support
```
