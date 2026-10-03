// @vitest-environment jsdom
import React, { useState } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { Button, IconButton } from '../Button.jsx'
import { Field } from '../Field.jsx'
import { Tabs } from '../Tabs.jsx'
import { EmptyState } from '../Feedback.jsx'
import { ToastHost, pushToast } from '../Toast.jsx'

afterEach(() => { cleanup(); vi.useRealTimers() })

describe('Button', () => {
  it('defaults to type="button" so it never submits a form by accident', () => {
    const onSubmit = vi.fn(e => e.preventDefault())
    render(<form onSubmit={onSubmit}><Button>Cancel</Button></form>)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('while loading: busy, blocks clicks, keeps focus and can swap its label', () => {
    const onClick = vi.fn()
    render(<Button loading loadingText="Saving…" onClick={onClick}>Save</Button>)
    const btn = screen.getByRole('button', { name: /saving/i })
    expect(btn.getAttribute('aria-busy')).toBe('true')
    expect(btn.getAttribute('aria-disabled')).toBe('true')
    expect(btn.disabled).toBe(false) // focus stays put
    fireEvent.click(btn)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('IconButton is named by its label', () => {
    render(<IconButton icon="trash" label="Delete 12 Oak St" />)
    const btn = screen.getByRole('button', { name: 'Delete 12 Oak St' })
    expect(btn.getAttribute('title')).toBe('Delete 12 Oak St')
    expect(btn.querySelector('svg').getAttribute('aria-hidden')).toBe('true')
  })
})

describe('Field', () => {
  it('wires label, hint, error and required state to the control', () => {
    render(
      <Field label="Email" hint="We send the OM here." error="Enter a valid email." required>
        <input className="form-control" aria-describedby="extra" />
      </Field>,
    )
    const input = screen.getByLabelText(/Email/)
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(input.getAttribute('aria-required')).toBe('true')
    expect(input.className).toContain('error')
    const describedBy = input.getAttribute('aria-describedby').split(' ')
    expect(describedBy[0]).toBe('extra') // the child's own ids are kept
    const text = describedBy.slice(1).map(id => document.getElementById(id).textContent)
    expect(text).toEqual(['We send the OM here.', 'Enter a valid email.'])
  })

  it('passes field props to a render function', () => {
    render(<Field label="Tags">{(p) => <div role="group" aria-labelledby={undefined} {...p} data-testid="g" />}</Field>)
    expect(screen.getByTestId('g').id).toBeTruthy()
  })
})

describe('Tabs', () => {
  function Harness() {
    const [tab, setTab] = useState('info')
    return (
      <Tabs
        ariaLabel="Contact sections" active={tab} onChange={setTab}
        tabs={[{ id: 'info', label: 'Info' }, { id: 'deals', label: 'Deals', count: 3 }, { id: 'x', label: 'Locked', disabled: true }, { id: 'notes', label: 'Notes' }]}
      />
    )
  }

  it('is a tablist with one tab stop and arrow-key navigation that skips disabled tabs', () => {
    render(<Harness />)
    expect(screen.getByRole('tablist', { name: 'Contact sections' })).toBeTruthy()
    const info = screen.getByRole('tab', { name: 'Info' })
    expect(info.getAttribute('aria-selected')).toBe('true')
    expect(screen.getAllByRole('tab').filter(t => t.tabIndex === 0)).toEqual([info])

    info.focus()
    fireEvent.keyDown(info, { key: 'ArrowRight' })
    const deals = screen.getByRole('tab', { name: 'Deals' })
    expect(deals.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(deals)

    fireEvent.keyDown(deals, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Notes' }))
    fireEvent.keyDown(document.activeElement, { key: 'ArrowRight' }) // wraps
    expect(document.activeElement).toBe(info)
    fireEvent.keyDown(info, { key: 'End' })
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Notes' }))
  })

  it('includes the count in the accessible name of an inactive tab', () => {
    render(<Harness />)
    expect(screen.getByRole('tab', { name: /^Deals\b.*\b3$/ })).toBeTruthy()
  })
})

describe('EmptyState', () => {
  it('announces errors and accepts the legacy `message` prop', () => {
    render(<EmptyState variant="error" title="Couldn't load" message="Try again." />)
    expect(screen.getByRole('alert').textContent).toContain('Try again.')
  })
})

describe('Toasts', () => {
  it('announces errors assertively and others politely', () => {
    render(<ToastHost />)
    act(() => { pushToast('Saved'); pushToast('Send failed', 'error') })
    expect(screen.getByRole('status').textContent).toContain('Saved')
    expect(screen.getByRole('alert').textContent).toContain('Send failed')
  })

  it('gives each toast its own clock — a new toast does not extend the old one', () => {
    vi.useFakeTimers()
    render(<ToastHost />)
    act(() => { pushToast('first', 'success', { duration: 3000 }) })
    act(() => { vi.advanceTimersByTime(2000) })
    act(() => { pushToast('second', 'success', { duration: 3000 }) })
    act(() => { vi.advanceTimersByTime(1100) })
    expect(screen.queryByText('first')).toBeNull()
    expect(screen.getByText('second')).toBeTruthy()
  })

  it('pauses while hovered and can be dismissed', () => {
    vi.useFakeTimers()
    render(<ToastHost />)
    act(() => { pushToast('hover me', 'info', { duration: 1000 }) })
    fireEvent.mouseEnter(screen.getByText('hover me').closest('.toast'))
    act(() => { vi.advanceTimersByTime(5000) })
    expect(screen.getByText('hover me')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }))
    expect(screen.queryByText('hover me')).toBeNull()
  })

  it('caps how many stack up', () => {
    render(<ToastHost />)
    act(() => { for (let i = 0; i < 7; i++) pushToast(`t${i}`) })
    expect(screen.queryByText('t0')).toBeNull()
    expect(screen.getByText('t6')).toBeTruthy()
    expect(document.querySelectorAll('.toast')).toHaveLength(4)
  })
})
