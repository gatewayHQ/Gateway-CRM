// Send from Template → final step: review the filled draft before sending.

import React from 'react'
import { fileDocumentToDeal, sendDraft as apiSendDraft, signerRows } from '../../../lib/services/boldsign.js'
import { openPrintTab, showPdfInPrintTab, closePrintTab } from '../../../lib/savePdf.js'
import { Icon, Modal, ConfirmDialog, pushToast } from '../../../components/UI.jsx'
import { templateStep } from './signatureSteps.js'

// ── Review Draft — the document on screen at the moment of the decision ───────
// The send screen used to end in two co-equal buttons, styled almost
// identically, with a paragraph above explaining the difference. And the agent
// could not see the document before choosing: previewing meant creating a
// draft, closing the modal, finding the row, and clicking Download Filled PDF —
// a modal, a tab and a download to answer "does this say the right thing".
//
// One primary action instead, and everything else becomes a choice made WITH
// the packet in front of you: adjust where people sign, save a copy for the
// client, or send it. That is a sequence rather than a fork, and it is the
// step competing systems do not have — they hand you a template and a Send
// button.
//
// The draft is real by this point and lives on the deal, so closing here loses
// nothing: the row is on the Signatures tab with the same three actions.
export function DraftReviewStep({ documentId, documentName, previewUrl, downloadUrl, fieldCount, signers = [], onAdjust, onSent, onClose, adjusting }) {
  const [sending, setSending] = React.useState(false)
  const [confirm, setConfirm] = React.useState(false)
  const [filing,  setFiling]  = React.useState(false)

  const people = signerRows({ signers })

  const download = () => {
    if (!downloadUrl) { pushToast('That copy is not ready yet — try again in a moment.', 'error'); return }
    const a = document.createElement('a')
    a.href = downloadUrl
    a.download = `${String(documentName || 'document').replace(/\.pdf$/i, '')} (filled).pdf`
    a.target = '_blank'
    a.rel = 'noopener'
    document.body.appendChild(a); a.click(); a.remove()
  }

  // `previewUrl` is already in hand here, so there is no round-trip to lose the
  // user gesture to — the tab is opened and pointed at the document in one go.
  const printCopy = () => {
    const tab = openPrintTab()
    try {
      showPdfInPrintTab(tab, previewUrl)
    } catch (err) {
      closePrintTab(tab)
      pushToast(`Could not open a printable copy \u2014 ${err.message}.`, 'error')
    }
  }

  // The review is where an agent decides what happens to the packet, so filing it
  // on the deal belongs here beside downloading it. No `unsaved` guard is needed on
  // this path — unlike the editor, nothing is sitting typed in a cross-origin frame:
  // the draft was composed server-side from values already written to it.
  const fileToDeal = async () => {
    setFiling(true)
    try {
      console.info('[boldsign] review: save to deal', { documentId, documentName, fieldCount })
      const res = await fileDocumentToDeal(documentId)
      console.info('[boldsign] review: filed', { documentId, path: res.path, filename: res.filename, fieldCount: res.fieldCount })
      pushToast(res.fieldCount
        ? `Filed on this deal — ${res.fieldCount} field${res.fieldCount === 1 ? '' : 's'} included. Find it in the Documents tab.`
        : 'Filed on this deal — find it in the Documents tab.', 'success')
    } catch (err) {
      pushToast(`Could not file it on the deal: ${err.message}`, 'error')
    } finally {
      setFiling(false)
    }
  }

  const send = async () => {
    setSending(true)
    try {
      await apiSendDraft(documentId)
      pushToast('Sent for signature — the signers have been notified.', 'success')
      onSent()
    } catch (err) {
      pushToast(err.message, 'error')
      setConfirm(false)
    } finally {
      setSending(false)
    }
  }

  return (
    <Modal open={true} onClose={onClose} width={null} className="modal--workspace">
      <div className="modal__head">
        <div>
          <div className="eyebrow-label">{templateStep(2)} — Review</div>
          <h3 style={{ margin:0, fontFamily:'var(--font-display)', fontSize:20 }}>{documentName || 'Draft agreement'}</h3>
        </div>
        <button className="drawer__close" onClick={onClose}><Icon name="x" size={18}/></button>
      </div>

      <div style={{ display:'flex', flexDirection:'column', flex:1, minHeight:0 }}>
        <div style={{ padding:'8px 16px', borderBottom:'1px solid var(--gw-border)', background:'var(--gw-bone)', fontSize:12, display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
          <Icon name="check" size={13} style={{ color:'var(--gw-green)', flexShrink:0 }}/>
          <span style={{ flex:1, minWidth:200 }}>
            <strong>Saved as a draft — nothing sent.</strong>{' '}
            {fieldCount ? `${fieldCount} field${fieldCount === 1 ? '' : 's'} filled in from this deal. ` : ''}
            This is exactly what your signers will see.
          </span>
          {people.length > 0 && (
            <span style={{ color:'var(--gw-mist)' }}>
              To: {people.map(p => p.name || p.email).filter(Boolean).join(', ')}
            </span>
          )}
        </div>

        {/* The packet itself. A cross-origin signed URL served inline — the same
            bytes Save PDF downloads, composed server-side with every filled
            value drawn on and the signing summary appended. */}
        {previewUrl ? (
          <iframe
            title="Draft agreement preview"
            src={previewUrl}
            style={{ flex:1, width:'100%', border:'none', background:'#525659', minHeight:0 }}
          />
        ) : (
          <div style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center', flexDirection:'column', gap:10, padding:24, textAlign:'center' }}>
            <div style={{ fontSize:13, color:'var(--gw-mist)', maxWidth:420, lineHeight:1.7 }}>
              The draft is saved on this deal, but the preview could not be built right now — this usually means
              BoldSign is still finishing the document. Download the copy, or try again from the Signatures tab in
              a moment. Nothing has been sent.
            </div>
            <button className="btn btn--secondary btn--sm" onClick={download} disabled={!downloadUrl}>
              <Icon name="document" size={12}/> Download the filled PDF
            </button>
          </div>
        )}
      </div>

      <div className="modal__foot">
        <button className="btn btn--secondary" onClick={onAdjust} disabled={adjusting || sending}>
          {adjusting ? 'Opening…' : 'Adjust Field Placement'}
        </button>
        <button className="btn btn--secondary" onClick={download} disabled={!downloadUrl || sending}>
          <Icon name="document" size={13}/> Download PDF
        </button>
        <button className="btn btn--secondary" onClick={printCopy} disabled={!previewUrl || sending} title="Open this copy in a new tab and print it from there">
          <Icon name="document" size={13}/> Print
        </button>
        <button className="btn btn--secondary" onClick={fileToDeal} disabled={filing || sending || !documentId}>
          <Icon name="upload" size={13}/> {filing ? 'Filing…' : 'Save to Deal'}
        </button>
        <button className="btn btn--primary" onClick={() => setConfirm(true)} disabled={sending}>
          <Icon name="send" size={13}/> Send for Signature
        </button>
      </div>

      {/* The one irreversible step. Names the actual recipients in signing
          order, because the mistake it catches is sending the RIGHT document to
          the WRONG people. */}
      {confirm && (
        <ConfirmDialog
          eyebrow={templateStep(3)}
          title="Send this document to its signers?"
          confirmLabel="Send for Signature"
          busyLabel="Sending…"
          confirmVariant="btn--primary"
          busy={sending}
          onCancel={() => setConfirm(false)}
          onConfirm={send}
          message={
            <>
              <p style={{ margin:'0 0 10px', color:'var(--gw-ink)' }}>
                <strong>{documentName || 'This document'}</strong> will be emailed for e-signature to:
              </p>
              <ul style={{ margin:'0 0 10px', padding:0, listStyle:'none' }}>
                {people.map(r => (
                  <li key={`${r.email || r.name}-${r.order}`} style={{ display:'flex', gap:8, padding:'2px 0', color:'var(--gw-ink)' }}>
                    <span style={{ color:'var(--gw-mist)', minWidth:16 }}>{r.order}.</span>
                    <span><strong>{r.name || r.email}</strong>{r.name && r.email ? ` — ${r.email}` : ''}{r.role ? ` (${r.role})` : ''}</span>
                  </li>
                ))}
              </ul>
              <p style={{ margin:0 }}>
                It stops being a draft, so it can no longer be edited here. If the client still has changes,
                cancel and use <strong>Adjust Field Placement</strong> instead.
              </p>
            </>
          }
        />
      )}
    </Modal>
  )
}
