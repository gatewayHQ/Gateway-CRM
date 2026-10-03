import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Icon } from './Icon.jsx'
import { Button } from './Button.jsx'
import { EmptyState, Skeleton } from './Feedback.jsx'
import { useControllableState, useMediaQuery } from './hooks.js'
import { cx } from './cx.js'
import {
  ariaSort, cellValue, columnLabel, nextSort, paginate, pruneSelection, rangeLabel,
  resolveViewState, selectRange, selectionState, sortRows, toIdSet, toggleAll, toggleOne,
} from './dataTable.js'

/**
 * DataTable — the list view for CRM records. See docs/DESIGN_SYSTEM.md for the
 * full API; the short version:
 *
 *   <DataTable
 *     caption="Properties" noun={{ one: 'property', other: 'properties' }}
 *     columns={[
 *       { id: 'address', header: 'Address', accessor: streetLine, sortable: true, rowHeader: true },
 *       { id: 'price', header: 'Price', accessor: 'list_price', sortable: true, align: 'right',
 *         firstSortDir: 'desc', cell: p => formatCurrency(p.list_price), mobile: 'secondary' },
 *     ]}
 *     rows={filtered} loading={loading} error={error} onRetry={reload}
 *     filtered={hasFilters} onClearFilters={clearFilters}
 *     onRowClick={openDrawer} rowActions={p => <IconButton icon="trash" label="Delete" … />}
 *   />
 *
 * Handles, so pages don't each re-invent them: skeleton loading, refresh
 * without blanking, error with retry (full-panel when empty, a banner over
 * stale rows otherwise), empty vs. "no results for these filters", sorting
 * (aria-sort, announced), selection with shift-click ranges and a bulk-action
 * bar, client-side paging, keyboard-reachable row activation, and a card
 * layout on phones.
 */

// A click on any of these inside a row belongs to that control, not the row.
const OWN_CLICK = 'a, button, input, select, textarea, label, summary, [role="button"], [role="menuitem"], [role="checkbox"], [contenteditable], [data-row-click-ignore], [aria-modal="true"], .modal-backdrop, .drawer-backdrop'

const DEFAULT_NOUN = { one: 'row', other: 'rows' }

const errorText = (error) => (typeof error === 'string' ? error : error?.message || 'Something went wrong.')

// The full-panel and inline states DataTable and DataState share.
function ErrorPanel({ error, onRetry, noun, size }) {
  return (
    <EmptyState
      variant="error" size={size}
      title={`Couldn't load ${noun.other}`}
      description={<>{errorText(error)} Nothing has been lost.</>}
      action={onRetry && <Button icon="refresh" onClick={onRetry}>Try again</Button>}
    />
  )
}

function NoResultsPanel({ onClearFilters, noun, size }) {
  return (
    <EmptyState
      variant="no-results" size={size}
      title={`No ${noun.other} match these filters`}
      description="Try a different search, or clear the filters to see everything."
      action={onClearFilters && <Button onClick={onClearFilters}>Clear filters</Button>}
    />
  )
}

/** Progress bar while refreshing over existing rows; banner when that refresh failed. */
function RefreshStatus({ view, onRetry, noun }) {
  return (
    <>
      {view.refreshing && <div className="ui-table__progress" role="progressbar" aria-label={`Refreshing ${noun.other}`} />}
      {view.staleError && (
        <div role="alert" className="ui-banner ui-banner--error">
          <Icon name="alert" size={14} />
          <span>Couldn't refresh {noun.other} — showing what was last loaded.</span>
          {onRetry && <Button size="sm" variant="ghost" onClick={onRetry}>Retry</Button>}
        </div>
      )}
    </>
  )
}

function renderCell(col, row, index) {
  if (col.cell) return col.cell(row, { index })
  const v = cellValue(col, row)
  if (v == null || v === '') return <><span aria-hidden="true" className="ui-table__blank">—</span><span className="sr-only">None</span></>
  if (v instanceof Date) return v.toLocaleDateString()
  return String(v)
}

