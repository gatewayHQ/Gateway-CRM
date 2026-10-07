// @vitest-environment jsdom
// The drawer stays mounted between opens. Each new property must get its own
// id — reusing the previous one made the second "Add Property" of a session
// fail with "This record already exists".
import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'

const createProperty = vi.fn()
vi.mock('../../../lib/services/properties.js', () => ({
  createProperty: (...a) => createProperty(...a),
  updateProperty: vi.fn(),
  updatePropertyCoords: vi.fn(),
}))
vi.mock('../../../lib/services/propertyContacts.js', () => ({
  syncDealContactsFromProperty: vi.fn(), syncPropertyContacts: vi.fn(async () => false), fetchPropertyContacts: vi.fn(),
}))
vi.mock('../../../lib/webhooks.js', () => ({ fireWebhooks: vi.fn() }))
vi.mock('../PhotoUploader.jsx', () => ({ PhotoUploader: () => null }))
vi.mock('../PossibleBuyers.jsx', () => ({ PossibleBuyers: () => null }))

const { PropertyDrawer } = await import('../PropertyDrawer.jsx')

afterEach(cleanup)

async function addProperty(address) {
  fireEvent.change(screen.getByPlaceholderText('123 Main Street'), { target: { value: address } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save Property' })) })
}

describe('PropertyDrawer', () => {
  it('gives every new property its own id across opens of the same drawer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => [] })))
    createProperty.mockImplementation(async (body) => ({ data: body, error: null, status: 201 }))
    const props = { onClose: () => {}, onSave: () => {}, agents: [], contacts: [], propertyContacts: [], deals: [], activeAgent: { id: 'ag' } }

    const { rerender } = render(<PropertyDrawer open property={null} {...props} />)
    await addProperty('1 First St')
    rerender(<PropertyDrawer open={false} property={null} {...props} />)
    rerender(<PropertyDrawer open property={null} {...props} />)
    await addProperty('2 Second St')

    expect(createProperty).toHaveBeenCalledTimes(2)
    const [first, second] = createProperty.mock.calls.map(c => c[0].id)
    expect(first).toBeTruthy()
    expect(second).toBeTruthy()
    expect(second).not.toBe(first)
    vi.unstubAllGlobals()
  })
})
