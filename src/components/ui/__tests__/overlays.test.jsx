// @vitest-environment jsdom
import React, { useState } from 'react'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { Dialog } from '../Dialog.jsx'
import { Modal, Drawer, ConfirmDialog } from '../../UI.jsx'
import { _resetLayers } from '../layers.js'

beforeEach(() => _resetLayers())
afterEach(cleanup)

const flushMicrotasks = () => act(() => Promise.resolve())
const escape = () => fireEvent.keyDown(window, { key: 'Escape' })

describe('Dialog', () => {
  it('is a labelled, described modal dialog that takes focus', () => {
    render(<Dialog open onClose={() => {}} title="Edit contact" description="Saves to the shared record."><input /></Dialog>)
    const dlg = screen.getByRole('dialog', { name: 'Edit contact' })
    expect(dlg.getAttribute('aria-modal')).toBe('true')
    expect(dlg.getAttribute('aria-describedby')).toBeTruthy()
    expect(document.activeElement).toBe(dlg)
  })

  it('respects an initial focus target', () => {
    render(<Dialog open onClose={() => {}} title="T"><input aria-label="a" /><input aria-label="b" data-autofocus /></Dialog>)
    expect(document.activeElement).toBe(screen.getByLabelText('b'))
  })

  it('returns focus to the opener on close', async () => {
    function Harness() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Open</button>
          <Dialog open={open} onClose={() => setOpen(false)} title="T"><button type="button">Inside</button></Dialog>
        </>
      )
    }
    render(<Harness />)
    const opener = screen.getByRole('button', { name: 'Open' })
    opener.focus()
    fireEvent.click(opener)
    expect(document.activeElement).not.toBe(opener)
    escape()
    await flushMicrotasks()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('traps Tab inside', () => {
    render(<Dialog open onClose={() => {}} title="T"><button type="button">One</button><button type="button">Two</button></Dialog>)
    const close = screen.getByRole('button', { name: 'Close dialog' })
    const two = screen.getByRole('button', { name: 'Two' })
    two.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(two)
  })

  it('is not dismissible while busy', () => {
    const onClose = vi.fn()
    render(<Dialog open onClose={onClose} title="T" dismissible={false}>x</Dialog>)
    escape()
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Close dialog' }).disabled).toBe(true)
  })
})

describe('legacy Modal / Drawer / ConfirmDialog', () => {
  it('Escape closes only the top layer', () => {
    const closeDrawer = vi.fn()
    const closeModal = vi.fn()
    render(
      <Drawer open onClose={closeDrawer} title="Deal">
        <Modal open onClose={closeModal}><h3>Send packet</h3></Modal>
      </Drawer>,
    )
    escape()
    expect(closeModal).toHaveBeenCalledTimes(1)
    expect(closeDrawer).not.toHaveBeenCalled()
  })

  it('stacked modals: Escape closes the confirm, not the modal under it', () => {
    const closeOuter = vi.fn()
    const cancel = vi.fn()
    render(
      <Modal open onClose={closeOuter}>
        <h3>Prepare</h3>
        <ConfirmDialog title="Leave?" message="Unsaved work" onConfirm={() => {}} onCancel={cancel} />
      </Modal>,
    )
    escape()
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(closeOuter).not.toHaveBeenCalled()
  })

  it('an Escape a control inside already used does not close the modal', () => {
    const onClose = vi.fn()
    render(<Modal open onClose={onClose}><input aria-label="q" onKeyDown={e => { if (e.key === 'Escape') e.preventDefault() }} /></Modal>)
    fireEvent.keyDown(screen.getByLabelText('q'), { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('Modal names itself from its heading', () => {
    render(<Modal open onClose={() => {}}><div className="modal__head"><h3>Merge documents</h3></div></Modal>)
    expect(screen.getByRole('dialog', { name: 'Merge documents' })).toBeTruthy()
  })

  it('a drag that ends on the backdrop does not close the modal', () => {
    const onClose = vi.fn()
    render(<Modal open onClose={onClose}><input aria-label="field" /></Modal>)
    const backdrop = document.querySelector('.modal-backdrop')
    fireEvent.mouseDown(screen.getByLabelText('field'))
    fireEvent.click(backdrop)
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.mouseDown(backdrop)
    fireEvent.click(backdrop)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('ConfirmDialog is an alertdialog that focuses the safe choice', () => {
    render(<ConfirmDialog message="Delete it?" onConfirm={() => {}} onCancel={() => {}} />)
    expect(screen.getByRole('alertdialog', { name: 'Are you sure?' })).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }))
  })

  it('Drawer is a dialog labelled by its title with a named close button', () => {
    const onClose = vi.fn()
    render(<Drawer open onClose={onClose} title="12 Oak St">body</Drawer>)
    expect(screen.getByRole('dialog', { name: '12 Oak St' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close panel' }))
    expect(onClose).toHaveBeenCalled()
  })
})
