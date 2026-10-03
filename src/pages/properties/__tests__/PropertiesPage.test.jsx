// @vitest-environment jsdom
import React, { useState } from 'react'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act, within } from '@testing-library/react'

const deleteProperty = vi.fn()
const loadVisibleProperties = vi.fn()
vi.mock('../../../lib/services/properties.js', () => ({
  deleteProperty: (...a) => deleteProperty(...a),
  loadVisibleProperties: (...a) => loadVisibleProperties(...a),
}))
// The drawer and the mailing modal pull in the whole data layer; this test is
// about the list.
vi.mock('../PropertyDrawer.jsx', () => ({ PropertyDrawer: ({ open, property }) => (open ? <div data-testid="drawer">{property?.id || 'new'}</div> : null) }))
vi.mock('../RadiusMailingModal.jsx', () => ({ RadiusMailingModal: () => null }))

const { default: PropertiesPage } = await import('../PropertiesPage.jsx')
const { ToastHost } = await import('../../../components/ui/Toast.jsx')
const { _resetLayers } = await import('../../../components/ui/layers.js')

const PROPS = [
  { id: 'p1', address: '12 Oak St', city: 'Ames', county: 'Story', type: 'multifamily', status: 'active', list_price: 900000 },
  { id: 'p2', address: '3 Elm Ave', city: 'Ankeny', county: 'Polk', type: 'retail', status: 'pending', list_price: 450000 },
]

function Harness({ properties = PROPS }) {
  const [db, setDb] = useState({ properties, agents: [], contacts: [], deals: [] })
  return (
    <>
      <PropertiesPage db={db} setDb={setDb} isAdmin activeAgent={{ id: 'ag' }} propertyAgentIds={['ag']} />
      <ToastHost />
    </>
  )
}

beforeEach(() => {
  _resetLayers()
  deleteProperty.mockReset()
  loadVisibleProperties.mockReset().mockResolvedValue({ data: PROPS, error: null })
})
afterEach(cleanup)

describe('PropertiesPage', () => {
  it('says "no match" with a clear-filters action, not "no properties yet", when filters hide everything', () => {
    render(<Harness />)
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzz' } })
    expect(screen.queryByText('No properties yet')).toBeNull()
    expect(screen.getByText('No properties match these filters')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: /clear filters/i })[0])
    expect(screen.getByRole('button', { name: '12 Oak St' })).toBeTruthy()
  })

  it('shows the real empty state when there are no properties at all', () => {
    render(<Harness properties={[]} />)
    expect(screen.getByText('No properties yet')).toBeTruthy()
  })

  it('list view: sortable table whose rows open by keyboard', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'List view' }))
    const price = screen.getByRole('columnheader', { name: /price/i })
    fireEvent.click(within(price).getByRole('button'))
    expect(price.getAttribute('aria-sort')).toBe('descending')
    fireEvent.click(screen.getByRole('button', { name: 'Open 3 Elm Ave' }))
    expect(screen.getByTestId('drawer').textContent).toBe('p2')
  })

  it('reports a failed delete instead of claiming success, and keeps the row', async () => {
    deleteProperty.mockResolvedValue({ error: { message: 'permission denied' } })
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete 12 Oak St' }))
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete' })) })
    expect(screen.getByRole('alert').textContent).toMatch(/Couldn't delete this property: permission denied/)
    expect(screen.queryByText('Property deleted')).toBeNull()
    expect(screen.getByRole('button', { name: '12 Oak St' })).toBeTruthy()
  })

  it('removes the row and confirms on a successful delete', async () => {
    deleteProperty.mockResolvedValue({ error: null })
    loadVisibleProperties.mockResolvedValue({ data: PROPS.slice(1), error: null })
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete 12 Oak St' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete' })) })
    expect(screen.getByText('Property deleted')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '12 Oak St' })).toBeNull()
  })
})
