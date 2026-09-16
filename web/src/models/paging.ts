import type { Brand } from './brand';

/**
 * Opaque continuation token. The dashboard treats it as meaningless and hands it
 * back verbatim, so the service can move from offset to keyset paging without
 * the dashboard noticing.
 */
export type PageCursor = Brand<string, 'PageCursor'>;

export const pageCursor = (raw: string): PageCursor => raw as PageCursor;

export interface PageRequest {
  /** Maximum items to return. The service may return fewer, never more. */
  readonly limit: number;
  /** `null` starts at the beginning of the result set. */
  readonly cursor: PageCursor | null;
}

export interface Page<T> {
  readonly items: readonly T[];
  /** `null` when the result set is exhausted. */
  readonly nextCursor: PageCursor | null;
  /** Total matching items when the service could count them cheaply, else `null`. */
  readonly totalEstimate: number | null;
}

export const firstPage = (limit: number): PageRequest => ({ limit, cursor: null });

export const nextPage = (page: Page<unknown>, limit: number): PageRequest | null =>
  page.nextCursor === null ? null : { limit, cursor: page.nextCursor };

/**
 * Append a freshly fetched page to what is already on screen.
 *
 * De-duplicates on the caller's key: a keyset cursor can legitimately re-emit a
 * boundary row when the underlying data shifted between requests, and a table
 * that renders the same facing twice looks like a data bug to a store manager.
 */
export const appendPage = <T>(
  current: Page<T>,
  incoming: Page<T>,
  keyOf: (item: T) => string,
): Page<T> => {
  const seen = new Set(current.items.map(keyOf));
  const added = incoming.items.filter((item) => !seen.has(keyOf(item)));
  return {
    items: [...current.items, ...added],
    nextCursor: incoming.nextCursor,
    totalEstimate: incoming.totalEstimate ?? current.totalEstimate,
  };
};

export const emptyPage = <T>(): Page<T> => ({ items: [], nextCursor: null, totalEstimate: 0 });
