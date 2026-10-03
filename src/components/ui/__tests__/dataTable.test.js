import { describe, it, expect } from 'vitest'
import {
  sortRows, nextSort, ariaSort, paginate, rangeLabel, resolveViewState,
  selectionState, toggleAll, toggleOne, selectRange, pruneSelection, columnLabel, cellValue,
} from '../dataTable.js'

const cols = [
  { id: 'name', header: 'Name' },
  { id: 'price', header: 'Price', accessor: 'list_price' },
  { id: 'unit', header: 'Unit', accessor: r => r.unit },
  { id: 'agent', header: { type: 'b' }, label: 'Assigned agent', sortValue: r => r.agentName },
]

describe('sortRows', () => {
  const rows = [
    { id: 1, name: 'birch', list_price: 300, unit: 'Unit 10' },
    { id: 2, name: 'Aspen', list_price: null, unit: 'Unit 9' },
    { id: 3, name: 'cedar', list_price: 100, unit: 'Unit 1' },
    { id: 4, name: 'aspen', list_price: '', unit: '' },
  ]

  it('returns the same array when unsorted', () => {
    expect(sortRows(rows, cols, null)).toBe(rows)
    expect(sortRows(rows, cols, { id: 'nope', dir: 'asc' })).toBe(rows)
  })

  it('does not mutate its input', () => {
    const copy = [...rows]
    sortRows(rows, cols, { id: 'name', dir: 'desc' })
    expect(rows).toEqual(copy)
  })

  it('compares strings case-insensitively and stably', () => {
    // "Aspen" and "aspen" are equal under base sensitivity, so they keep input order.
    expect(sortRows(rows, cols, { id: 'name', dir: 'asc' }).map(r => r.id)).toEqual([2, 4, 1, 3])
  })

  it('compares embedded numbers naturally', () => {
    const out = sortRows(rows, cols, { id: 'unit', dir: 'asc' }).map(r => r.unit)
    expect(out).toEqual(['Unit 1', 'Unit 9', 'Unit 10', ''])
  })

  it('puts blanks last in both directions', () => {
    expect(sortRows(rows, cols, { id: 'price', dir: 'asc' }).map(r => r.id)).toEqual([3, 1, 2, 4])
    expect(sortRows(rows, cols, { id: 'price', dir: 'desc' }).map(r => r.id)).toEqual([1, 3, 2, 4])
  })

  it('uses sortValue over the display value', () => {
    const r = [{ id: 1, agentName: 'Zed' }, { id: 2, agentName: 'Amy' }]
    expect(sortRows(r, cols, { id: 'agent', dir: 'asc' }).map(x => x.id)).toEqual([2, 1])
  })

  it('sorts dates and booleans', () => {
    const c = [{ id: 'd' }, { id: 'b' }]
    const r = [{ id: 1, d: new Date(2024, 5, 1), b: true }, { id: 2, d: new Date(2023, 0, 1), b: false }]
    expect(sortRows(r, c, { id: 'd', dir: 'asc' }).map(x => x.id)).toEqual([2, 1])
    expect(sortRows(r, c, { id: 'b', dir: 'asc' }).map(x => x.id)).toEqual([2, 1])
  })
})

describe('nextSort / ariaSort', () => {
  it('cycles first direction → other → off', () => {
    let s = nextSort(null, 'price', 'desc')
    expect(s).toEqual({ id: 'price', dir: 'desc' })
    s = nextSort(s, 'price', 'desc')
    expect(s).toEqual({ id: 'price', dir: 'asc' })
    expect(nextSort(s, 'price', 'desc')).toBeNull()
  })
  it('starts fresh on a different column', () => {
    expect(nextSort({ id: 'a', dir: 'desc' }, 'b')).toEqual({ id: 'b', dir: 'asc' })
  })
  it('maps to aria-sort values', () => {
    expect(ariaSort({ id: 'a', dir: 'asc' }, 'a')).toBe('ascending')
    expect(ariaSort({ id: 'a', dir: 'desc' }, 'a')).toBe('descending')
    expect(ariaSort({ id: 'a', dir: 'asc' }, 'b')).toBe('none')
    expect(ariaSort(null, 'a')).toBe('none')
  })
})

