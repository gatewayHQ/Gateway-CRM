// @vitest-environment jsdom
import React, { useState } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import { DataTable, DataState } from '../DataTable.jsx'

afterEach(cleanup)

const NOUN = { one: 'property', other: 'properties' }
const rows = [
  { id: 'a', address: '12 Oak St', price: 250000 },
  { id: 'b', address: '3 Elm Ave', price: null },
  { id: 'c', address: '9 Ash Ct', price: 410000 },
]
const columns = [
  { id: 'address', header: 'Address', sortable: true, rowHeader: true },
  { id: 'price', header: 'Price', sortable: true, firstSortDir: 'desc', align: 'right' },
]
const bodyRowNames = () =>
  screen.getAllByRole('row').slice(1).map(r => within(r).getByRole('rowheader').textContent)

describe('DataTable', () => {
  it('renders a captioned table with row headers', () => {
    render(<DataTable caption="Properties" noun={NOUN} columns={columns} rows={rows} />)
    expect(screen.getByRole('table', { name: 'Properties' })).toBeTruthy()
    expect(bodyRowNames()).toEqual(['12 Oak St', '3 Elm Ave', '9 Ash Ct'])
    // A blank cell reads as "None", not an em dash.
    expect(screen.getByText('None')).toBeTruthy()
  })

  it('sorts on header click, exposes aria-sort and announces it', () => {
    render(<DataTable caption="Properties" noun={NOUN} columns={columns} rows={rows} />)
    const priceHeader = screen.getByRole('columnheader', { name: /price/i })
    expect(priceHeader.getAttribute('aria-sort')).toBe('none')

    fireEvent.click(within(priceHeader).getByRole('button'))
    expect(priceHeader.getAttribute('aria-sort')).toBe('descending')
    expect(bodyRowNames()).toEqual(['9 Ash Ct', '12 Oak St', '3 Elm Ave']) // blank price last
    expect(screen.getByRole('status').textContent).toBe('Sorted by Price, descending')

    fireEvent.click(within(priceHeader).getByRole('button'))
    expect(priceHeader.getAttribute('aria-sort')).toBe('ascending')
    expect(bodyRowNames()).toEqual(['12 Oak St', '9 Ash Ct', '3 Elm Ave']) // still last
  })

  it('shows skeleton rows and announces loading when there is nothing yet', () => {
    render(<DataTable caption="Properties" noun={NOUN} columns={columns} rows={[]} loading />)
    expect(screen.getByRole('table').getAttribute('aria-busy')).toBe('true')
    expect(screen.getByRole('status').textContent).toBe('Loading properties…')
    expect(screen.queryByRole('rowheader')).toBeNull()
  })

  it('keeps rows on screen during a refresh', () => {
    render(<DataTable caption="Properties" noun={NOUN} columns={columns} rows={rows} loading />)
    expect(screen.getAllByRole('rowheader')).toHaveLength(3)
    expect(screen.getByRole('progressbar', { name: 'Refreshing properties' })).toBeTruthy()
  })

  it('distinguishes empty from no-results, and offers to clear filters', () => {
    const onClear = vi.fn()
    const { rerender } = render(
      <DataTable noun={NOUN} columns={columns} rows={[]} emptyState={<p>Add your first property</p>} />,
    )
    expect(screen.getByText('Add your first property')).toBeTruthy()

    rerender(<DataTable noun={NOUN} columns={columns} rows={[]} filtered onClearFilters={onClear} />)
    expect(screen.getByText('No properties match these filters')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(onClear).toHaveBeenCalled()
  })

  it('shows a full error with retry when empty, a banner over stale rows otherwise', () => {
    const onRetry = vi.fn()
    const { rerender } = render(
      <DataTable noun={NOUN} columns={columns} rows={[]} error={new Error('Network down.')} onRetry={onRetry} />,
    )
    expect(screen.getByRole('alert').textContent).toContain('Network down.')
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(onRetry).toHaveBeenCalledTimes(1)

    rerender(<DataTable noun={NOUN} columns={columns} rows={rows} error={new Error('x')} onRetry={onRetry} />)
    expect(screen.getAllByRole('rowheader')).toHaveLength(3)
    expect(screen.getByRole('alert').textContent).toMatch(/showing what was last loaded/)
  })

  it('opens a row by click or by its keyboard-reachable name, but not from an action button', () => {
    const onRowClick = vi.fn()
    const onDelete = vi.fn()
    render(
      <DataTable
        noun={NOUN} columns={columns} rows={rows} onRowClick={onRowClick}
        rowActions={r => <button type="button" onClick={() => onDelete(r.id)}>Delete</button>}
      />,
    )
    // The row name is a real button.
    fireEvent.click(screen.getByRole('button', { name: '12 Oak St' }))
    expect(onRowClick).toHaveBeenLastCalledWith(rows[0], expect.anything())

    // Clicking elsewhere in the row works for mouse users.
    fireEvent.click(screen.getAllByRole('cell')[0])
    expect(onRowClick).toHaveBeenCalledTimes(2)

    // An action inside the row doesn't also open it — no stopPropagation needed.
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[1])
    expect(onDelete).toHaveBeenCalledWith('b')
    expect(onRowClick).toHaveBeenCalledTimes(2)
  })

  it('selects rows, supports shift-click ranges and drives a bulk bar', () => {
    const onBulk = vi.fn()
    render(
      <DataTable
        noun={NOUN} columns={columns} rows={rows} selectable
        renderBulkActions={(sel) => <button type="button" onClick={() => onBulk(sel.map(r => r.id))}>Archive</button>}
      />,
    )
    const box = (name) => screen.getByRole('checkbox', { name: `Select ${name}` })
    fireEvent.click(box('12 Oak St'))
    fireEvent.click(box('9 Ash Ct'), { shiftKey: true })
    expect(screen.getByText('3 selected')).toBeTruthy()

    const all = screen.getByRole('checkbox', { name: 'Select all properties on this page' })
    expect(all.checked).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
    expect(onBulk).toHaveBeenCalledWith(['a', 'b', 'c'])

    fireEvent.click(all)
    expect(screen.queryByText(/selected/)).toBeNull()
  })

  it('drops selected rows that leave the data set (no hidden bulk targets)', () => {
    const onSel = vi.fn()
    function Harness() {
      const [list, setList] = useState(rows)
      const [sel, setSel] = useState(['a', 'b'])
      return (
        <>
          <button type="button" onClick={() => setList(rows.slice(0, 1))}>filter</button>
          <DataTable
            noun={NOUN} columns={columns} rows={list} selectable
            selectedIds={sel} onSelectionChange={(s) => { onSel(s); setSel(s) }}
          />
        </>
      )
    }
    render(<Harness />)
    expect(screen.getByText('2 selected')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'filter' }))
    expect(onSel).toHaveBeenLastCalledWith(['a'])
    expect(screen.getByText('1 selected')).toBeTruthy()
  })

  it('pages large lists and resets to page 1 when the filter key changes', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ id: `r${i}`, address: `Lot ${i + 1}`, price: i }))
    const { rerender } = render(<DataTable noun={NOUN} columns={columns} rows={many} pageSize={10} pageResetKey="x" />)
    expect(screen.getByText('1–10 of 25')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    expect(screen.getByText('11–20 of 25')).toBeTruthy()
    expect(bodyRowNames()[0]).toBe('Lot 11')

    rerender(<DataTable noun={NOUN} columns={columns} rows={many} pageSize={10} pageResetKey="y" />)
    expect(screen.getByText('1–10 of 25')).toBeTruthy()

    // The Previous button at the start is aria-disabled (keeps focus), and inert.
    const prev = screen.getByRole('button', { name: 'Previous page' })
    expect(prev.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(prev)
    expect(screen.getByText('1–10 of 25')).toBeTruthy()
  })

  it('renders cards when asked, with label/value pairs', () => {
    render(<DataTable caption="Properties" noun={NOUN} columns={columns} rows={rows} layout="cards" />)
    const list = screen.getByRole('list', { name: 'Properties' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(3)
    expect(within(list).getAllByText('Price')).toHaveLength(3)
  })
})

describe('DataState', () => {
  it('switches between skeleton, empty, no-results and content', () => {
    const { rerender } = render(<DataState count={0} loading skeleton={<p>skel</p>}><p>content</p></DataState>)
    expect(screen.getByText('skel')).toBeTruthy()
    rerender(<DataState count={0} empty={<p>none yet</p>}><p>content</p></DataState>)
    expect(screen.getByText('none yet')).toBeTruthy()
    rerender(<DataState count={0} filtered noun={NOUN}><p>content</p></DataState>)
    expect(screen.getByText('No properties match these filters')).toBeTruthy()
    rerender(<DataState count={2}><p>content</p></DataState>)
    expect(screen.getByText('content')).toBeTruthy()
  })
})
