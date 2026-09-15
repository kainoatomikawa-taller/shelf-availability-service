import type { Brand } from '../common/brand.js';
import type { CategoryId, DepartmentId, StoreId } from '../common/ids.js';

/**
 * Where a facing sits in the retailer's merchandising hierarchy.
 *
 * Deliberately *not* a field on `Facing`. A facing is a physical slot holding a
 * product; the department and category that product is merchandised under belong
 * to the retailer's taxonomy, are re-cut on a merchandising cadence, and change
 * without anything on the shelf moving. Resolving the classification alongside
 * the facing rather than inside it keeps a taxonomy re-org from rewriting the
 * aggregate and its append-only history.
 */
export interface MerchandisingClassification {
  readonly departmentId: DepartmentId;
  readonly categoryId: CategoryId;
}

/**
 * Grouping key for a category *within one store*.
 *
 * Revisit density — and therefore service-level scope — is measured per store,
 * never per chain: camera, cart and shopper traffic are physical properties of a
 * building. A chain-wide average would let a well-swept flagship carry a store
 * nobody walks, and the service would be committing to shelves it never sees.
 *
 * Opaque by design: JSON-encoded rather than delimiter-joined, because retailer
 * ids are arbitrary strings and any separator we picked could appear inside one.
 */
export type CategoryScopeKey = Brand<string, 'CategoryScopeKey'>;

export const categoryScopeKey = (
  storeId: StoreId,
  classification: MerchandisingClassification,
): CategoryScopeKey =>
  JSON.stringify([
    storeId,
    classification.departmentId,
    classification.categoryId,
  ]) as CategoryScopeKey;

export const sameCategory = (
  a: MerchandisingClassification,
  b: MerchandisingClassification,
): boolean => a.departmentId === b.departmentId && a.categoryId === b.categoryId;
