import React from 'react'
import { Icon, Modal, pushToast } from './UI.jsx'
import { validateMerge, baseName } from '../lib/services/pdfEdit.js'

// ─────────────────────────────────────────────────────────────────────────────
// MERGE DOCUMENTS — several files on the deal, one document out.
//
// Opened from the document the agent already picked, which is why that document
// is in the list the moment this appears: the screen's job is what comes NEXT —
// what goes after it, in what order, and what the result is called.
//
// ORDER IS THE POINT, not a display preference. "The amendment after the
// agreement it amends" and "the disclosure before its acknowledgement" are how
// a file gets read, so the list is reorderable by drag and by keyboard, and
// nothing here re-sorts it.
//
// Two ways to add: a document already on the deal (the common case — it is
// already filed, already named) or a file from the agent's computer, which is
// uploaded to the deal as part of the merge rather than living only inside the
// merged copy.
// ─────────────────────────────────────────────────────────────────────────────
export default function MergeDocumentsModal({ items, available = [], onClose, onAddFromDeal, onAddFromDisk, onRemove, onReorder, onSubmit }) {
  const [name, setName] = React.useState('')
  const [picking, setPicking] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [dragIndex, setDragIndex] = React.useState(null)
  const fileRef = React.useRef(null)

  const verdict = validateMerge({ items, name })
  const totalPages = items.reduce((n, i) => n + (i.pages || 0), 0)

  const submit = async () => {
    if (!verdict.ok) { pushToast(verdict.error, 'error'); return }
    setBusy(true)
    try {
      await onSubmit(verdict.filename)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={true} onClose={busy ? () => {} : onClose} width={640}>
      <div className="modal__head">
        <div>
          <div className="eyebrow-label">Documents</div>
          <h3 style={{ margin: 0, fontSize: 18, fontFamily: 'var(--font-display)' }}>Merge documents</h3>
        </div>
        <button className="drawer__close" onClick={onClose} disabled={busy}><Icon name="x" size={18} /></button>
      </div>

      <div className="modal__body">
        {/* The stack, in the order it will be merged. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
          {items.map((item, i) => (
            <div
              key={item.key}
              draggable={!busy}
              onDragStart={() => setDragIndex(i)}
              onDragEnd={() => setDragIndex(null)}
              onDragOver={e => e.preventDefault()}
              onDrop={e => {
                e.preventDefault()
                if (dragIndex != null && dragIndex !== i) onReorder(dragIndex, i)
                setDragIndex(null)
              }}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
                border: '1px solid var(--gw-border)', borderRadius: 'var(--radius)',
                background: dragIndex === i ? 'var(--gw-sky)' : 'var(--gw-bone)',
                opacity: dragIndex === i ? 0.6 : 1, cursor: 'grab',
              }}
            >
              <span style={{ color: 'var(--gw-mist)', fontSize: 15, lineHeight: 1 }} aria-hidden="true">≡</span>
              <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.label}>
                {item.label}
              </span>
              <span style={{ fontSize: 11, color: 'var(--gw-mist)', flexShrink: 0 }}>
                {item.pages ? `${item.pages} page${item.pages === 1 ? '' : 's'}` : 'not a PDF'}
              </span>
              {/* Drag is the fast path; these are the one that works with a keyboard. */}
              <button className="btn btn--ghost btn--icon btn--sm" title="Move up" disabled={i === 0 || busy}
                      onClick={() => onReorder(i, i - 1)} aria-label={`Move ${item.label} up`}>↑</button>
              <button className="btn btn--ghost btn--icon btn--sm" title="Move down" disabled={i === items.length - 1 || busy}
                      onClick={() => onReorder(i, i + 1)} aria-label={`Move ${item.label} down`}>↓</button>
              <button className="btn btn--ghost btn--icon btn--sm" title="Remove from this merge" disabled={busy}
                      onClick={() => onRemove(item.key)} aria-label={`Remove ${item.label}`}>
                <Icon name="x" size={12} />
              </button>
            </div>
          ))}
          {!items.length && (
            <div style={{ fontSize: 13, color: 'var(--gw-mist)' }}>Nothing selected yet — add the documents to merge.</div>
          )}
        </div>

        <div style={{ textAlign: 'right', marginBottom: 14 }}>
          <button className="btn btn--ghost btn--sm" style={{ fontSize: 12, color: 'var(--gw-azure)' }}
                  onClick={() => setPicking(p => !p)} disabled={busy}>
            add document
          </button>
        </div>

        {picking && (
          <div style={{ border: '1px solid var(--gw-border)', borderRadius: 'var(--radius)', marginBottom: 14, overflow: 'hidden' }}>
            {available.length === 0 && (
              <div style={{ padding: '10px 12px', fontSize: 12, color: 'var(--gw-mist)' }}>
                Every other document on this deal is already in the list.
              </div>
            )}
            {available.map(doc => (
              <button
                key={doc.key}
                className="btn btn--ghost"
                style={{ display: 'flex', width: '100%', justifyContent: 'flex-start', gap: 8, padding: '8px 12px', borderRadius: 0, borderBottom: '1px solid var(--gw-border)', fontSize: 13 }}
                onClick={() => { onAddFromDeal(doc); setPicking(false) }}
              >
                <Icon name="document" size={13} style={{ color: 'var(--gw-azure)', flexShrink: 0 }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{doc.label}</span>
              </button>
            ))}
            <button
              className="btn btn--ghost"
              style={{ display: 'flex', width: '100%', justifyContent: 'flex-start', gap: 8, padding: '8px 12px', borderRadius: 0, fontSize: 13, color: 'var(--gw-azure)' }}
              onClick={() => fileRef.current?.click()}
            >
              <Icon name="upload" size={13} /> Upload a PDF from this computer…
            </button>
            <input
              ref={fileRef} type="file" accept="application/pdf,.pdf" style={{ display: 'none' }}
              onChange={async e => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (!file) return
                setPicking(false)
                await onAddFromDisk(file)
              }}
            />
          </div>
        )}

        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Merged document name:</label>
        <input
          className="form-control"
          style={{ fontSize: 13, width: '100%' }}
          value={name}
          placeholder={items.length ? `${baseName(items[0].label)} (merged)` : ''}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && verdict.ok && !busy) submit() }}
          aria-label="Merged document name"
        />

        <div style={{ marginTop: 8, fontSize: 12, color: verdict.ok ? 'var(--gw-mist)' : 'var(--gw-red)', lineHeight: 1.6 }}>
          {verdict.ok
            ? `${items.length} documents · ${totalPages} page${totalPages === 1 ? '' : 's'} · saved to this deal as ${verdict.filename}. The originals are kept.`
            : verdict.error}
        </div>
      </div>

      <div className="modal__foot">
        <button className="btn btn--secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn--primary" onClick={submit} disabled={!verdict.ok || busy}>
          {busy ? 'Merging…' : 'Merge'}
        </button>
      </div>
    </Modal>
  )
}