describe('paginate', () => {
  const rows = Array.from({ length: 23 }, (_, i) => i)
  it('slices a page and reports the range', () => {
    const p = paginate(rows, 1, 10)
    expect(p.rows).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
    expect(p).toMatchObject({ page: 1, pageCount: 3, start: 11, end: 20, total: 23 })
  })
  it('clamps a page past the end to the last page', () => {
    expect(paginate(rows, 9, 10)).toMatchObject({ page: 2, start: 21, end: 23 })
  })
  it('handles an empty list', () => {
    expect(paginate([], 3, 10)).toMatchObject({ rows: [], page: 0, pageCount: 1, start: 0, end: 0, total: 0 })
  })
  it('returns everything when paging is off', () => {
    expect(paginate(rows, 0, 0)).toMatchObject({ pageCount: 1, start: 1, end: 23 })
  })
  it('labels the range', () => {
    expect(rangeLabel({ start: 1, end: 50, total: 1240 })).toBe(`1–50 of ${(1240).toLocaleString()}`)
    expect(rangeLabel({ start: 0, end: 0, total: 0 })).toBe('0 of 0')
  })
})

describe('resolveViewState', () => {
  it('shows skeletons only when there is nothing on screen', () => {
    expect(resolveViewState({ loading: true, rowCount: 0 }).state).toBe('loading')
    expect(resolveViewState({ loading: true, rowCount: 5 })).toEqual({ state: 'ready', refreshing: true, staleError: false })
  })
  it('keeps stale rows when a refresh fails', () => {
    expect(resolveViewState({ error: new Error('x'), rowCount: 5 })).toEqual({ state: 'ready', refreshing: false, staleError: true })
    expect(resolveViewState({ error: new Error('x'), rowCount: 0 }).state).toBe('error')
  })
  it('separates "nothing yet" from "nothing matches"', () => {
    expect(resolveViewState({ rowCount: 0 }).state).toBe('empty')
    expect(resolveViewState({ rowCount: 0, filtered: true }).state).toBe('no-results')
  })
  it('prefers loading over error over empty', () => {
    expect(resolveViewState({ loading: true, error: 'x', rowCount: 0, filtered: true }).state).toBe('loading')
    expect(resolveViewState({ error: 'x', rowCount: 0, filtered: true }).state).toBe('error')
  })
})

describe('selection', () => {
  it('reports header checkbox state for visible rows only', () => {
    expect(selectionState([], ['a'])).toBe('none')
    expect(selectionState(['a', 'b'], [])).toBe('none')
    expect(selectionState(['a', 'b'], ['a', 'z'])).toBe('some')
    expect(selectionState(['a', 'b'], new Set(['a', 'b']))).toBe('all')
  })
  it('toggleAll selects the page, then clears it, keeping off-page picks', () => {
    const once = toggleAll(['a', 'b'], ['z'])
    expect(new Set(once)).toEqual(new Set(['z', 'a', 'b']))
    expect(toggleAll(['a', 'b'], once)).toEqual(['z'])
  })
  it('toggleOne flips one id', () => {
    expect(toggleOne('a', [])).toEqual(['a'])
    expect(toggleOne('a', ['a', 'b'])).toEqual(['b'])
  })
  it('selectRange applies the target state across the range in either direction', () => {
    const ids = ['a', 'b', 'c', 'd', 'e']
    expect(new Set(selectRange(ids, 'b', 'd', ['b']))).toEqual(new Set(['b', 'c', 'd']))
    expect(new Set(selectRange(ids, 'd', 'b', ['b', 'c', 'd', 'e']))).toEqual(new Set(['e']))
    // anchor gone → single toggle
    expect(selectRange(ids, 'zz', 'c', [])).toEqual(['c'])
  })
  it('pruneSelection drops ids that left the data, or returns null when none did', () => {
    expect(pruneSelection(['a', 'b'], ['a', 'b', 'c'])).toBeNull()
    expect(pruneSelection([], ['a'])).toBeNull()
    expect(pruneSelection(['a', 'gone'], ['a'])).toEqual(['a'])
  })
})

describe('columns', () => {
  it('derives a plain-text label', () => {
    expect(columnLabel(cols[0])).toBe('Name')
    expect(columnLabel(cols[3])).toBe('Assigned agent')
    expect(columnLabel({ id: 'x', header: { type: 'i' } })).toBe('x')
  })
  it('reads values by key, function or id', () => {
    const row = { name: 'n', list_price: 5, unit: 'u' }
    expect(cellValue(cols[0], row)).toBe('n')
    expect(cellValue(cols[1], row)).toBe(5)
    expect(cellValue(cols[2], row)).toBe('u')
    expect(cellValue(cols[0], null)).toBeUndefined()
  })
})
