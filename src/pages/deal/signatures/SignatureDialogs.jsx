// Confirmation dialogs used by the Signatures tab.

import React from 'react'
import { signerRows, outstandingSigners } from '../../../lib/services/boldsign.js'
import SignerPicker, { isValidEmail } from '../../../components/SignerPicker.jsx'
import { ConfirmDialog } from '../../../components/UI.jsx'

// ── Add acknowledgement + initials ───────────────────────────────────────────
// The sanctioned correction for a packet people are already signing, and the
// one screen it needs.
//
// It asks for the PAGE and nothing else. Everything else is either known (who
// has not finished — the API resolves that from BoldSign's own properties, not
// from this tab's possibly-stale row) or fixed (the wording, the two fields, the
// fact that the Initial box is required). The page is the one thing the CRM
// cannot know and the one thing that is visibly wrong if guessed.
//
// It names WHO will be asked, because on a four-party packet that is the fact
// that decides whether this is the right action at all: if the person who needs
// to acknowledge the change has already signed, no edit can reach them and the
// answer is a correction packet instead.
export function AcknowledgementDialog({ env, busy, onCancel, onConfirm }) {
  const [page, setPage] = React.useState(1)
  const people  = signerRows(env)
  const pending = outstandingSigners(people).filter(p => p.status !== 'queued')
  const target  = pending[0] || null
  const signed  = people.filter(p => p.status === 'signed')

  return (
    <ConfirmDialog
      eyebrow="BoldSign · Correction"
      title="Add an acknowledgement to initial?"
      confirmLabel="Add to packet"
      busyLabel="Adding…"
      confirmVariant="btn--primary"
      busy={busy}
      onCancel={onCancel}
      onConfirm={() => onConfirm(page)}
      message={
        <>
          <p style={{ margin:'0 0 10px', color:'var(--gw-ink)' }}>
            Adds a line reading <strong>“Acknowledged correction — initial here”</strong> and a required
            Initials box beside it, on the page you choose.
          </p>
          <label style={{ display:'flex', alignItems:'center', gap:8, margin:'0 0 12px' }}>
            <span style={{ fontSize:12, color:'var(--gw-mist)' }}>Page</span>
            <input
              type="number" min={1} className="form-control" style={{ width:90 }}
              value={page}
              onChange={e => setPage(Math.max(1, Number(e.target.value) || 1))}
            />
            <span style={{ fontSize:12, color:'var(--gw-mist)' }}>the page the change is on</span>
          </label>
          <p style={{ margin:'0 0 10px', color:'var(--gw-ink)' }}>
            {target
              ? <>It goes to <strong>{target.name || target.email}</strong>{target.role ? ` (${target.role})` : ''}, who has not finished signing.</>
              : <>Everyone on this packet has already finished, so nothing can be added — use <strong>Send correction packet</strong> instead.</>}
          </p>
          {signed.length > 0 && (
            <p style={{ margin:0 }}>
              {signed.length === 1 ? 'One signature is' : `${signed.length} signatures are`} already on this packet
              ({signed.map(s => s.name || s.email).join(', ')}). {signed.length === 1 ? 'It is' : 'They are'} untouched —
              a change they need to agree to has to go out as a correction packet.
            </p>
          )}
        </>
      }
    />
  )
}

// ── Change signer ────────────────────────────────────────────────────────────
// Swap a recipient who has not finished. Offered only for someone still
// outstanding (canChangeSigner), and the API checks again against BoldSign's own
// properties before it writes — this tab's row can be a missed webhook behind
// the truth, and replacing someone who signed two minutes ago is the one thing
// this must never do.
//
// The dialog says what the swap costs the client, because it is not obvious:
// the person being replaced loses their link immediately, and the replacement
// gets a fresh one. Nobody's completed signature is affected.
export function ChangeSignerDialog({ env, signer, candidates, busy, onCancel, onConfirm }) {
  const [value, setValue] = React.useState({ name: '', email: '' })
  const bad = value.email && !isValidEmail(value.email)
  const ready = Boolean(value.name.trim() && value.email.trim() && !bad)

  return (
    <ConfirmDialog
      eyebrow="BoldSign · Change signer"
      title={`Send this to someone else instead of ${signer.name || signer.email}?`}
      confirmLabel="Change signer"
      busyLabel="Changing…"
      confirmVariant="btn--primary"
      busy={busy || !ready}
      onCancel={onCancel}
      onConfirm={() => ready && onConfirm({ name: value.name.trim(), email: value.email.trim() })}
      message={
        <>
          <p style={{ margin:'0 0 12px', color:'var(--gw-ink)' }}>
            <strong>{env.document_name || 'This packet'}</strong> will go to the person below instead.
            {signer.status === 'viewed' ? ' The current recipient has already opened it; their link stops working immediately.' : ''}
          </p>
          <div style={{ marginBottom:12 }}>
            <SignerPicker
              order={signer.order}
              roleLabel={signer.role || 'Replacement signer'}
              candidates={candidates}
              value={value}
              onChange={setValue}
            />
          </div>
          <p style={{ margin:0 }}>
            Signatures already collected on this packet are untouched — only this recipient changes.
          </p>
        </>
      }
    />
  )
}
