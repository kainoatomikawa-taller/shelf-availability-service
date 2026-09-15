/**
 * Platform — the composition root and the infrastructure the hexagon is deployed into.
 *
 * Everything inward of here is expressed in the domain's vocabulary and knows
 * nothing about schemas, keys, topics or clusters. This layer is where a
 * `RetailerId` stops being a partition key in a record and becomes a schema, a
 * role, a KMS alias, a topic prefix and a consumer group — which is the point at
 * which "no cross-retailer pooling" stops being a modelling invariant and starts
 * being a property of the infrastructure.
 *
 *  - `tenancy`     who the pilots are, and the one slug every physical name derives from
 *  - `encryption`  encryption at rest, per-retailer keys, what a deployment refuses
 *  - `retention`   how long each data class lives, and the ladder between them
 *  - `data-store`  per-retailer relational and time-series stores, and their DDL
 *  - `event-bus`   topics per source and per retailer, with ACLs and sizing
 *  - `container`   the DI container: every port bound to its adapter, per retailer
 *  - `deployment`  the pilot plan — 2–4 retailers, 9–15 months — and its manifest
 *  - `runtime`     the plan, wired: one container and one consumer per retailer
 *
 * No driver, no client library, no IO. A deployment supplies those through
 * `RetailerInfrastructure`, which keeps this package testable end to end without
 * a socket and keeps a broker or database choice out of the domain.
 */
export * from './tenancy.js';
export * from './encryption.js';
export * from './retention.js';
export * from './data-store.js';
export * from './event-bus.js';
export * from './container.js';
export * from './deployment.js';
export * from './runtime.js';
