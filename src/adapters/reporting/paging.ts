import type { Page, PageCursor, PageRequest } from '../../ports/common/paging.js';

/**
 * Offset paging behind an opaque cursor.
 *
 * The cursor is base64 rather than the offset itself, and that is not
 * decoration: the port contracts that callers treat it as meaningless and pass it
 * back verbatim, and a cursor that reads as `"25"` is one a caller will
 * eventually arithmetic on. Encoding it keeps the move to keyset paging — which a
 * real store will want for the audit export — a change inside this file.
 */

const encode = (offset: number): PageCursor =>
  Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url') as PageCursor;

/** `0` for a null or unreadable cursor: a caller restarting is not an error. */
export function decodeCursor(cursor: PageCursor | null): number {
  if (cursor === null) return 0;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed === 'object' && parsed !== null && 'o' in parsed) {
      const offset = (parsed as { readonly o: unknown }).o;
      if (typeof offset === 'number' && Number.isInteger(offset) && offset >= 0) return offset;
    }
  } catch {
    // Falls through to the start of the result set.
  }
  return 0;
}

/**
 * Cuts one page out of an already-ordered list.
 *
 * `totalEstimate` is exact here because the list is in hand; an implementation
 * that streams from a store would return `null` rather than pay for a count.
 */
export function pageOf<T>(items: readonly T[], request: PageRequest): Page<T> {
  const offset = decodeCursor(request.cursor);
  const limit = Math.max(1, Math.floor(request.limit));
  const slice = items.slice(offset, offset + limit);
  const next = offset + slice.length;

  return {
    items: slice,
    nextCursor: next < items.length ? encode(next) : null,
    totalEstimate: items.length,
  };
}
