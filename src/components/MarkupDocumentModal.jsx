import React from 'react'
import { Icon, Modal, pushToast } from './UI.jsx'
import PdfMarkup, { MarksList } from './PdfMarkup.jsx'
import { drawStrikes, groupMarks, validateMarks, pdfPageBoxes } from '../lib/services/pdfStrike.js'
import { baseName } from '../lib/services/pdfEdit.js'

// ─────────────────────────────────────────────────────────────────────────────
// MARK UP DOCUMENT — strike clauses out of a form, and write the result.
//
// THE SHAPE IS SPLIT'S. Document on the left at readable size, what you have
// done to it on the right. An agent striking a clause has to be able to READ the
// clause, so the page is the content and the panel is the margin note — not the
// other way round.
//
// NOTHING IS DESTRUCTIVE, and on this screen that is not a nicety. This modal
// hands its caller new bytes and never writes anything itself; every caller
// files them as a NEW document and leaves the original where it was. That rule
// is absolute for a signed PDF — that file is what MLS receives, and a marked-up
// copy of an executed agreement is a working document, not an amendment to it.
//
// DRAFTS, NOT PACKETS IN FLIGHT. A packet somebody is already signing keeps the
// acknowledgement-plus-initials path (api/boldsign.js, "packet-add-initials"):
// a line over text that has been signed says nothing about who agreed to the
// change or when. Callers enforce that; this screen says it out loud so an agent
// who reaches it by another route still reads it.
// ─────────────────────────────────────────────────────────────────────────────
export default function MarkupDocumentModal({
  fileName,
  bytes,
  onClose,
  onSubmit,
  eyebrow = 'Mark up document',
  submitLabel = 'Save marked-up copy',
}) {
  const [marks, setMarks] = React.useState([])
  const [pages, setPages] = React.useState([])
  const [lit, setLit] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [name, setName] = React.useState(() => `${baseName(fileName)} (marked)`)

  // Page sizes and rotation, read up front: validateMarks answers "can a line be
  // placed here at all" against them, and a screen that cannot answer that
  // cannot warn before the agent has done the work.
  React.useEffect(() => {
    let live = true
    pdfPageBoxes(bytes)
      .then(p => { if (live) setPages(p) })
      .catch(err => { if (live) pushToast(err.message || 'That PDF could not be read.', 'error') })
    return () => { live = false }
  }, [bytes])

  const addMarks = React.useCallback((added) => setMarks(prev => [...prev, ...added]), [])
  const removeGroup = (group) => {
    setMarks(prev => prev.filter(m => m.group !== group))
    setLit(l => (l === group ? null : l))
  }

  const submit = async () => {
    const verdict = validateMarks(marks, pages)
    if (!verdict.ok) { pushToast(verdict.error, 'error'); return }

    setBusy(true)
    try {
      // drawStrikes re-validates before it touches a byte, so a rotated page or
      // a mark off the end of the document is refused here with the reason
      // rather than producing a file with a line in the wrong place.
      const out = await drawStrikes(bytes, marks)
      await onSubmit(out, name)
    } catch (err) {
      pushToast(err.message || 'The marked-up PDF could not be written.', 'error')
    } finally {
      setBusy(false)
    }
  }

  const groups = groupMarks(marks)
  const close = busy ? () => {} : onClose

  return (
    <Modal open={true} onClose={close} width={null} className="modal--workspace">
      <div className="modal__head">
        <div style={{ minWidth: 0 }}>
          <div className="eyebrow-label">{eyebrow}</div>
          <h3 style={{
            margin: 0, fontSize: 18, fontFamily: 'var(--font-display)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {baseName(fileName)}
          </h3>
        </div>
        <button className="drawer__close" onClick={close} disabled={busy}>
          <Icon name="x" size={18} />
        </button>
      </div>

      <div className="modal__body">
        <div className="markup-workspace markup-workspace--fill">

          {/* ── The form ─────────────────────────────────────────────────── */}
          <div className="markup-workspace__doc">
            <PdfMarkup bytes={bytes} marks={marks} onAddMarks={addMarks} highlightGroup={lit} />
          </div>

          {/* ── What has been struck ─────────────────────────────────────── */}
          <aside className="markup-workspace__rail">
            <div>
              <div className="eyebrow-label">Struck passages ({groups.length})</div>
              <MarksList groups={groups} onRemove={removeGroup} onHover={setLit} />
            </div>

            <div>
              <label className="eyebrow-label" htmlFor="markup-doc-name">Save as</label>
              <input
                id="markup-doc-name"
                className="form-control"
                value={name}
                onChange={e => setName(e.target.value)}
                disabled={busy}
                style={{ width: '100%' }}
              />
              <p style={{ fontSize: 11, color: 'var(--gw-mist)', lineHeight: 1.5, marginTop: 6 }}>
                Saved as a new document. The original stays on this deal exactly as it is.
              </p>
            </div>

            <div style={{
              marginTop: 'auto', fontSize: 11, lineHeight: 1.55, color: 'var(--gw-mist)',
              borderTop: '1px solid var(--gw-border)', paddingTop: 12,
            }}>
              <strong style={{ display: 'block', color: 'var(--gw-slate)', marginBottom: 3 }}>
                Before anyone signs
              </strong>
              A packet already out for signature keeps the acknowledgement-plus-initials path.
              A line over text somebody has signed says nothing about who agreed to it, or when.
            </div>
          </aside>
        </div>
      </div>

      <div className="modal__foot">
        <span style={{ marginRight: 'auto', fontSize: 12, color: 'var(--gw-mist)' }}>
          {marks.length
            ? `${marks.length} stroke${marks.length === 1 ? '' : 's'} across ${groups.length} passage${groups.length === 1 ? '' : 's'}`
            : 'Select text on the form to strike it'}
        </span>
        <button className="btn btn--secondary" onClick={close} disabled={busy}>Cancel</button>
        <button className="btn btn--primary" onClick={submit} disabled={!marks.length || busy}>
          {busy ? 'Writing…' : submitLabel}
        </button>
      </div>
    </Modal>
  )
}
