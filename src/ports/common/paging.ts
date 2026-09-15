import type { Brand } from '../../domain/common/brand.js';

/**
 * Opaque continuation token. Adapters choose the encoding; callers must treat it
 * as meaningless and pass it back verbatim, so pagination can move from offset to
 * keyset without a contract change.
 */
export type PageCursor = Brand<string, 'PageCursor'>;

export interface PageRequest {
  /** Maximum items to return. Adapters may return fewer, never more. */
  readonly limit: number;
  /** `null` starts at the beginning of the result set. */
  readonly cursor: PageCursor | null;
}

export interface Page<T> {
  readonly items: readonly T[];
  /** `null` when the result set is exhausted. */
  readonly nextCursor: PageCursor | null;
  /**
   * Total matching items when the adapter can count them cheaply, otherwise
   * `null`. Never block a page on producing an exact count.
   */
  readonly totalEstimate: number | null;
}
