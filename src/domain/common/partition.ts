import { CrossRetailerAccessError } from './errors.js';
import type { RetailerId } from './ids.js';

/**
 * Structural contract for "this entity lives in exactly one retailer partition".
 * Every aggregate, event, signal, task, pass and audit entry implements it, which
 * is what makes acceptance criterion 7 checkable by the compiler rather than by
 * code review.
 */
export interface RetailerPartitioned {
  readonly retailerId: RetailerId;
}

export const partitionKeyOf = (entity: RetailerPartitioned): RetailerId => entity.retailerId;

/** Narrowing guard used when reading from untyped transport or storage layers. */
export const belongsToRetailer = <T extends RetailerPartitioned>(
  entity: T,
  expected: RetailerId,
): boolean => entity.retailerId === expected;

export function assertSameRetailer(
  expected: RetailerId,
  entity: RetailerPartitioned,
  context: string,
): void {
  if (entity.retailerId !== expected) {
    throw new CrossRetailerAccessError(expected, entity.retailerId, context);
  }
}

/**
 * Asserts a whole collection sits in one partition and returns it unchanged, so
 * call sites can wrap an input list inline:
 *   `for (const s of assertSinglePartition(retailer, signals, 'ingest'))`
 */
export function assertSinglePartition<T extends RetailerPartitioned>(
  expected: RetailerId,
  entities: readonly T[],
  context: string,
): readonly T[] {
  for (const entity of entities) {
    assertSameRetailer(expected, entity, context);
  }
  return entities;
}
