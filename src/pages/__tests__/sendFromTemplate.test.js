// The Signatures tab's main route: "Start: Send from Template" opens the
// template screen. That screen once read a variable that no longer existed and
// threw on every deal with a state, so the button led to a crash instead of the
// next step. These render it the way a real deal would open it.
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SendFromTemplateModal } from '../deal/signatures/SendFromTemplateModal.jsx'
import { SignaturesGettingStarted } from '../deal/signatures/SignaturesGettingStarted.jsx'

const IOWA   = { template_id: 'ia-1', name: 'Iowa Listing Agreement', state: 'IA', transaction_type: 'listing' }
const GENERAL = { template_id: 'gen-1', name: 'Wire Fraud Advisory', state: '', transaction_type: 'general' }

const open = (deal, templates) => renderToStaticMarkup(
  React.createElement(SendFromTemplateModal, {
    deal, templates, contacts: [], properties: [], dealAgents: [],
    onClose: vi.fn(), onSent: vi.fn(), onSaved: vi.fn(),
  })
)

describe('SendFromTemplateModal', () => {
  it('opens on a deal with a state and lists that state’s forms', () => {
    const html = open({ id: 'd1', title: '603 W 9th St', comp_data: { state: 'IA' } }, [IOWA, GENERAL])
    expect(html).toContain('Step 1 of 3')
    expect(html).toContain('Iowa Listing Agreement')
    expect(html).toContain('Showing IA forms and general forms.')
  })

  it('says so when the state has no forms of its own', () => {
    const html = open({ id: 'd1', comp_data: { state: 'NE' } }, [IOWA, GENERAL])
    expect(html).toContain('No NE forms are set up yet')
    expect(html).not.toContain('Iowa Listing Agreement')
  })

  it('explains an empty picker instead of showing a blank one', () => {
    const html = open({ id: 'd1', comp_data: { state: 'NE' } }, [IOWA])
    expect(html).toContain('No templates are set up for NE yet.')
  })

  it('opens on a deal with no state', () => {
    const html = open({ id: 'd1' }, [IOWA, GENERAL])
    expect(html).toContain('Iowa Listing Agreement')
    expect(html).toContain('Wire Fraud Advisory')
  })
})

describe('SignaturesGettingStarted', () => {
  const render = (props) => renderToStaticMarkup(React.createElement(SignaturesGettingStarted, {
    onTemplate: vi.fn(), onUpload: vi.fn(), ...props,
  }))

  it('leads with the template button when templates exist', () => {
    const html = render({ hasTemplates: true })
    expect(html).toContain('Start: Send from Template')
    expect(html).toContain('Upload your own PDF instead')
  })

  it('says who sets templates up when there are none', () => {
    const html = render({ hasTemplates: false })
    expect(html).not.toContain('Start: Send from Template')
    expect(html).toContain('No e-sign templates are set up yet.')
  })
})
