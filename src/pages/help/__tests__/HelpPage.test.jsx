// @vitest-environment jsdom
import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import HelpPage from '../HelpPage.jsx'

afterEach(cleanup)

const renderHelp = (props = {}) => render(<HelpPage isAdmin={false} go={vi.fn()} startNew={vi.fn()} {...props} />)

describe('HelpPage', () => {
  it('lists guides by topic', () => {
    renderHelp()
    expect(screen.getByRole('heading', { level: 1, name: 'Help & How-To' })).toBeTruthy()
    const docs = screen.getByRole('list', { name: 'Documents & e-signatures' })
    expect(within(docs).getByRole('button', { name: /Split a PDF into separate documents/ })).toBeTruthy()
  })

  it('searches and announces the result count', () => {
    renderHelp()
    fireEvent.change(screen.getByLabelText('Search the guides'), { target: { value: 'merge pdf' } })
    const results = screen.getByRole('list', { name: 'Search results' })
    expect(within(results).getAllByRole('button')[0].textContent).toMatch(/Merge documents into one PDF/)
    expect(screen.getByRole('status').textContent).toMatch(/guides? found/)
  })

  it('shows a helpful empty state when nothing matches', () => {
    renderHelp()
    fireEvent.change(screen.getByLabelText('Search the guides'), { target: { value: 'zebra unicorn' } })
    expect(screen.getByText('No guide matches that yet')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show all guides' }))
    expect(screen.getByRole('list', { name: 'Contacts & tasks' })).toBeTruthy()
  })

  it('opens a guide with numbered steps, focuses its title, and goes back', () => {
    renderHelp()
    fireEvent.click(screen.getByRole('button', { name: /Split a PDF into separate documents/ }))
    const title = screen.getByRole('heading', { level: 1, name: 'Split a PDF into separate documents' })
    expect(document.activeElement).toBe(title)
    expect(screen.getByRole('heading', { name: /Step 1:/ })).toBeTruthy()
    // **labels** render bold, never as raw asterisks
    expect(document.body.textContent).not.toContain('**')
    expect(screen.getAllByText('Split', { selector: 'strong' }).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'All guides' }))
    expect(screen.getByRole('heading', { level: 1, name: 'Help & How-To' })).toBeTruthy()
  })

  it('"Take me there" opens a blank form or the screen', () => {
    const go = vi.fn()
    const startNew = vi.fn()
    renderHelp({ go, startNew })
    fireEvent.click(screen.getByRole('button', { name: /^Add a contact/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Add a contact now' }))
    expect(startNew).toHaveBeenCalledWith('contact')
    fireEvent.click(screen.getByRole('button', { name: 'All guides' }))
    fireEvent.click(screen.getByRole('button', { name: /Set up a drip sequence/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Open Drip Sequences' }))
    expect(go).toHaveBeenCalledWith('sequences')
  })

  it('opens on the guides for the screen the "?" was pressed on (a deal counts as Pipeline)', () => {
    const onFocusHandled = vi.fn()
    renderHelp({ focusRecord: { type: 'help-for', route: 'deal/123/signatures' }, onFocusHandled })
    expect(onFocusHandled).toHaveBeenCalled()
    const ctx = screen.getByRole('list', { name: 'Guides for Pipeline' })
    expect(within(ctx).getByRole('button', { name: /Create a deal/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show everything' }))
    expect(screen.queryByRole('list', { name: 'Guides for Pipeline' })).toBeNull()
  })

  it('hides office-admin guides from agents only', () => {
    renderHelp()
    expect(screen.queryByRole('list', { name: 'Office admin' })).toBeNull()
    cleanup()
    renderHelp({ isAdmin: true })
    expect(screen.getByRole('list', { name: 'Office admin' })).toBeTruthy()
  })
})
