// Deal drawer → Documents tab: the deal's files, grouped by kind, with
// split / merge / markup tools.

import React, { useState } from 'react'
import { Icon, MenuButton, pushToast } from '../../components/UI.jsx'
import { groupDocuments, documentsSummary, assignableKinds, kindById } from '../../lib/services/documentKinds.js'
import { listDealFiles, uploadDealFile, createDealFileSignedUrl, removeDealFile } from '../../lib/services/documents.js'
import { fetchDealCompData, updateDealCompData } from '../../lib/services/dealRecords.js'
import SplitDocumentModal from '../../components/SplitDocumentModal.jsx'
import MergeDocumentsModal from '../../components/MergeDocumentsModal.jsx'
import MarkupDocumentModal from '../../components/MarkupDocumentModal.jsx'
import { splitPdfBytes, mergePdfBytes, pdfPageCount, safeFileName, moveItem } from '../../lib/services/pdfEdit.js'
import { RequiredFormsPanel } from './RequiredFormsPanel.jsx'

function formatBytes(bytes) {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function DocumentsTab({ deal }) {
  const [files, setFiles]         = useState([])
  const [loading, setLoading]     = useState(true)
  const [uploading, setUploading] = useState(false)
  const [bucketReady, setBucketReady] = useState(true)
  // A storage policy that hides rows FILTERS them; it does not error. So "this
  // deal has no files" and "you are not allowed to see this deal's files"
  // arrive here looking identical, and this tab used to render the friendly
  // first message for both — which is how a co-agent was told a deal full of
  // signed contracts was empty. See listDealFiles() in
  // src/lib/services/documents.js and migration 0049.
  const [loadError, setLoadError]     = useState('')
  const [loadDenied, setLoadDenied]   = useState(false)
  const [dragOver, setDragOver]   = useState(false)
  const [sharedDocs, setSharedDocs] = useState([])   // filenames shared to the client portal
  const fileRef                   = React.useRef()
  // Split & merge. `split` holds the document being cut up (bytes already in
  // hand, so the preview and the cut read the same copy); `merge` holds the
  // ordered stack being joined. Both are null unless that screen is open.
  const [split, setSplit]         = useState(null)
  const [merge, setMerge]         = useState(null)
  const [markup, setMarkup]       = useState(null)
  const [preparing, setPreparing] = useState('')   // which row is fetching its bytes
  // WHICH PILE EACH FILE IS IN, where an agent has said so by hand.
  // Kept in the deal's own comp_data next to portal_docs — the same jsonb the
  // client-portal sharing list already lives in — so correcting a guess needs
  // no migration and travels with the deal.
  const [docKinds, setDocKinds] = useState({})
  const [docGroupOpen, setDocGroupOpen] = useState({})

  React.useEffect(() => {
    if (!deal?.id) return
    loadFiles()
    // Load which docs are shared with the client portal (fresh from DB)
    fetchDealCompData(deal.id)
      .then(({ data }) => {
        setSharedDocs(Array.isArray(data?.comp_data?.portal_docs) ? data.comp_data.portal_docs : [])
        const kinds = data?.comp_data?.doc_kinds
        setDocKinds(kinds && typeof kinds === 'object' ? kinds : {})
      })
  }, [deal?.id])

  const toggleShare = async (fileName) => {
    const next = sharedDocs.includes(fileName)
      ? sharedDocs.filter(n => n !== fileName)
      : [...sharedDocs, fileName]
    setSharedDocs(next)
    // Re-fetch comp_data so we don't clobber concurrent edits (key dates, etc.)
    const { data } = await fetchDealCompData(deal.id)
    const comp_data = { ...(data?.comp_data || {}), portal_docs: next }
    const { error } = await updateDealCompData(deal.id, comp_data)
    if (error) { pushToast(error.message, 'error'); return }
    pushToast(next.includes(fileName) ? 'Shared with client' : 'Removed from client portal', 'info')
  }

  const loadFiles = async () => {
    setLoading(true)
    const res = await listDealFiles(deal.id)
    setLoading(false)
    if (res.bucketMissing) { setBucketReady(false); setLoadError(''); setLoadDenied(false); return }
    setLoadError(res.error || '')
    setLoadDenied(res.denied)
    setFiles(res.files)
  }

  const upload = async (file) => {
    if (!file) return
    if (file.size > 50 * 1024 * 1024) { pushToast('File must be under 50 MB', 'error'); return }
    setUploading(true)
    const path = `deal-${deal.id}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`
    const { error } = await uploadDealFile(path, file, { upsert: false })
    setUploading(false)
    if (error) { pushToast(error.message, 'error'); return }
    pushToast(`${file.name} uploaded`)
    loadFiles()
  }

  const download = async (fileName) => {
    const { data, error } = await createDealFileSignedUrl(deal.id, fileName, 60)
    if (error) { pushToast('Could not create download link', 'error'); return }
    const a = document.createElement('a')
    a.href = data.signedUrl; a.download = fileName; a.target = '_blank'
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
  }

  const remove = async (fileName) => {
    const { error } = await removeDealFile(deal.id, fileName)
    if (error) { pushToast(error.message, 'error'); return }
    pushToast('File deleted', 'info')
    setFiles(p => p.filter(f => f.name !== fileName))
  }

  // ─── Filing ────────────────────────────────────────────────────────────────
  // Correcting the pile a file was guessed into. Written the same way the
  // client-portal list is: re-read comp_data immediately before merging, so a
  // key date or a deal term saved on another tab is not clobbered by this.
  const fileAs = async (fileName, kindId) => {
    const next = { ...docKinds, [fileName]: kindId }
    setDocKinds(next)                                   // the row moves at once
    const { data } = await fetchDealCompData(deal.id)
    const comp_data = { ...(data?.comp_data || {}), doc_kinds: next }
    const { error } = await updateDealCompData(deal.id, comp_data)
    if (error) { pushToast(`Could not file that document: ${error.message}`, 'error'); return }
    pushToast(`Filed under ${kindById(kindId).label}.`, 'info')
  }

  const docGroups  = groupDocuments(files, docKinds)
  const docSummary = documentsSummary(docGroups)

  // ─── Split & merge ─────────────────────────────────────────────────────────
  // Both run in the browser on bytes fetched with this agent's own signed URL
  // and write their result back as an ordinary upload, so storage's row rules
  // answer "may they touch this deal?" exactly as they do for a drag-and-drop.
  const isPdf = (name) => /\.pdf$/i.test(name)
  const displayNameOf = (name) => name.replace(/^\d+-/, '')

  const bytesOf = async (fileName) => {
    const { data, error } = await createDealFileSignedUrl(deal.id, fileName, 120)
    if (error || !data?.signedUrl) throw new Error(error?.message || 'Could not open that file.')
    const res = await fetch(data.signedUrl)
    if (!res.ok) throw new Error(`Could not read ${displayNameOf(fileName)} (HTTP ${res.status}).`)
    return new Uint8Array(await res.arrayBuffer())
  }

  // One upload path for everything this screen writes, so a split piece, a
  // merged packet and a dragged-in file are all filed the same way.
  const putDocument = async (fileName, bytes) => {
    // safeFileName is the authority on the name (see pdfEdit.js) — sanitizing it
    // again here would store something other than what the screen promised.
    const path = `deal-${deal.id}/${Date.now()}-${safeFileName(fileName)}`
    const { error } = await uploadDealFile(path, new Blob([bytes], { type: 'application/pdf' }), { upsert: false, contentType: 'application/pdf' })
    if (error) throw new Error(error.message)
    return path
  }

  const openSplit = async (file) => {
    setPreparing(file.name)
    try {
      setSplit({ fileName: file.name, bytes: await bytesOf(file.name) })
    } catch (e) {
      pushToast(e.message, 'error')
    } finally {
      setPreparing('')
    }
  }

  const runSplit = async (pieces) => {
    try {
      const cut = await splitPdfBytes(split.bytes, pieces)
      for (const piece of cut) await putDocument(piece.filename, piece.bytes)
      pushToast(`Split into ${cut.length} document${cut.length === 1 ? '' : 's'} — the original is still on this deal.`, 'success')
      setSplit(null)
      loadFiles()
    } catch (e) {
      pushToast(e.message, 'error')
    }
  }

  // Page counts are read up front: a merge screen that cannot say how long each
  // document is cannot warn that one of them is not a PDF at all.
  const asMergeItem = async (key, label, bytes) => {
    let pages = 0, notPdf = false
    try { pages = await pdfPageCount(bytes) } catch { notPdf = true }
    return { key, label, bytes, pages, notPdf }
  }

  const openMerge = async (file) => {
    setPreparing(file.name)
    try {
      const bytes = await bytesOf(file.name)
      setMerge({ items: [await asMergeItem(file.name, displayNameOf(file.name), bytes)], uploads: [] })
    } catch (e) {
      pushToast(e.message, 'error')
    } finally {
      setPreparing('')
    }
  }

  const addMergeFromDeal = async (doc) => {
    try {
      const bytes = await bytesOf(doc.key)
      const item = await asMergeItem(doc.key, doc.label, bytes)
      setMerge(m => ({ ...m, items: [...m.items, item] }))
    } catch (e) {
      pushToast(e.message, 'error')
    }
  }

  const addMergeFromDisk = async (file) => {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const item = await asMergeItem(`disk:${file.name}:${Date.now()}`, file.name, bytes)
      // Filed on the deal in its own right when the merge runs — a document an
      // agent added is a document on the deal, not just pages inside a copy.
      setMerge(m => ({ ...m, items: [...m.items, item], uploads: [...m.uploads, { key: item.key, name: file.name, bytes }] }))
    } catch (e) {
      pushToast(e.message, 'error')
    }
  }

  const runMerge = async (filename) => {
    try {
      const bytes = await mergePdfBytes(merge.items)
      for (const up of merge.uploads) await putDocument(up.name, up.bytes)
      await putDocument(filename, bytes)
      pushToast(`Merged into ${filename} — the originals are still on this deal.`, 'success')
      setMerge(null)
      loadFiles()
    } catch (e) {
      pushToast(e.message, 'error')
    }
  }

  // MARK UP — strike a clause out of a form before anyone signs it.
  //
  // Same shape as split and merge, and deliberately so: bytes in, bytes out,
  // filed as a NEW document. The original is never overwritten, which matters
  // most for the case an agent will reach for first — a signed PDF is the file
  // MLS receives, and a marked-up copy of an executed agreement is a working
  // document, not an amendment to it.
  const openMarkup = async (file) => {
    setPreparing(file.name)
    try {
      setMarkup({ fileName: file.name, bytes: await bytesOf(file.name) })
    } catch (e) {
      pushToast(e.message, 'error')
    } finally {
      setPreparing('')
    }
  }

  const runMarkup = async (bytes, name) => {
    try {
      await putDocument(name, bytes)
      pushToast(`Saved as ${safeFileName(name)} — the original is still on this deal.`, 'success')
      setMarkup(null)
      loadFiles()
    } catch (e) {
      pushToast(e.message, 'error')
    }
  }

  if (!bucketReady) return (
    <div style={{ padding: 20 }}>
      <div style={{ background: '#fff8ec', border: '1px solid var(--gw-amber)', borderRadius: 'var(--radius)', padding: 16, fontSize: 13, lineHeight: 1.7 }}>
        <strong>Storage bucket setup required.</strong><br />
        Run <code style={{ background: 'var(--gw-bone)', padding: '1px 5px', borderRadius: 3 }}>migrations/0049_deal_document_storage_rls.sql</code> in
        the <strong>Supabase dashboard → SQL Editor</strong>. It creates the private <code style={{ background: 'var(--gw-bone)', padding: '1px 5px', borderRadius: 3 }}>deal-documents</code> bucket
        and scopes it to the deal, so every agent on a deal sees the same files.
        <div style={{ marginTop: 8, color: 'var(--gw-mist)' }}>
          Do <strong>not</strong> add the bucket&rsquo;s policy by hand in the Storage UI. Its default template is
          <code style={{ background: 'var(--gw-bone)', padding: '1px 5px', borderRadius: 3, margin: '0 4px' }}>owner = auth.uid()</code>
          — which shows each agent only the files they uploaded themselves, and silently shows a co-agent an empty deal.
        </div>
        <button className="btn btn--secondary btn--sm" style={{ marginTop: 8 }} onClick={() => { setBucketReady(true); loadFiles() }}>
          <Icon name="refresh" size={12} /> Retry
        </button>
      </div>
    </div>
  )

  if (loading) return <div style={{ padding: 24, fontSize: 13, color: 'var(--gw-mist)' }}>Loading files…</div>

  return (
    <div style={{ padding: 16, overflowY: 'auto', flex: 1 }}>
      {/* Required Forms — state-specific packet lookup */}
      <RequiredFormsPanel />

      {/* Drop zone */}
      <div
        style={{ border: `2px dashed ${dragOver ? 'var(--gw-azure)' : 'var(--gw-border)'}`, borderRadius: 'var(--radius)', padding: '20px 16px', textAlign: 'center', cursor: 'pointer', marginBottom: 16, background: dragOver ? 'var(--gw-sky)' : 'transparent', transition: 'all 150ms' }}
        onClick={() => fileRef.current.click()}
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => { e.preventDefault(); setDragOver(false); upload(e.dataTransfer.files[0]) }}>
        <input ref={fileRef} type="file" style={{ display: 'none' }} onChange={e => upload(e.target.files[0])} />
        {uploading ? (
          <div style={{ fontSize: 13, color: 'var(--gw-azure)', fontWeight: 600 }}>Uploading…</div>
        ) : (
          <>
            <Icon name="upload" size={22} style={{ color: 'var(--gw-border)', marginBottom: 6 }} />
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--gw-ink)' }}>Drop a file or click to upload</div>
            <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginTop: 3 }}>PDF, Word, images — max 50 MB · Stored securely in Supabase</div>
          </>
        )}
      </div>

      {/* THE FILING CABINET, FILED.
          One flat list of whatever each file was called on arrival answered
          "where's the agency agreement?" by making an agent read eleven
          filenames. Each file now sits in a named pile — agreements, offers,
          disclosures, reports, closing, audit trails — with the upload
          timestamp stripped off its name and its actions quiet until wanted.

          The pile is a GUESS from the filename wherever the CRM did not write
          the file itself, so every row carries "File as…" to correct it, and a
          correction is remembered on the deal. Anything unplaceable goes to
          Unfiled rather than into a wrong pile quietly: a misfiled disclosure
          is worse than an unfiled one, because nobody searches the pile they
          believe is complete. */}
      {loadError ? (
        <div style={{ margin: '16px 0', background: 'var(--gw-red-light)', border: '1px solid var(--gw-red)', borderRadius: 'var(--radius)', padding: 14, fontSize: 13, lineHeight: 1.7 }}>
          <strong>This deal&rsquo;s documents could not be loaded.</strong><br />
          {loadError}
          {loadDenied && (
            <div style={{ marginTop: 6 }}>
              Storage is still scoped to whoever uploaded each file. Apply
              <code style={{ background: 'var(--gw-bone)', padding: '1px 5px', borderRadius: 3, margin: '0 4px' }}>migrations/0049_deal_document_storage_rls.sql</code>
              so a deal&rsquo;s documents follow the deal to every agent on it. If 0049 is already applied and this
              persists, a leftover <strong>restrictive</strong> policy is vetoing it &mdash; run
              <code style={{ background: 'var(--gw-bone)', padding: '1px 5px', borderRadius: 3, margin: '0 4px' }}>migrations/0051_storage_policy_authority.sql</code>.
            </div>
          )}
          <div style={{ marginTop: 8 }}>
            <button className="btn btn--secondary btn--sm" onClick={loadFiles}><Icon name="refresh" size={12} /> Retry</button>
          </div>
        </div>
      ) : files.length === 0 ? (
        <div style={{ textAlign: 'center', color: 'var(--gw-mist)', fontSize: 13, padding: '16px 0' }}>
          No documents yet. Upload contracts, inspections, or any deal files.
        </div>
      ) : (
        <>
          {docSummary && (
            <div style={{ fontSize: 11.5, color: 'var(--gw-mist)', marginBottom: 8 }}>{docSummary}</div>
          )}
          {docGroups.map(group => {
            const open = docGroupOpen[group.id] ?? !group.closed
            const tone = KIND_TONE[group.tone] || 'var(--gw-border)'
            return (
              <div key={group.id} style={{ marginBottom: 14 }}>
                <button
                  type="button"
                  onClick={() => setDocGroupOpen(g => ({ ...g, [group.id]: !open }))}
                  aria-expanded={open}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                    background: 'transparent', border: 0, borderBottom: '1px solid var(--gw-border)',
                    padding: '4px 2px 6px', marginBottom: 6, cursor: 'pointer', fontFamily: 'var(--font-body)',
                  }}
                >
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: tone, flexShrink: 0 }} />
                  <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--gw-ink)' }}>
                    {group.label}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--gw-mist)' }}>{group.files.length}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--gw-mist)' }}>{open ? '\u25be' : '\u25b8'}</span>
                </button>

                {open && group.hint && (
                  <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginBottom: 6, lineHeight: 1.5 }}>{group.hint}</div>
                )}

                {open && group.files.map(file => {
                  const ext    = file.name.split('.').pop().toUpperCase()
                  const shared = sharedDocs.includes(file.name)
                  return (
                    <div key={file.name} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 10px', border: '1px solid var(--gw-border)', borderRadius: 'var(--radius)', marginBottom: 6, background: '#fff' }}>
                      <span style={{ width: 3, alignSelf: 'stretch', borderRadius: 2, background: tone, flexShrink: 0 }} />
                      <div style={{
                        width: 30, height: 30, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        flexShrink: 0, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.03em',
                        background: file.signed ? 'var(--gw-green-light)' : file.audit ? 'var(--gw-bone)' : 'var(--gw-sky)',
                        color:      file.signed ? 'var(--gw-green)'       : file.audit ? 'var(--gw-mist)' : 'var(--gw-azure)',
                      }}>
                        {ext.slice(0, 4)}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                          <span style={{ fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={file.name}>
                            {file.label}
                          </span>
                          {file.signed && (
                            <span style={{ fontSize: 9, fontWeight: 700, background: 'var(--gw-green-light)', color: 'var(--gw-green)', padding: '1px 6px', borderRadius: 8, flexShrink: 0, textTransform: 'uppercase', letterSpacing: '0.04em' }}>signed</span>
                          )}
                          {shared && (
                            <span style={{ fontSize: 9, fontWeight: 700, background: 'var(--gw-sky)', color: 'var(--gw-azure)', padding: '1px 6px', borderRadius: 8, flexShrink: 0, textTransform: 'uppercase', letterSpacing: '0.04em' }}>client</span>
                          )}
                        </div>
                        <div style={{ fontSize: 10.5, color: 'var(--gw-mist)' }}>
                          {formatBytes(file.metadata?.size)}
                          {file.created_at && <> · {new Date(file.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</>}
                          {!file.confirmed && file.kind !== 'unfiled' && <> · filed by name</>}
                        </div>
                      </div>

                      {/* The one action this file is for. Splitting a scan into
                          its forms is the common one; everything else is behind
                          the menu, the same way the Signatures rows work. */}
                      {isPdf(file.name) && (
                        <button
                          className="btn btn--ghost btn--sm" style={{ fontSize: 11, flexShrink: 0 }}
                          title="Cut this PDF into separate documents by page range"
                          disabled={Boolean(preparing)} onClick={() => openSplit(file)}
                        >
                          {preparing === file.name ? 'Opening…' : 'Split'}
                        </button>
                      )}
                      <MenuButton
                        title="Everything else for this document"
                        items={[
                          { label: 'Download', onClick: () => download(file.name) },
                          isPdf(file.name) && { label: 'Merge with…', title: 'Join this PDF with others on this deal into one document', onClick: () => openMerge(file), disabled: Boolean(preparing) },
                          isPdf(file.name) && { label: 'Mark up…', title: 'Strike clauses out of this PDF and save a marked-up copy', onClick: () => openMarkup(file), disabled: Boolean(preparing) },
                          { label: shared ? 'Stop sharing with client' : 'Share with client portal', onClick: () => toggleShare(file.name) },
                          { divider: true },
                          // "File as…" on every row, because the pile is a guess
                          // wherever the CRM did not write the file itself — and a
                          // guess with no way to correct it is just a wrong answer.
                          ...assignableKinds().map(k => ({
                            label: `${file.kind === k.id ? '✓ ' : ''}File as ${k.label}`,
                            onClick: () => fileAs(file.name, k.id),
                            disabled: file.audit,
                            title: file.audit ? 'An audit trail files itself — it is compliance evidence, not paperwork' : undefined,
                          })),
                          { divider: true },
                          { label: 'Delete', danger: true, onClick: () => remove(file.name) },
                        ]}
                      />
                    </div>
                  )
                })}
              </div>
            )
          })}
        </>
      )}

      {split && (
        <SplitDocumentModal
          fileName={split.fileName}
          bytes={split.bytes}
          onClose={() => setSplit(null)}
          onSubmit={runSplit}
        />
      )}

      {merge && (
        <MergeDocumentsModal
          items={merge.items}
          available={files
            .filter(f => isPdf(f.name) && !merge.items.some(i => i.key === f.name))
            .map(f => ({ key: f.name, label: displayNameOf(f.name) }))}
          onAddFromDeal={addMergeFromDeal}
          onAddFromDisk={addMergeFromDisk}
          onRemove={key => setMerge(m => ({
            ...m,
            items:   m.items.filter(i => i.key !== key),
            uploads: m.uploads.filter(u => u.key !== key),
          }))}
          onReorder={(from, to) => setMerge(m => ({ ...m, items: moveItem(m.items, from, to) }))}
          onClose={() => setMerge(null)}
          onSubmit={runMerge}
        />
      )}

      {markup && (
        <MarkupDocumentModal
          fileName={markup.fileName}
          bytes={markup.bytes}
          onClose={() => setMarkup(null)}
          onSubmit={runMarkup}
        />
      )}
    </div>
  )
}

// A pile's colour on the Documents tab — the dot on its header and the rail
// down each of its rows, so a file says which pile it is in even once the
// header has scrolled away.
const KIND_TONE = {
  purple: 'var(--gw-purple)',
  amber:  'var(--gw-amber)',
  azure:  'var(--gw-azure)',
  green:  'var(--gw-green)',
  gold:   'var(--gw-gold)',
  mist:   'var(--gw-border)',
}
