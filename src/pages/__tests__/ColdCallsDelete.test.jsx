// @vitest-environment jsdom
// Deleting a call list takes every lead and call note on it, so it must ask
// first — and must not claim success when the database refused it.
import React from 'react'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'

const deleteColdCallList = vi.fn()
vi.mock('../../lib/services/coldCalls.js', () => ({
  fetchColdCallLists: () => Promise.resolve({ data: [{ id: 'L1', name: 'Ames owners', agent_id: 'a1', created_at: '2026-09-01' }], error: null }),
  fetchColdCallLeads: () => Promise.resolve({ data: [{ id: 'x1', status: 'new' }, { id: 'x2', status: 'called' }], error: null }),
  deleteColdCallList: (...a) => deleteColdCallList(...a),
  createColdCallList: vi.fn(), insertColdCallLeads: vi.fn(), updateColdCallLead: vi.fn(),
}))
vi.mock('../../lib/services/contactRecords.js', () => ({ upsertContactRecord: vi.fn(), fetchContactPhones: vi.fn() }))
vi.mock('../../lib/services/tasks.js', () => ({ syncTaskCalendar: vi.fn(), createTask: vi.fn() }))
vi.mock('../../lib/services/properties.js', () => ({ createProperty: vi.fn() }))
vi.mock('../../lib/services/activities.js', () => ({ logActivity: vi.fn() }))

const { default: ColdCallsPage } = await import('../ColdCalls.jsx')
const { ToastHost } = await import('../../components/ui/Toast.jsx')
const { _resetLayers } = await import('../../components/ui/layers.js')

async function renderPage() {
  render(<><ColdCallsPage db={{ agents: [], contacts: [] }} setDb={vi.fn()} activeAgent={{ id: 'a1' }} /><ToastHost /></>)
  // lists, then the selected list's leads
  await act(async () => {})
  await act(async () => {})
}

beforeEach(() => { _resetLayers(); deleteColdCallList.mockReset() })
afterEach(cleanup)

describe('Cold call list delete', () => {
  it('asks first, naming the list and how many leads go with it', async () => {
    await renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Delete list Ames owners' }))
    const dialog = screen.getByRole('alertdialog', { name: 'Delete this call list?' })
    expect(dialog.textContent).toMatch(/“Ames owners” and its 2 leads will be deleted/)
    expect(deleteColdCallList).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(deleteColdCallList).not.toHaveBeenCalled()
  })

  it('deletes on confirm', async () => {
    deleteColdCallList.mockResolvedValue({ data: [{ id: 'L1' }], error: null })
    await renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Delete list Ames owners' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete list' })) })
    expect(deleteColdCallList).toHaveBeenCalledWith('L1')
    expect(screen.getByText('List deleted')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Delete list Ames owners' })).toBeNull()
  })

  it('reports a refused delete (no rows removed) and keeps the list', async () => {
    deleteColdCallList.mockResolvedValue({ data: [], error: null })
    await renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Delete list Ames owners' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete list' })) })
    expect(screen.getByRole('alert').textContent).toMatch(/Couldn't delete this list/)
    expect(screen.queryByText('List deleted')).toBeNull()
    expect(screen.getByRole('button', { name: 'Delete list Ames owners' })).toBeTruthy()
  })
})
