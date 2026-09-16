import type { ReactNode } from 'react';
import type { ServiceError } from '../services/errors';
import { EmptyState, ErrorPanel, Skeleton } from './AsyncStates';

export interface Column<T> {
  readonly key: string;
  readonly header: string;
  /** Right-aligned and tabular, for anything a reader compares down a column. */
  readonly numeric?: boolean;
  readonly render: (row: T) => ReactNode;
  /** The sort this column requests when its header is clicked. */
  readonly sortKey?: string;
  /** Screen-reader description when the header alone is too terse. */
  readonly description?: string;
}

export interface DataTableProps<T> {
  readonly caption: string;
  readonly columns: readonly Column<T>[];
  readonly rows: readonly T[];
  readonly rowKey: (row: T) => string;
  readonly loading?: boolean;
  readonly error?: ServiceError | null;
  readonly onRetry?: (() => void) | undefined;
  readonly emptyMessage?: string;
  readonly activeSort?: string | undefined;
  readonly onSort?: ((sortKey: string) => void) | undefined;
  /** Present when the service says there is another page. */
  readonly onLoadMore?: (() => void) | undefined;
  readonly loadingMore?: boolean;
  /** "Showing 50 of ~1,240" — `null` when the service could not count cheaply. */
  readonly totalEstimate?: number | null;
}

/**
 * The table view.
 *
 * Present on every screen that has a chart, and not as an afterthought: three of
 * the categorical slots sit below 3:1 against the light surface, and the relief
 * for that is exactly this — the same numbers, readable without relying on hue
 * or on reading a position off an axis.
 */
export const DataTable = <T,>({
  caption,
  columns,
  rows,
  rowKey,
  loading = false,
  error = null,
  onRetry,
  emptyMessage = 'No rows for this scope.',
  activeSort,
  onSort,
  onLoadMore,
  loadingMore = false,
  totalEstimate,
}: DataTableProps<T>) => {
  if (error !== null && rows.length === 0) {
    return <ErrorPanel error={error} onRetry={onRetry} />;
  }

  return (
    <div>
      <div className="osa-table-wrap">
        <table className="osa-table">
          <caption>
            {caption}
            {totalEstimate !== undefined && totalEstimate !== null && rows.length > 0 ? (
              <span className="osa-micro">
                {' '}
                Showing {rows.length} of ~{totalEstimate.toLocaleString('en')}
              </span>
            ) : null}
          </caption>
          <thead>
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={column.numeric === true ? 'osa-table__cell--numeric' : undefined}
                  aria-sort={
                    column.sortKey !== undefined && column.sortKey === activeSort
                      ? ariaSortOf(column.sortKey)
                      : undefined
                  }
                >
                  {column.sortKey !== undefined && onSort !== undefined ? (
                    <SortableHeader
                      header={column.header}
                      sortKey={column.sortKey}
                      active={column.sortKey === activeSort}
                      onSort={onSort}
                    />
                  ) : (
                    column.header
                  )}
                  {column.description === undefined ? null : (
                    <span className="osa-visually-hidden">. {column.description}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* Skeleton rows rather than a spinner: the table keeps its shape, so
                the page does not jump when the real rows arrive. */}
            {loading && rows.length === 0
              ? Array.from({ length: 5 }, (_, index) => (
                  <tr key={`skeleton-${index}`}>
                    {columns.map((column) => (
                      <td key={column.key}>
                        <Skeleton height="1em" label={index === 0 ? 'Loading rows' : ''} />
                      </td>
                    ))}
                  </tr>
                ))
              : rows.map((row) => (
                  <tr key={rowKey(row)}>
                    {columns.map((column) => (
                      <td
                        key={column.key}
                        className={column.numeric === true ? 'osa-table__cell--numeric' : undefined}
                      >
                        {column.render(row)}
                      </td>
                    ))}
                  </tr>
                ))}
          </tbody>
        </table>
      </div>

      {!loading && rows.length === 0 ? <EmptyState message={emptyMessage} /> : null}

      {/* A failure that arrives while rows are already on screen sits under them:
          the rows are still true, they are just not the latest attempt's. */}
      {error !== null && rows.length > 0 ? <ErrorPanel error={error} onRetry={onRetry} /> : null}

      {onLoadMore === undefined ? null : (
        <div className="osa-table__more">
          <button type="button" className="osa-button" onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
};

/**
 * A header that asks for its own sort.
 *
 * Its own component so the click handler closes over the sort key alone: bound
 * directly, the handler would also receive React's click event as a second
 * argument and hand it to a caller that never asked for one.
 */
const SortableHeader = ({
  header,
  sortKey,
  active,
  onSort,
}: {
  readonly header: string;
  readonly sortKey: string;
  readonly active: boolean;
  readonly onSort: (sortKey: string) => void;
}) => (
  <button type="button" className="osa-table__sort" onClick={() => onSort(sortKey)}>
    {header}
    <span aria-hidden="true">{active ? sortGlyphOf(sortKey) : ''}</span>
  </button>
);

/**
 * The sort keys the read side speaks carry their direction in the name
 * (`index_asc`, `gap_count_desc`), so the header can announce it without the
 * caller passing a second, separately-maintained direction prop that could
 * disagree with the key it sits beside.
 */
const ariaSortOf = (sortKey: string): 'ascending' | 'descending' | 'other' => {
  if (sortKey.endsWith('_asc')) return 'ascending';
  if (sortKey.endsWith('_desc')) return 'descending';
  return 'other';
};

const sortGlyphOf = (sortKey: string): string => {
  const direction = ariaSortOf(sortKey);
  return direction === 'ascending' ? '▴' : direction === 'descending' ? '▾' : '•';
};
