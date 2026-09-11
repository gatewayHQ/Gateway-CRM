import React from 'react'
import { Icon, Modal, pushToast } from './UI.jsx'
import SignerPicker, { buildCandidates, isValidEmail } from './SignerPicker.jsx'
import {
  templateDetails, mergeTemplatesEmbedUrl, splitSendPacket,
  seedSignersFromDeal, buildTemplateRoles, packetModeFor,
} from '../lib/services/boldsign.js'

// ─────────────────────────────────────────────────────────────────────────────
// COMPOSE A PACKET — several forms, one screen, one decision.
//
// The existing Prepare-from-Template modal handles ONE form beautifully and is
// the right screen for the common case. This is the other case: a listing that
// needs the agreement, the agency disclosure and the lead-paint form, and an
// agent who does not want to run the same screen three times with the same
// signers.
//
// THE ONE DECISION THAT IS NOT REVERSIBLE:
//
//   TOGETHER — one BoldSign envelope built from every selected template. One
//     email, one signing session. Whether MLS can later be handed one form at a
//     time depends on DocumentDownloadOption, which BoldSign fixes at creation
//     and which this app always asks for as `Individually`. If the plan does
//     not include it, the send still succeeds as Combined and the response says
//     so — because a merged Combined packet can NEVER be un-combined afterwards
//     (BoldSign does not split pages out of a signed PDF, and neither do we).
//
//   SEPARATELY — one envelope per form, same signers. More email for the
//     client; separate files without needing the paid feature, separate
//     statuses on the deal, and one declined disclosure does not hold up the
//     purchase agreement.
//
// Together lands on BoldSign's prepare screen for review — a send is the one
// irreversible act and it deserves a screen of its own. Separately sends
// outright, because there is no single document to review.
// ─────────────────────────────────────────────────────────────────────────────
export default function ComposePacketModal({
  deal, contacts = [], properties = [], extraContacts = [], sideClients = null,
  dealAgents = [], templates = [], activeAgent, onClose, onSent,
}) {
  const [picked,   setPicked]   = React.useState([])   // template_id[], in send order
  const [together, setTogether] = React.useState(true)
  const [inOrder,  setInOrder]  = React.useState(true)
  const [roleList, setRoleList] = React.useState([])   // the packet's roles (see below)
  const [signers,  setSigners]  = React.useState({})   // roleIndex → { name, email }
  const [loading,  setLoading]  = React.useState(false)
  const [roleWarn, setRoleWarn] = React.useState('')
  const [error,    setError]    = React.useState('')
  const [busy,     setBusy]     = React.useState(false)
  const [frame,    setFrame]    = React.useState(null) // { url, documentId } once prepared

  const contact = React.useMemo(
    () => contacts.find(c => c.id === deal?.contact_id) || null,
    [contacts, deal?.contact_id],
  )
  const property = React.useMemo(
    () => properties.find(p => p.id === deal?.property_id) || null,
    [properties, deal?.property_id],
  )
  // buildCandidates takes POOLS, not a deal: the people already on this deal
  // first (so the seller who is on every form is one click away), then the
  // agents who could countersign.
  const candidates = React.useMemo(
    () => buildCandidates({
      dealContacts: [contact, ...extraContacts].filter(Boolean),
      dealAgents,
    }),
    [contact, extraContacts, dealAgents],
  )

  const chosen = React.useMemo(
    () => picked.map(id => templates.find(t => t.template_id === id)).filter(Boolean),
    [picked, templates],
  )

  // THE PACKET'S ROLES. A merged send addresses roles BY INDEX across every
  // template in it, so the packet's role list is the longest one among the
  // selected templates — a superset that every template's own roles line up
  // under. Templates whose role lists disagree in COUNT are called out rather
  // than silently mapped, because "role 2 is the buyer here and the co-seller
  // there" is a mis-send nobody catches until the wrong person is asked to sign.
  React.useEffect(() => {
    if (!picked.length) { setRoleList([]); setRoleWarn(''); return }
    let live = true
    setLoading(true); setError(''); setRoleWarn('')
    ;(async () => {
      try {
        const details = await Promise.all(picked.map(id => templateDetails(id)))
        if (!live) return
        const lists  = details.map(d => d.roles || [])
        const widest = lists.reduce((a, b) => (b.length > a.length ? b : a), [])
        const counts = new Set(lists.map(l => l.length))
        if (counts.size > 1) {
          setRoleWarn(
            'These forms do not have the same number of signer roles. BoldSign matches roles by position, '
            + `so role 1 on every form goes to the first person below, role 2 to the second, and so on. `
            + 'Check that lines up before sending — or send the forms separately.',
          )
        }
        setRoleList(widest)
        setSigners(seedSignersFromDeal({
          roles: widest, contact, additionalContacts: extraContacts,
          buyerClients: sideClients?.buyer || null, sellerClients: sideClients?.seller || null,
          activeAgent, dealAgents,
        }))
      } catch (err) {
        if (live) setError(`Could not read the selected forms: ${err.message}`)
      } finally {
        if (live) setLoading(false)
      }
    })()
    return () => { live = false }
  }, [picked.join('|')]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (id) => setPicked(p => (p.includes(id) ? p.filter(x => x !== id) : [...p, id]))
  const move = (id, delta) => setPicked(prev => {
    const i = prev.indexOf(id), j = i + delta
    if (i < 0 || j < 0 || j >= prev.length) return prev
    const next = [...prev]
    ;[next[i], next[j]] = [next[j], next[i]]
    return next
  })

  const built = React.useMemo(
    () => buildTemplateRoles({ roleList, signers, inOrder }),
    [roleList, signers, inOrder],
  )

  // Refuse before anything is created, and name what is missing. A packet
  // rejected by BoldSign four steps later costs the agent the whole screen.
  const problem = (() => {
    if (!picked.length)     return 'Choose at least one form.'
    if (loading)            return 'Reading the selected forms…'
    if (error)              return error
    if (!roleList.length)   return 'These forms have no signer roles, so there is nobody to send them to.'
    if (!built.filledCount) return 'Fill in at least one signer — a name and an email address.'
    const bad = roleList
      .map(r => ({ r, email: String(signers?.[r.index]?.email || '').trim() }))
      .find(x => x.email && !isValidEmail(x.email))
    if (bad) return `"${bad.email}" is not a valid email address.`
    return null
  })()

  const title = [
    property ? (property.address || '').trim() : '',
    'packet',
  ].filter(Boolean).join(' ') || (deal?.title ? `${deal.title} packet` : 'Signature packet')

  const send = async () => {
    setBusy(true)
    try {
      if (together && picked.length > 1) {
        const res = await mergeTemplatesEmbedUrl({
          templateIds: picked,
          deal_id: deal.id,
          roles: built.roles,
          documentName: title,
          enableSigningOrder: inOrder,
          redirectUrl: `${window.location.origin}/boldsign-return.html`,
        })
        if (res.downloadWarning) pushToast(res.downloadWarning, 'info')
        if (!res.url) {
          // The packet exists as a draft even without a prepare URL, so say that
          // rather than implying nothing happened.
          pushToast('The packet was built as a draft on this deal, but BoldSign did not return a review screen. Open it from the Signatures tab.', 'info')
          onSent?.()
          return
        }
        setFrame({ url: res.url, documentId: res.documentId })
        return
      }

      // One form, or several sent separately. Both go out through the split
      // path: a single-form "packet" is just a send, and routing it through the
      // merge endpoint would claim a composition that never happened.
      const res = await splitSendPacket({
        deal_id: deal.id,
        roles: built.roles,
        forms: chosen.map(t => ({ templateId: t.template_id, name: t.name })),
        emailSubject: title,
      })
      if (res.warning) pushToast(res.warning, 'error')
      else pushToast(`${res.sent.length} form${res.sent.length === 1 ? '' : 's'} sent for signature.`, 'success')
      onSent?.()
    } catch (err) {
      pushToast(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const mode = packetModeFor({ together, templateIds: picked })

  // Once a merged packet is prepared, hand off to the BoldSign prepare frame the
  // rest of the app already uses. Rendered by the parent so this modal does not
  // own two very different screens.
  if (frame) return (
    <Modal open={true} onClose={() => { onSent?.() }} width={980}>
      <div className="modal__head">
        <div>
          <div className="eyebrow-label">BoldSign · Review packet</div>
          <h3 style={{ margin: 0, fontSize: 18, fontFamily: 'var(--font-display)' }}>{title}</h3>
        </div>
        <button className="drawer__close" onClick={() => onSent?.()}><Icon name="x" size={18} /></button>
      </div>
      <div className="modal__body" style={{ padding: 0, minHeight: 560 }}>
        <iframe
          title="BoldSign packet review"
          src={frame.url}
          style={{ width: '100%', height: '70vh', border: 0, display: 'block' }}
          allow="camera; microphone; clipboard-write"
        />
      </div>
      <div className="modal__foot">
        <span style={{ fontSize: 12, color: 'var(--gw-mist)', marginRight: 'auto' }}>
          Nothing is sent until you click Send inside BoldSign. The packet is already saved as a draft on this deal.
        </span>
        <button className="btn btn--secondary" onClick={() => onSent?.()}>Done</button>
      </div>
    </Modal>
  )

  return (
    <Modal open={true} onClose={onClose} width={720}>
      <div className="modal__head">
        <div>
          <div className="eyebrow-label">Signature Packets</div>
          <h3 style={{ margin: 0, fontSize: 18, fontFamily: 'var(--font-display)' }}>Compose a packet</h3>
        </div>
        <button className="drawer__close" onClick={onClose}><Icon name="x" size={18} /></button>
      </div>

      <div className="modal__body">
        {/* 1 — the forms */}
        <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', color: 'var(--gw-mist)', marginBottom: 6 }}>Forms</div>
        <div style={{ border: '1px solid var(--gw-border)', borderRadius: 'var(--radius)', overflow: 'hidden', marginBottom: 14, maxHeight: 220, overflowY: 'auto' }}>
          {templates.length === 0 && (
            <div style={{ padding: 12, fontSize: 12, color: 'var(--gw-mist)' }}>No e-signature forms are registered in the Form Library yet.</div>
          )}
          {templates.map(t => {
            const on  = picked.includes(t.template_id)
            const pos = picked.indexOf(t.template_id)
            return (
              <label key={t.template_id} style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '7px 12px', cursor: 'pointer',
                borderBottom: '1px solid var(--gw-border)', background: on ? 'var(--gw-bone)' : '#fff',
              }}>
                <input type="checkbox" checked={on} onChange={() => toggle(t.template_id)} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</div>
                  {(t.state || t.doc_type) && (
                    <div style={{ fontSize: 11, color: 'var(--gw-mist)' }}>{[t.state, t.doc_type].filter(Boolean).join(' · ')}</div>
                  )}
                </div>
                {on && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                    <span style={{ fontSize: 11, color: 'var(--gw-mist)', minWidth: 14, textAlign: 'right' }}>{pos + 1}</span>
                    <button className="btn btn--ghost btn--icon btn--sm" title="Move up" disabled={pos === 0}
                      onClick={(e) => { e.preventDefault(); move(t.template_id, -1) }}>↑</button>
                    <button className="btn btn--ghost btn--icon btn--sm" title="Move down" disabled={pos === picked.length - 1}
                      onClick={(e) => { e.preventDefault(); move(t.template_id, 1) }}>↓</button>
                  </div>
                )}
              </label>
            )
          })}
        </div>

        {/* 2 — together or separately. Only a real question with 2+ forms. */}
        {picked.length > 1 && (
          <>
            <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', color: 'var(--gw-mist)', marginBottom: 6 }}>Send</div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
              {[
                { on: true,  label: 'Together',   hint: 'One document, one signing session. Per-form downloads for MLS depend on the BoldSign plan.' },
                { on: false, label: 'Separately', hint: 'One request per form. Separate files and statuses; one declined form does not hold up the rest.' },
              ].map(opt => (
                <button
                  key={String(opt.on)}
                  className={`btn btn--sm ${together === opt.on ? 'btn--primary' : 'btn--secondary'}`}
                  onClick={() => setTogether(opt.on)}
                  title={opt.hint}
                  style={{ flex: '1 1 220px', textAlign: 'left', padding: '8px 12px' }}
                >
                  <div style={{ fontWeight: 700 }}>{opt.label}</div>
                  <div style={{ fontSize: 11, opacity: 0.85, fontWeight: 400, whiteSpace: 'normal' }}>{opt.hint}</div>
                </button>
              ))}
            </div>
          </>
        )}

        {/* 3 — who signs */}
        {picked.length > 0 && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', color: 'var(--gw-mist)' }}>Signers</div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--gw-mist)' }}>
                <input type="checkbox" checked={inOrder} onChange={e => setInOrder(e.target.checked)} />
                One at a time, in this order
              </label>
            </div>
            {loading && <div style={{ fontSize: 12, color: 'var(--gw-mist)', padding: '6px 0' }}>Reading the selected forms…</div>}
            {roleWarn && (
              <div style={{ background: '#fff8ec', border: '1px solid var(--gw-amber)', borderRadius: 'var(--radius)', padding: '8px 12px', fontSize: 12, lineHeight: 1.6, marginBottom: 10 }}>
                <strong>Check the roles.</strong> {roleWarn}
              </div>
            )}
            {roleList.map(r => (
              <div key={r.index} style={{ marginBottom: 8 }}>
                <SignerPicker
                  order={r.index}
                  roleLabel={r.name}
                  candidates={candidates}
                  value={signers[r.index] || { name: '', email: '' }}
                  onChange={(v) => setSigners(s => ({ ...s, [r.index]: v }))}
                />
              </div>
            ))}
          </>
        )}

        {error && (
          <div style={{ background: '#fff5f5', border: '1px solid var(--gw-red)', borderRadius: 'var(--radius)', padding: '8px 12px', fontSize: 12, marginTop: 10 }}>
            {error}
          </div>
        )}
      </div>

      <div className="modal__foot">
        <span style={{ fontSize: 12, color: 'var(--gw-mist)', marginRight: 'auto' }}>
          {problem
            ? problem
            : mode === 'merged'
              ? `${picked.length} forms → one document, reviewed before sending`
              : `${picked.length} form${picked.length === 1 ? '' : 's'} → ${picked.length === 1 ? 'one request' : `${picked.length} separate requests`}, sent now`}
        </span>
        <button className="btn btn--secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn--primary" onClick={send} disabled={Boolean(problem) || busy}>
          {busy ? 'Working…' : mode === 'merged' ? 'Review & send' : 'Send for signature'}
        </button>
      </div>
    </Modal>
  )
}