export function DataTable({
  columns, rows = [], getRowId = (r) => r.id, caption, captionHidden = true, noun = DEFAULT_NOUN,
  // states
  loading = false, error = null, onRetry,
  filtered = false, onClearFilters, emptyState, noResultsState,
  // sorting
  sort: sortProp, defaultSort = null, onSortChange, manualSort = false,
  // selection
  selectable = false, selectedIds, defaultSelectedIds = [], onSelectionChange, renderBulkActions,
  // rows
  onRowClick, getRowLabel, rowActions, rowActionsLabel = 'Actions', rowClassName,
  // paging
  pageSize = 50, pageResetKey, manualPagination,
  // presentation
  density = 'comfortable', layout = 'auto', mobileBreakpoint = 768, maxHeight, skeletonRows = 6,
  className,
}) {
  const narrow = useMediaQuery(`(max-width: ${mobileBreakpoint}px)`)
  const asCards = layout === 'cards' || (layout === 'auto' && narrow)

  const [sort, setSort] = useControllableState(sortProp, defaultSort, onSortChange)
  const [selected, setSelected] = useControllableState(selectedIds, defaultSelectedIds, onSelectionChange)
  const selectedSet = useMemo(() => toIdSet(selected), [selected])
  const [page, setPage] = useState(0)
  const [announcement, setAnnouncement] = useState('')
  const anchorRef = useRef(null)
  const headerCheckRef = useRef(null)
  const topRef = useRef(null)
  const sortSelectId = `${useId().replace(/:/g, '')}-sort`

  const visibleColumns = columns.filter(c => !c.hidden)
  const headerCol = visibleColumns.find(c => c.rowHeader) || visibleColumns[0]
  const labelFor = (row) => (getRowLabel ? getRowLabel(row) : String(cellValue(headerCol, row) ?? ''))

  // ── data pipeline: sort → page ──
  const sorted = useMemo(
    () => (manualSort ? rows : sortRows(rows, visibleColumns, sort)),
    [rows, sort, manualSort, columns], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const paged = manualPagination
    ? {
        rows: sorted,
        page: manualPagination.page,
        pageCount: Math.max(1, Math.ceil(manualPagination.total / manualPagination.pageSize)),
        total: manualPagination.total,
        start: manualPagination.total ? manualPagination.page * manualPagination.pageSize + 1 : 0,
        end: manualPagination.page * manualPagination.pageSize + sorted.length,
      }
    : paginate(sorted, page, pageSize)
  const pageRows = paged.rows
  const pageIds = pageRows.map(getRowId)

  // Back to page 1 when the filters (pageResetKey) or the sort change.
  useEffect(() => { setPage(0) }, [pageResetKey, sort?.id, sort?.dir])
  // Keep our page index in step with the clamp paginate() applied.
  useEffect(() => { if (!manualPagination && paged.page !== page) setPage(paged.page) }, [paged.page]) // eslint-disable-line react-hooks/exhaustive-deps

  // Rows that left the data set leave the selection (see pruneSelection).
  useEffect(() => {
    if (!selectable || manualPagination) return
    const next = pruneSelection(selectedSet, rows.map(getRowId))
    if (next) setSelected(next)
  }, [rows]) // eslint-disable-line react-hooks/exhaustive-deps

  const headState = selectionState(pageIds, selectedSet)
  useEffect(() => {
    if (headerCheckRef.current) headerCheckRef.current.indeterminate = headState === 'some'
  }, [headState, asCards])

  const view = resolveViewState({ loading, error, rowCount: rows.length, filtered })
  const busy = view.state === 'loading' || view.refreshing

  // ── handlers ──
  const changeSort = (col) => {
    const next = nextSort(sort, col.id, col.firstSortDir || 'asc')
    setSort(next)
    setAnnouncement(next ? `Sorted by ${columnLabel(col)}, ${next.dir === 'asc' ? 'ascending' : 'descending'}` : 'Sort cleared')
  }

  const goToPage = (p) => {
    if (manualPagination) manualPagination.onPageChange?.(p)
    else setPage(p)
    const n = manualPagination ? manualPagination.pageSize : pageSize
    const start = p * n + 1
    setAnnouncement(`Page ${p + 1} of ${paged.pageCount}, ${noun.other} ${start} to ${Math.min(start + n - 1, paged.total)}`)
    topRef.current?.scrollIntoView?.({ block: 'nearest' })
  }

  const onCheck = (e, id) => {
    const next = e.nativeEvent?.shiftKey && anchorRef.current != null
      ? selectRange(pageIds, anchorRef.current, id, selectedSet)
      : toggleOne(id, selectedSet)
    anchorRef.current = id
    setSelected(next)
  }

  const onRowClickCapture = (e, row) => {
    if (!onRowClick) return
    // Events from portals bubble through React but aren't inside the row's DOM.
    if (!e.currentTarget.contains(e.target)) return
    const own = e.target.closest(OWN_CLICK)
    if (own && e.currentTarget.contains(own)) return
    // Someone selecting an address to copy it isn't asking to open the record.
    if (typeof window !== 'undefined' && window.getSelection?.().toString()) return
    onRowClick(row, e)
  }

  const headerContent = (col, row, index) => {
    const content = renderCell(col, row, index)
    if (!onRowClick) return content
    return (
      <button
        type="button" className="ui-table__row-link"
        onClick={(e) => onRowClick(row, e)}
        aria-label={getRowLabel ? getRowLabel(row) : undefined}
      >
        {content}
      </button>
    )
  }

  const selectedRows = useMemo(
    () => (selectedSet.size ? rows.filter(r => selectedSet.has(getRowId(r))) : []),
    [rows, selectedSet], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const clearSelection = () => { setSelected([]); anchorRef.current = null }

  // ── full-panel states ──
  let panel = null
  if (view.state === 'error') {
    panel = <ErrorPanel error={error} onRetry={onRetry} noun={noun} size="sm" />
  } else if (view.state === 'no-results') {
    panel = noResultsState || <NoResultsPanel onClearFilters={onClearFilters} noun={noun} size="sm" />
  } else if (view.state === 'empty') {
    panel = emptyState || <EmptyState size="sm" title={`No ${noun.other} yet`} />
  }

  const skeletonCount = Math.min(skeletonRows, pageSize || skeletonRows)
  // Card layout: which columns form the subtitle line and the label/value grid.
  const secondaryCols = visibleColumns.filter(c => c !== headerCol && c.mobile === 'secondary')
  const metaCols = visibleColumns.filter(c => c !== headerCol && (c.mobile ?? 'meta') === 'meta')

  const statusText = announcement || (view.state === 'loading' ? `Loading ${noun.other}…` : '')
  const showFooter = view.state === 'ready' && paged.pageCount > 1
  const sortable = visibleColumns.filter(c => c.sortable)

  return (
    <div ref={topRef} className={cx('ui-table', `ui-table--${density}`, asCards && 'ui-table--cards', className)}>
      <div role="status" className="sr-only">{statusText}</div>

      <RefreshStatus view={view} onRetry={onRetry} noun={noun} />

      {selectable && selectedSet.size > 0 && (
        <div className="ui-table__bulk" role="region" aria-label="Bulk actions">
          <span className="ui-table__bulk-count">{selectedSet.size.toLocaleString()} selected</span>
          <Button size="sm" variant="ghost" onClick={clearSelection}>Clear</Button>
          <div className="ui-table__bulk-actions">{renderBulkActions?.(selectedRows, { clear: clearSelection })}</div>
        </div>
      )}

      {asCards && sortable.length > 0 && view.state === 'ready' && (
        <div className="ui-table__mobile-sort">
          <label className="sr-only" htmlFor={sortSelectId}>Sort by</label>
          <select
            id={sortSelectId}
            className="filter-select"
            value={sort?.dir ? `${sort.id}:${sort.dir}` : ''}
            onChange={(e) => {
              const [id, dir] = e.target.value.split(':')
              setSort(id ? { id, dir } : null)
            }}
          >
            <option value="">Default order</option>
            {sortable.flatMap(c => [
              <option key={`${c.id}:asc`} value={`${c.id}:asc`}>{columnLabel(c)}, ascending</option>,
              <option key={`${c.id}:desc`} value={`${c.id}:desc`}>{columnLabel(c)}, descending</option>,
            ])}
          </select>
        </div>
      )}

      {panel ? panel : asCards ? (
        <ul className="ui-cards" aria-label={caption} aria-busy={busy || undefined}>
          {view.state === 'loading'
            ? Array.from({ length: skeletonCount }, (_, i) => (
                <li key={i} className="ui-cards__item" aria-hidden="true">
                  <div className="ui-cards__main">
                    <Skeleton width="70%" height={14} />
                    <Skeleton width="45%" height={11} style={{ marginTop: 8 }} />
                  </div>
                </li>
              ))
            : pageRows.map((row, i) => {
                const id = pageIds[i]
                const isSel = selectedSet.has(id)
                return (
                  <li
                    key={id}
                    className={cx('ui-cards__item', isSel && 'is-selected', onRowClick && 'is-clickable', rowClassName?.(row))}
                    onClick={(e) => onRowClickCapture(e, row)}
                  >
                    {selectable && (
                      <input
                        type="checkbox" className="ui-check" checked={isSel}
                        aria-label={`Select ${labelFor(row)}`}
                        onChange={(e) => onCheck(e, id)}
                      />
                    )}
                    <div className="ui-cards__main">
                      <div className="ui-cards__title">{headerContent(headerCol, row, i)}</div>
                      {secondaryCols.length > 0 && (
                        <div className="ui-cards__sub">
                          {secondaryCols.map(c => <span key={c.id}>{renderCell(c, row, i)}</span>)}
                        </div>
                      )}
                      {metaCols.length > 0 && (
                        <dl className="ui-cards__meta">
                          {metaCols.map(c => (
                            <div key={c.id}><dt>{columnLabel(c)}</dt><dd>{renderCell(c, row, i)}</dd></div>
                          ))}
                        </dl>
                      )}
                    </div>
                    {rowActions && <div className="ui-cards__actions">{rowActions(row)}</div>}
                  </li>
                )
              })}
        </ul>
      ) : (
        <div className={cx('ui-table__scroll', maxHeight && 'has-sticky')} style={maxHeight ? { maxHeight } : undefined}>
          <table className="data-table ui-table__table" aria-busy={busy || undefined} aria-rowcount={manualPagination ? paged.total : undefined}>
            {caption && <caption className={captionHidden ? 'sr-only' : 'ui-table__caption'}>{caption}</caption>}
            <thead>
              <tr>
                {selectable && (
                  <th scope="col" className="ui-table__check-col">
                    <input
                      ref={headerCheckRef} type="checkbox" className="ui-check"
                      checked={headState === 'all'}
                      disabled={!pageIds.length}
                      aria-label={`Select all ${noun.other} on this page`}
                      onChange={() => setSelected(toggleAll(pageIds, selectedSet))}
                    />
                  </th>
                )}
                {visibleColumns.map(col => (
                  <th
                    key={col.id} scope="col"
                    aria-sort={col.sortable ? ariaSort(sort, col.id) : undefined}
                    className={cx(col.align && `is-${col.align}`, col.headerClassName)}
                    style={{ width: col.width, minWidth: col.minWidth }}
                  >
                    {col.sortable ? (
                      <button type="button" className="ui-table__sort" onClick={() => changeSort(col)}>
                        {col.header}
                        <Icon
                          size={12}
                          className={cx('ui-table__sort-icon', sort?.id === col.id && sort.dir && 'is-active')}
                          name={sort?.id === col.id && sort.dir ? (sort.dir === 'asc' ? 'arrowUp' : 'arrowDown') : 'chevronsUpDown'}
                        />
                      </button>
                    ) : col.header}
                  </th>
                ))}
                {rowActions && <th scope="col" className="ui-table__actions-col"><span className="sr-only">{rowActionsLabel}</span></th>}
              </tr>
            </thead>
            <tbody>
              {view.state === 'loading'
                ? Array.from({ length: skeletonCount }, (_, r) => (
                    <tr key={r} aria-hidden="true" className="ui-table__skeleton-row">
                      {selectable && <td><Skeleton width={14} height={14} /></td>}
                      {visibleColumns.map((c, ci) => (
                        <td key={c.id}><Skeleton width={`${55 + ((r * 7 + ci * 13) % 35)}%`} /></td>
                      ))}
                      {rowActions && <td />}
                    </tr>
                  ))
                : pageRows.map((row, i) => {
                    const id = pageIds[i]
                    const isSel = selectedSet.has(id)
                    return (
                      <tr
                        key={id}
                        className={cx(isSel && 'is-selected', onRowClick && 'is-clickable', rowClassName?.(row))}
                        onClick={(e) => onRowClickCapture(e, row)}
                      >
                        {selectable && (
                          <td className="ui-table__check-col">
                            <input
                              type="checkbox" className="ui-check" checked={isSel}
                              aria-label={`Select ${labelFor(row)}`}
                              onChange={(e) => onCheck(e, id)}
                            />
                          </td>
                        )}
                        {visibleColumns.map(col => {
                          const Tag = col === headerCol ? 'th' : 'td'
                          return (
                            <Tag
                              key={col.id}
                              scope={Tag === 'th' ? 'row' : undefined}
                              className={cx(col.align && `is-${col.align}`, col.truncate && 'is-truncate', col.className)}
                              style={col.truncate ? { maxWidth: col.width || 240 } : undefined}
                            >
                              {col === headerCol ? headerContent(col, row, i) : renderCell(col, row, i)}
                            </Tag>
                          )
                        })}
                        {rowActions && <td className="ui-table__actions-col">{rowActions(row)}</td>}
                      </tr>
                    )
                  })}
            </tbody>
          </table>
        </div>
      )}

      {showFooter && (
        <Pagination
          page={paged.page} pageCount={paged.pageCount}
          start={paged.start} end={paged.end} total={paged.total}
          noun={noun} onPageChange={goToPage}
        />
      )}
    </div>
  )
}

/**
 * Previous / next paging with a "41–60 of 240" range. Buttons at an end are
 * aria-disabled rather than disabled, so pressing Next onto the last page
 * doesn't drop keyboard focus to the top of the document.
 */
export function Pagination({ page, pageCount, start, end, total, onPageChange, noun = DEFAULT_NOUN, className }) {
  const atStart = page <= 0
  const atEnd = page >= pageCount - 1
  return (
    <nav className={cx('ui-pagination', className)} aria-label={`${noun.other[0].toUpperCase()}${noun.other.slice(1)} pages`}>
      <span className="ui-pagination__range">{rangeLabel({ start, end, total })}</span>
      <div className="ui-pagination__controls">
        <button
          type="button" className="btn btn--ghost btn--icon btn--sm" aria-label="Previous page"
          aria-disabled={atStart || undefined} onClick={() => !atStart && onPageChange(page - 1)}
        >
          <Icon name="chevronLeft" size={14} />
        </button>
        <span className="ui-pagination__page">Page {page + 1} of {pageCount}</span>
        <button
          type="button" className="btn btn--ghost btn--icon btn--sm" aria-label="Next page"
          aria-disabled={atEnd || undefined} onClick={() => !atEnd && onPageChange(page + 1)}
        >
          <Icon name="chevronRight" size={14} />
        </button>
      </div>
    </nav>
  )
}

/**
 * The same loading / error / empty / no-results switch DataTable uses, for
 * views that aren't a table (card grids, kanban columns, a timeline):
 *
 *   <DataState loading={loading} error={error} onRetry={reload}
 *              count={filtered.length} filtered={hasFilters} onClearFilters={clear}
 *              skeleton={<CardGridSkeleton />} empty={<EmptyState … />} noun={…}>
 *     <PropertyGrid items={filtered} />
 *   </DataState>
 *
 * Children render whenever there is something to show, including during a
 * refresh (with a progress bar) and after a failed refresh (with a banner).
 */
export function DataState({
  loading = false, error = null, onRetry, count = 0, filtered = false, onClearFilters,
  skeleton, empty, noResults, noun = DEFAULT_NOUN, children,
}) {
  const view = resolveViewState({ loading, error, rowCount: count, filtered })
  if (view.state === 'loading') {
    return (
      <div aria-busy="true">
        <div role="status" className="sr-only">Loading {noun.other}…</div>
        {skeleton}
      </div>
    )
  }
  if (view.state === 'error') return <ErrorPanel error={error} onRetry={onRetry} noun={noun} />
  if (view.state === 'no-results') return noResults || <NoResultsPanel onClearFilters={onClearFilters} noun={noun} />
  if (view.state === 'empty') return empty || <EmptyState title={`No ${noun.other} yet`} />
  return (
    <div className="ui-data-state" aria-busy={view.refreshing || undefined}>
      <RefreshStatus view={view} onRetry={onRetry} noun={noun} />
      {children}
    </div>
  )
}
