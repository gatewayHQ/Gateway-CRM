// @vitest-environment jsdom
// Switching or resetting a deal's checklist must keep every decision that
// still applies — done AND N/A — and ask before throwing completed work away.
import React from 'react'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'

const insertChecklistSteps = vi.fn()
const updateChecklistStep = vi.fn()
const existing = [
  { id: 's1', title: 'Buyer Agency Agreement', doc_status: 'complete', completed: true, completed_at: '2026-09-01T00:00:00Z', sort_order: 0 },
  // Written before the fix: N/A on screen, completed:false underneath.
  { id: 's2', title: 'Agency Disclosure', doc_status: 'na', completed: false, sort_order: 1 },
  { id: 's3', title: 'A custom step', doc_status: 'complete', completed: true, sort_order: 2 },
]

vi.mock('../../../lib/services/dealChecklist.js', () => ({
  seedChecklist: vi.fn(),
  fetchDealChecklistSteps: () => Promise.resolve({ data: existing, error: null }),
  deleteDealChecklistSteps: () => Promise.resolve({ error: null }),
  insertChecklistSteps: (rows) => { insertChecklistSteps(rows); return Promise.resolve({ data: rows, error: null }) },
  insertChecklistStep: vi.fn(),
  updateChecklistStep: (...a) => updateChecklistStep(...a),
  deleteChecklistStep: vi.fn(),
}))
vi.mock('../../../lib/services/dealRecords.js', () => ({
  fetchDealChecklistMeta: () => Promise.resolve({ data: { comp_data: { state: 'IA', checklist_type: 'buyer' } } }),
  fetchDealCompData: () => Promise.resolve({ data: { comp_data: {} } }),
  updateDealCompData: () => Promise.resolve({ error: null }),
}))

const { ChecklistTab } = await import('../ChecklistTab.jsx')
const { _resetLayers } = await import('../../../components/ui/layers.js')

async function renderTab() {
  render(<ChecklistTab deal={{ id: 'd1', comp_data: { state: 'IA', checklist_type: 'buyer' } }} property={null} />)
  await act(async () => {})
}

beforeEach(() => { _resetLayers(); insertChecklistSteps.mockReset(); updateChecklistStep.mockReset().mockResolvedValue({ error: null }) })
afterEach(cleanup)

describe('ChecklistTab', () => {
  it('reset asks before dropping completed work, then keeps done and N/A steps', async () => {
    await renderTab()
    fireEvent.click(screen.getByRole('button', { name: /Reset/ }))
    // The custom step isn't on the standard list: one completed step would be lost.
    const dialog = screen.getByRole('alertdialog')
    expect(dialog.textContent).toMatch(/1 completed step is not on the new list/)

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Switch checklist' })) })
    const rows = insertChecklistSteps.mock.calls[0][0]
    const byTitle = Object.fromEntries(rows.map(r => [r.title, r]))
    expect(byTitle['Buyer Agency Agreement']).toMatchObject({ doc_status: 'complete', completed: true, completed_at: '2026-09-01T00:00:00Z' })
    expect(byTitle['Agency Disclosure']).toMatchObject({ doc_status: 'na', completed: true })
    expect(byTitle['A custom step']).toBeUndefined()
  })

  it('cycling a step to N/A writes it as resolved, so it stops blocking closing', async () => {
    await renderTab()
    // Buyer Agency Agreement is complete → approved → N/A.
    const box = () => screen.getByRole('button', { name: /^Buyer Agency Agreement: .*Change status/ })
    expect(box().getAttribute('aria-label')).toMatch(/: complete\./)
    await act(async () => { fireEvent.click(box()) })
    await act(async () => { fireEvent.click(box()) })
    expect(updateChecklistStep).toHaveBeenLastCalledWith('s1', expect.objectContaining({ doc_status: 'na', completed: true }))
    expect(box().getAttribute('aria-label')).toMatch(/: N\/A\./)
  })

  it('reports a failed status change instead of pretending it saved', async () => {
    updateChecklistStep.mockResolvedValue({ error: { message: 'permission denied' } })
    await renderTab()
    const box = screen.getByRole('button', { name: /^Buyer Agency Agreement: / })
    await act(async () => { fireEvent.click(box) })
    expect(box.getAttribute('aria-label')).toMatch(/: complete\./)
  })
})
