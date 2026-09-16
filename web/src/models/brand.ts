/**
 * Nominal typing helper, mirroring the domain package's.
 *
 * The dashboard keeps its own copy rather than importing the domain's: the two
 * are separate deployables and the frontend must not gain a runtime dependency
 * on the service's source tree. The shape is identical on purpose, so the wire
 * contract conformance checks in `services/contract-conformance.ts` can compare
 * the two families of ids by key rather than by brand.
 */
declare const brand: unique symbol;

export type Brand<T, B extends string> = T & { readonly [brand]: B };
