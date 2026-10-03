// DataTable's rules — sorting, paging, selection, which state to show.
// Pure functions: no React, no DOM. The component calls them; tests call them
// directly with the awkward inputs real CRM data has (blank prices, mixed
// case, "Unit 10" vs "Unit 9", rows that vanish under a filter mid-selection).

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** The plain-text name of a column — for aria labels, mobile labels and the sort menu. */
export function columnLabel(col) {
  if (col.label != null) return col.label
  return typeof col.header === 'string' ? col.header : col.id
}

/** The raw value of a cell: `accessor` as a key or a function, else `row[col.id]`. */
export function cellValue(col, row) {
  if (typeof col.accessor === 'function') return col.accessor(row)
  if (typeof col.accessor === 'string') return row?.[col.accessor]
  return row?.[col.id]
}

/** What a column sorts by — `sortValue` when the display value isn't sortable. */
export function sortValueOf(col, row) {
  return col.sortValue ? col.sortValue(row) : cellValue(col, row)
}

const isBlank = (v) => v == null || v === '' || (typeof v === 'number' && Number.isNaN(v))

export function compareValues(a, b) {
  if (a instanceof Date) a = a.getTime()
  if (b instanceof Date) b = b.getTime()
  if (typeof a === 'boolean') a = Number(a)
  if (typeof b === 'boolean') b = Number(b)
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return collator.compare(String(a), String(b))
}

/**
 * Rows ordered by `sort` ({ id, dir: 'asc' | 'desc' }). Never mutates.
 *
 *  - Stable: equal values keep their incoming order, so a secondary order the
 *    caller applied (newest first) survives sorting by status.
 *  - Blanks last in BOTH directions. A listing with no price is missing data,
 *    not the cheapest listing — it shouldn't lead a descending sort either.
 *  - Strings compare naturally and case-insensitively: "Unit 9" < "Unit 10",
 *    "ames" next to "Ames".
 */
export function sortRows(rows, columns, sort) {
  if (!sort?.id || !sort.dir) return rows
  const col = columns.find(c => c.id === sort.id)
  if (!col) return rows
  const dir = sort.dir === 'desc' ? -1 : 1
  return rows
    .map((row, i) => ({ row, i, v: sortValueOf(col, row) }))
    .sort((x, y) => {
      const xb = isBlank(x.v)
      const yb = isBlank(y.v)
      if (xb || yb) return xb === yb ? x.i - y.i : xb ? 1 : -1
      return compareValues(x.v, y.v) * dir || x.i - y.i
    })
    .map(x => x.row)
}

/**
 * Clicking a column header cycles: first direction → the other → unsorted.
 * `firstDir` is per column — money and dates usually want 'desc' first.
 */
export function nextSort(current, columnId, firstDir = 'asc') {
  if (current?.id !== columnId || !current.dir) return { id: columnId, dir: firstDir }
  if (current.dir === firstDir) return { id: columnId, dir: firstDir === 'asc' ? 'desc' : 'asc' }
  return null
}

/** aria-sort for a header cell. */
export const ariaSort = (sort, columnId) =>
  sort?.id === columnId && sort.dir ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'

/**
 * One page of rows. `page` is clamped: when a filter shrinks the list below
 * the current page, show the last real page rather than an empty one.
 */
export function paginate(rows, page, pageSize) {
  const total = rows.length
  if (!pageSize || pageSize <= 0) {
    return { rows, page: 0, pageCount: 1, start: total ? 1 : 0, end: total, total }
  }
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const p = Math.min(Math.max(0, page | 0), pageCount - 1)
  const from = p * pageSize
  const slice = rows.slice(from, from + pageSize)
  return { rows: slice, page: p, pageCount, start: total ? from + 1 : 0, end: from + slice.length, total }
}

/** "1–50 of 1,240" */
export function rangeLabel({ start, end, total }) {
  const n = (x) => x.toLocaleString()
  return total ? `${n(start)}–${n(end)} of ${n(total)}` : '0 of 0'
}

/**
 * Which body to render. Rows on screen always win over a full-panel state:
 * a refresh that fails keeps the stale rows (with an error banner) instead of
 * blanking a list someone was working through.
 *
 * → { state: 'loading' | 'error' | 'empty' | 'no-results' | 'ready',
 *     refreshing: loading with rows already shown,
 *     staleError: error with rows already shown }
 */
export function resolveViewState({ loading = false, error = null, rowCount = 0, filtered = false }) {
  if (rowCount > 0) return { state: 'ready', refreshing: !!loading, staleError: !!error }
  if (loading) return { state: 'loading', refreshing: false, staleError: false }
  if (error) return { state: 'error', refreshing: false, staleError: false }
  return { state: filtered ? 'no-results' : 'empty', refreshing: false, staleError: false }
}

// ─── Selection ────────────────────────────────────────────────────────────────
// Selections are arrays of row ids at the API boundary (serialisable, easy to
// hand to a bulk-update service) and Sets inside.

export const toIdSet = (ids) => (ids instanceof Set ? ids : new Set(ids || []))

/** Header checkbox state for the rows on screen: 'none' | 'some' | 'all'. */
export function selectionState(visibleIds, selected) {
  const set = toIdSet(selected)
  if (!visibleIds.length) return 'none'
  let hit = 0
  for (const id of visibleIds) if (set.has(id)) hit++
  return hit === 0 ? 'none' : hit === visibleIds.length ? 'all' : 'some'
}

/** Header checkbox click: select every visible row, or — if all are — clear them. Leaves off-page selections alone. */
export function toggleAll(visibleIds, selected) {
  const set = new Set(toIdSet(selected))
  const all = selectionState(visibleIds, set) === 'all'
  for (const id of visibleIds) all ? set.delete(id) : set.add(id)
  return [...set]
}

export function toggleOne(id, selected) {
  const set = new Set(toIdSet(selected))
  set.has(id) ? set.delete(id) : set.add(id)
  return [...set]
}

/**
 * Shift+click: set every row between the anchor and the target (inclusive, in
 * display order) to the target's new state. Falls back to a single toggle when
 * the anchor is no longer on screen.
 */
export function selectRange(orderedIds, anchorId, targetId, selected) {
  const set = new Set(toIdSet(selected))
  const a = orderedIds.indexOf(anchorId)
  const b = orderedIds.indexOf(targetId)
  if (a < 0 || b < 0) return toggleOne(targetId, set)
  const value = !set.has(targetId)
  const [from, to] = a < b ? [a, b] : [b, a]
  for (let i = from; i <= to; i++) value ? set.add(orderedIds[i]) : set.delete(orderedIds[i])
  return [...set]
}

/**
 * Drop selected ids that are no longer in the data set. Returns `null` when
 * nothing changed, so the caller can skip a state update.
 *
 * This is a safety rule, not tidiness: if a row filtered out of view stayed
 * selected, "Delete 3 selected" could delete a record the user can't see.
 */
export function pruneSelection(selected, allIds) {
  const set = toIdSet(selected)
  if (!set.size) return null
  const present = new Set(allIds)
  const kept = [...set].filter(id => present.has(id))
  return kept.length === set.size ? null : kept
}
