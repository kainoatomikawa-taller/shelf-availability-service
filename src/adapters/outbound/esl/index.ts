/**
 * ESL actuation — the driven adapters for the five shelf-edge fleets.
 *
 * One `EslVendorProfile` per fleet holds what is genuinely vendor-specific: the
 * tag models it sells, what each model can express, its request body and its
 * refusal codes. One shared adapter holds everything else — the degradation
 * ladder, the lease, idempotency per task and facing, the batch limit and the
 * per-tag command interval — so all five fleets behave identically everywhere
 * they are not actually different.
 */
export * from './tag-model.js';
export * from './gateway.js';
export * from './degradation.js';
export * from './fleet-adapter.js';
export * from './registry.js';

export { vusionProfile } from './vendors/vusion.js';
export { aperionProfile } from './vendors/aperion.js';
export { solumProfile } from './vendors/solum.js';
export { pricerProfile } from './vendors/pricer.js';
export { hashowProfile } from './vendors/hashow.js';
