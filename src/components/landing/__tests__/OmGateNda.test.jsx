// @vitest-environment jsdom
import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { OmGate } from '../OmGate.jsx'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const PENDING = {
  mailing_id: 'm1', access_token: 'tok',
  nda: { title: 'Confidentiality Agreement', filename: 'CA.pdf' },
  visitor: { first_name: 'Jane', name: 'Jane Investor' },
}

describe('OmGate — NDA step', () => {
  it('moves from registration to the NDA instead of downloading', async () => {
    const onUnlock = vi.fn(async () => ({ nda_required: true, ...PENDING }))
    render(<OmGate om={{ title: 'OM' }} onUnlock={onUnlock} forceShow />)
    fireEvent.change(screen.getByLabelText('Full name *'), { target: { value: 'Jane Investor' } })
    fireEvent.change(screen.getByLabelText('Phone *'), { target: { value: '5155550134' } })
    fireEvent.change(screen.getByLabelText('Email *'), { target: { value: 'jane@fund.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Get the OM' }))
    await screen.findByRole('button', { name: 'Sign & enter the Deal Room' })
    expect(screen.getByLabelText(/Full legal name/).value).toBe('Jane Investor')
  })

  it('will not sign without the agreement box, then signs and opens', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ ok: true, url: null, nda_copy_url: 'https://x/signed.pdf', deal_room: { documents: [] } }),
    })
    const onNdaSigned = vi.fn()
    render(<OmGate om={null} forceShow onUnlock={vi.fn()} ndaPending={PENDING} onNdaSigned={onNdaSigned} />)

    fireEvent.click(screen.getByRole('button', { name: 'Sign & enter the Deal Room' }))
    expect(await screen.findByText(/confirm you agree/)).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Sign & enter the Deal Room' }))
    await waitFor(() => expect(onNdaSigned).toHaveBeenCalled())
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toMatchObject({ action: 'nda_sign', mailing_id: 'm1', access_token: 'tok', signer_name: 'Jane Investor', agree: true })
    expect(screen.getByText('Download your signed NDA')).toBeTruthy()
  })
})
