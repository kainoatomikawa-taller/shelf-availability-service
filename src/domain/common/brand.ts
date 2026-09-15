/**
 * Nominal typing helper.
 *
 * Identifiers in this domain are all strings on the wire, but conflating a
 * `FacingId` with a `TaskId` is a class of bug that must not survive compilation
 * — especially since several of them travel together through the same functions.
 */
declare const brand: unique symbol;

export type Brand<T, B extends string> = T & { readonly [brand]: B };
