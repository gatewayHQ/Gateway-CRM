import React from 'react'
import { Icon, Modal, pushToast } from './UI.jsx'
import { listMlsFiles, packForMls, MLS_PRESETS, applyPreset } from '../lib/services/boldsign.js'
import { saveFileFromUrl } from '../lib/savePdf.js'

// ─────────────────────────────────────────────────────────────────────────────
// PACK FOR MLS — assemble the deal's signed forms into what a board will accept.
//
// This screen exists because of three things BoldSign will not do, and it says
// so out loud rather than leaving an agent to discover them at the upload:
//   • it will not split pages out of a signed combined PDF;
//   • it will not merge two completed envelopes into a new envelope;
//   • it will not restripe a signed file.
// So everything here is assembled locally from PDFs already archived on the
// deal. Nothing on this screen sends anything, and nothing it produces is
// written back into a BoldSign document.
//
// THE CHOICE IS NOT COSMETIC. Boards differ: some want one upload per form,
// some want the whole file as one document. "Separate files" and "One merged
// PDF" are two different deliverables and get two buttons, not a dropdown
// nobody reads.
// ─────────────────────────────────────────────────────────────────────────────
export default function MlsPackModal({ dealId, address, onClose }) {
  const [loading,  setLoading]  = React.useState(true)
  const [error,    setError]    = React.useState('')
  const [files,    setFiles]    = React.useState([])
  const [unarchived, setUnarchived] = React.useState([])
  // Order matters for a merged pack ("amendments after the purchase agreement"
  // is a filing requirement), so the selection is an ORDERED list, not a Set.
  const [picked,   setPicked]   = React.useState([])
  const [cover,    setCover]    = React.useState(true)
  const [busy,     setBusy]     = React.useState('')

  React.useEffect(() => {
    let live = true
    ;(async () => {
      try {
        const data = await listMlsFiles(dealId)
        if (!live) return
        setFiles(data.files || [])
        setUnarchived(data.unarchived || [])
      } catch (err) {
        if (live) setError(err.message)
      } finally {
        if (live) setLoading(false)
      }
    })()
    return () => { live = false }
  }, [dealId])

  const toggle = (id) => setPicked(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]))
  const move = (id, delta) => setPicked(prev => {
    const i = prev.indexOf(id)
    const j = i + delta
    if (i < 0 || j < 0 || j >= prev.length) return prev
    const next = [...prev]
    ;[next[i], next[j]] = [next[j], next[i]]
    return next
  })

  const usePreset = (preset) => {
    const hit = applyPreset(files, preset.id)
    if (!hit.length) {
      // Says which preset and why, rather than doing nothing. A preset that
      // silently selects nothing reads as a broken button.
      pushToast(`No completed forms on this deal look like a ${preset.label.toLowerCase()}. Tick the forms you want instead.`, 'info')
      return
    }
    setPicked(hit.map(f => f.id))
  }

  const pack = async (mode) => {
    setBusy(mode)
    try {
      const res = await packForMls(dealId, {
        mode,
        fileIds: picked,
        order:   picked,
        address: address || undefined,
        ...(mode === 'merge' ? { coverSheet: cover } : {}),
      })
      // saveFileFromUrl, not savePdfFromUrl: this is a .zip as often as a .pdf,
      // and the PDF helper forces a .pdf extension — which would hand the agent
      // "MLS-….zip.pdf", a file their machine refuses to open. The filename the
      // server chose is the authority.
      await saveFileFromUrl(res.url, res.filename)
      pushToast(
        mode === 'zip'
          ? `${res.count} form${res.count === 1 ? '' : 's'} downloaded as separate files.`
          : `${res.count} forms merged into one PDF.`,
        'success',
      )
    } catch (err) {
      pushToast(err.message, 'error')
    } finally {
      setBusy('')
    }
  }

  const selected = picked.map(id => files.find(f => f.id === id)).filter(Boolean)
  const canZip   = selected.length >= 1
  const canMerge = selected.length >= 2

  return (
    <Modal open={true} onClose={onClose} width={720}>
      <div className="modal__head">
        <div>
          <div className="eyebrow-label">Signature Packets</div>
          <h3 style={{ margin: 0, fontSize: 18, fontFamily: 'var(--font-display)' }}>Pack for MLS</h3>
        </div>
        <button className="drawer__close" onClick={onClose}><Icon name="x" size={18} /></button>
      </div>

      <div className="modal__body">
        {loading && <div style={{ fontSize: 13, color: 'var(--gw-mist)' }}>Loading this deal's completed forms…</div>}

        {!loading && error && (
          <div style={{ background: '#fff5f5', border: '1px solid var(--gw-red)', borderRadius: 'var(--radius)', padding: '10px 12px', fontSize: 12, lineHeight: 1.6 }}>
            <strong>Could not read this deal's forms.</strong> {error}
          </div>
        )}

        {!loading && !error && files.length === 0 && (
          <div style={{ fontSize: 13, color: 'var(--gw-mist)', lineHeight: 1.7 }}>
            Nothing on this deal has been signed yet, so there is nothing to pack.
            {unarchived.length > 0 && (
              <div style={{ marginTop: 8 }}>
                {unarchived.length} completed packet{unarchived.length === 1 ? '' : 's'} {unarchived.length === 1 ? 'has' : 'have'} not
                been archived yet — press <strong>Download Signed PDF</strong> on {unarchived.length === 1 ? 'that row' : 'those rows'} once,
                and {unarchived.length === 1 ? 'it' : 'they'} will appear here.
              </div>
            )}
          </div>
        )}

        {!loading && !error && files.length > 0 && (
          <>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
              <span style={{ fontSize: 11, color: 'var(--gw-mist)', alignSelf: 'center', marginRight: 2 }}>Presets:</span>
              {MLS_PRESETS.filter(p => p.match.length).map(p => (
                <button key={p.id} className="btn btn--ghost btn--sm" style={{ fontSize: 11 }} title={p.hint} onClick={() => usePreset(p)}>
                  {p.label}
                </button>
              ))}
              {picked.length > 0 && (
                <button className="btn btn--ghost btn--sm" style={{ fontSize: 11 }} onClick={() => setPicked([])}>Clear</button>
              )}
            </div>

            {/* The checklist: every completed file on the deal, originals AND
                corrections, oldest first. A correction is marked, because
                "original + acknowledgement" is a pair a board reads in order. */}
            <div style={{ border: '1px solid var(--gw-border)', borderRadius: 'var(--radius)', overflow: 'hidden', marginBottom: 12 }}>
              {files.map(f => {
                const on  = picked.includes(f.id)
                const pos = picked.indexOf(f.id)
                return (
                  <label
                    key={f.id}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', cursor: 'pointer',
                      borderBottom: '1px solid var(--gw-border)', background: on ? 'var(--gw-bone)' : '#fff',
                    }}
                  >
                    <input type="checkbox" checked={on} onChange={() => toggle(f.id)} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {f.form_name}
                        {f.isCorrection && (
                          <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: 'var(--gw-amber)', textTransform: 'uppercase' }}>correction</span>
                        )}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--gw-mist)' }}>
                        {f.documentName}
                        {f.pages ? ` · ${f.pages} page${f.pages === 1 ? '' : 's'}` : ''}
                        {f.completedAt ? ` · signed ${new Date(f.completedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` : ''}
                      </div>
                    </div>
                    {/* Reordering only appears once a file is selected, and only
                        matters for a merge — but it is shown for both, because
                        the order also decides the numbering on the cover sheet. */}
                    {on && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                        <span style={{ fontSize: 11, color: 'var(--gw-mist)', minWidth: 16, textAlign: 'right' }}>{pos + 1}</span>
                        <button
                          className="btn btn--ghost btn--icon btn--sm" title="Move up" disabled={pos === 0}
                          onClick={(e) => { e.preventDefault(); move(f.id, -1) }}
                        >↑</button>
                        <button
                          className="btn btn--ghost btn--icon btn--sm" title="Move down" disabled={pos === picked.length - 1}
                          onClick={(e) => { e.preventDefault(); move(f.id, 1) }}
                        >↓</button>
                      </div>
                    )}
                  </label>
                )
              })}
            </div>

            {unarchived.length > 0 && (
              <div style={{ background: '#fff8ec', border: '1px solid var(--gw-amber)', borderRadius: 'var(--radius)', padding: '8px 12px', fontSize: 12, lineHeight: 1.6, marginBottom: 12 }}>
                <strong>{unarchived.length} completed packet{unarchived.length === 1 ? '' : 's'} not listed.</strong>{' '}
                {unarchived.map(u => u.documentName || u.documentId).join(', ')} — the signed PDF has not been archived yet.
                Press <strong>Download Signed PDF</strong> on {unarchived.length === 1 ? 'that row' : 'those rows'} once and refresh this screen.
              </div>
            )}

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--gw-ink)' }}>
              <input type="checkbox" checked={cover} onChange={e => setCover(e.target.checked)} />
              Add a cover sheet to the merged PDF (address, MLS number, date, and the forms it contains)
            </label>
          </>
        )}
      </div>

      <div className="modal__foot">
        <button className="btn btn--secondary" onClick={onClose} disabled={Boolean(busy)}>Close</button>
        <button
          className="btn btn--secondary"
          onClick={() => pack('zip')}
          disabled={!canZip || Boolean(busy)}
          title="One PDF per form, in a zip — for a board that wants each form uploaded separately"
        >
          {busy === 'zip' ? 'Packing…' : `Download separately${selected.length ? ` (${selected.length})` : ''}`}
        </button>
        <button
          className="btn btn--primary"
          onClick={() => pack('merge')}
          disabled={!canMerge || Boolean(busy)}
          title={canMerge
            ? 'Concatenate the selected forms into one PDF, in the order shown'
            : 'Select at least two forms to merge — one on its own can be downloaded separately'}
        >
          {busy === 'merge' ? 'Merging…' : 'Merge into one PDF'}
        </button>
      </div>
    </Modal>
  )
}
