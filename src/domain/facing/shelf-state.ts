/**
 * What the shelf looks like at a facing.
 *
 * `unknown` is a first-class state, not a null: a facing with no fresh evidence
 * is materially different from one observed to be stocked, and the availability
 * index must exclude that time rather than score it as either good or bad.
 */
export type ShelfState = 'in_stock' | 'out_of_stock' | 'unknown';

export const SHELF_STATES: readonly ShelfState[] = ['in_stock', 'out_of_stock', 'unknown'] as const;

export const isStockBearing = (state: ShelfState): state is 'in_stock' | 'out_of_stock' =>
  state !== 'unknown';
