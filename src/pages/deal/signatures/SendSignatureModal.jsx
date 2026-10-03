// Send an uploaded document for signature.

import React from 'react'
import { documentEmbedUrl, formatBytes as fmtBytes, MAX_SEND_BYTES } from '../../../lib/services/boldsign.js'
import { uploadSendableDealPdf, signSendableDealUrl } from '../../../lib/services/boldsignDocuments.js'
import SignerPicker, { buildCandidates, isValidEmail } from '../../../components/SignerPicker.jsx'
import { Icon, Modal, pushToast } from '../../../components/UI.jsx'
import MarkupDocumentModal from '../../../components/MarkupDocumentModal.jsx'
import { safeFileName } from '../../../lib/services/pdfEdit.js'
import { createDealFileSignedUrl } from '../../../lib/services/documents.js'
import { boldSignReturnUrl } from './boldsignDocs.js'
import { BoldSignStepModal } from './BoldSignStepModal.jsx'
import { SIGNER_COLORS } from './signatureSteps.js'

// ── Send for Signature modal — drives BoldSign document creation ────────────
// Flow:
//   1. Agent fills in signers + picks a PDF here in the CRM
//   2. We POST the PDF + signers to /api/boldsign, which auto-places a
//      signature + date field per signer and sends immediately via BoldSign
//   3. BoldSign emails each signer; they sign in their browser
//   4. BoldSign webhook hits /api/boldsign → status flips sent → completed
export function SendSignatureModal({ deal, contacts, properties, dealFiles, activeAgent, onClose, onSent }) {
  // Primary signer: contact linked directly to the deal
  const contact      = contacts?.find(c => c.id === deal?.contact_id)
  const defaultName  = `${contact?.first_name || ''} ${contact?.last_name || ''}`.trim()
  const defaultEmail = contact?.email || ''

  // Secondary signer: property owner contact (if different from primary)
  const linkedProperty   = properties?.find(p => p.id === deal?.property_id)
  const ownerContact     = linkedProperty?.linked_contact_id
    ? contacts?.find(c => c.id === linkedProperty.linked_contact_id)
    : null
  const ownerIsDifferent = ownerContact && ownerContact.id !== deal?.contact_id
  const ownerName        = ownerIsDifferent ? `${ownerContact.first_name || ''} ${ownerContact.last_name || ''}`.trim() : ''
  const ownerEmail       = ownerIsDifferent ? (ownerContact.email || '') : ''

  const [subject,    setSubject]   = React.useState(`Please sign: ${deal?.title || 'Document'}`)
  const [file,       setFile]      = React.useState(null)
  const [pickedFile, setPickedFile]= React.useState('')
  const [agentSigns, setAgentSigns]= React.useState(false)
  const [markup,     setMarkup]    = React.useState(null)
  const [opening,    setOpening]   = React.useState(false)
  const [sending,    setSending]   = React.useState(false)
  const [dragOver,   setDragOver]  = React.useState(false)
  const [embedUrl,   setEmbedUrl]  = React.useState(null)   // BoldSign prepare/send iframe URL
  const [embedDocId, setEmbedDocId]= React.useState(null)   // its document id — needed to capture the field layout
  const [useTextTags, setUseTextTags] = React.useState(false)   // PDF already has {{...}} text tags baked in
  const fileRef = React.useRef()

  const [signers, setSigners] = React.useState(() => {
    // Signer 1: deal contact. If they have no email, fall back to property owner.
    let s1Name  = defaultName
    let s1Email = defaultEmail
    if (!s1Email && ownerContact?.email) {
      s1Name  = ownerName
      s1Email = ownerContact.email
    }
    const base = [{ id: 1, name: s1Name, email: s1Email }]
    if (ownerIsDifferent && ownerEmail && ownerEmail !== s1Email) {
      base.push({ id: 2, name: ownerName, email: ownerEmail })
    }
    return base
  })

  const addSigner    = () => setSigners(p => [...p, { id: Date.now(), name:'', email:'' }])
  const removeSigner = (id) => setSigners(p => p.filter(s => s.id !== id))

  // Validate at PICK time, not at send time. Drag-and-drop bypasses the input's
  // own accept=".pdf", so a dropped .docx used to be shipped to BoldSign
  // labelled as a PDF and failed there with an opaque message; an oversized file
  // failed even later, as a bare HTTP 413.
  const chooseFile = (picked) => {
    if (!picked) return
    if (!/\.pdf$/i.test(picked.name) && picked.type !== 'application/pdf') {
      pushToast(`"${picked.name}" is not a PDF. Convert it first — BoldSign only signs PDFs.`, 'error'); return
    }
    if (picked.size > MAX_SEND_BYTES) {
      pushToast(`"${picked.name}" is ${fmtBytes(picked.size)} — the limit is ${fmtBytes(MAX_SEND_BYTES)}. Split it into two packets.`, 'error'); return
    }
    setFile(picked); setPickedFile('')
  }

  // The people this deal already knows. The ad-hoc flow has no roles to seed
  // from, so the picker is doing more work here than in the template flow.
  const signerCandidates = React.useMemo(() => buildCandidates({
    dealContacts: [contact, ownerContact].filter(Boolean),
    contacts,
    agents: activeAgent ? [activeAgent] : [],
  }), [contact, ownerContact, contacts, activeAgent])

  const allSigners = React.useMemo(() => {
    const clients = signers.map(s => ({ ...s, routingOrder: 1 }))
    if (agentSigns && activeAgent) {
      clients.push({ id:'agent', name: activeAgent.name, email: activeAgent.email, routingOrder: 2 })
    }
    return clients
  }, [signers, agentSigns, activeAgent])

  // MARK UP BEFORE SENDING — strike a clause out of the document on its way out.
  //
  // The bytes come from wherever the agent got the document: a file they just
  // chose, or one already on the deal. Either way what comes back is handed to
  // chooseFile(), so the marked version becomes this send's file and inherits
  // the same PDF and size checks a dragged-in file gets. sendForSignature below
  // then uploads it exactly as it would any other chosen file — which also means
  // the document that actually went out is the one filed on the deal.
  const openMarkup = async () => {
    setOpening(true)
    try {
      let name, bytes
      if (file) {
        name  = file.name
        bytes = new Uint8Array(await file.arrayBuffer())
      } else {
        name = pickedFile.replace(/^\d+-/, '')
        const { data, error } = await createDealFileSignedUrl(deal.id, pickedFile, 120)
        if (error || !data?.signedUrl) throw new Error(error?.message || 'Could not open that document.')
        const res = await fetch(data.signedUrl)
        if (!res.ok) throw new Error(`Could not read ${name} (HTTP ${res.status}).`)
        bytes = new Uint8Array(await res.arrayBuffer())
      }
      setMarkup({ fileName: name, bytes })
    } catch (e) {
      pushToast(e.message, 'error')
    } finally {
      setOpening(false)
    }
  }

  const useMarkedVersion = async (bytes, name) => {
    chooseFile(new File([bytes], safeFileName(name), { type: 'application/pdf' }))
    setMarkup(null)
    pushToast('The marked-up version will be sent, and filed on this deal.')
  }

  const sendForSignature = async () => {
    const invalid = signers.find(s => !s.name.trim() || !s.email.trim())
    if (invalid) { pushToast('All signers need a name and email', 'error'); return }
    // A malformed address is accepted by BoldSign, delivered nowhere, and looks
    // exactly like a client ignoring you. Caught before anything is uploaded.
    const badEmail = signers.find(s => !isValidEmail(s.email))
    if (badEmail) { pushToast(`"${badEmail.email}" is not a valid email address.`, 'error'); return }
    if (!file && !pickedFile) { pushToast('Select or upload a document', 'error'); return }
    setSending(true)

    // The PDF stays in storage and travels as a short-lived SIGNED URL, not as
    // base64 in the request body: a serverless request is capped at 4.5 MB and
    // base64 adds ~33%, so inline bytes silently limited every send to ~3.3 MB of
    // PDF — under the size of a normal scanned disclosure packet. A file already
    // on the deal is signed where it sits; a newly chosen one is uploaded to the
    // deal's folder first, so the exact document that went out for signature is
    // on the deal too. The API can only fetch a URL on our own bucket.
    let documentUrl, finalDocName
    try {
      let path
      if (file) {
        const up = await uploadSendableDealPdf({ file, dealId: deal.id })
        path = up.path
        finalDocName = up.name
      } else {
        path = `deal-${deal.id}/${pickedFile}`
        finalDocName = pickedFile.replace(/^\d+-/, '')
      }
      documentUrl = await signSendableDealUrl(path)
    } catch (err) {
      setSending(false)
      pushToast(err.message, 'error')
      return
    }

    const signerPayload = allSigners.map(s => ({
      name: s.name, email: s.email, routingOrder: s.routingOrder,
    }))

    let data
    try {
      // Open BoldSign's embedded prepare/send UI. If the PDF has text tags
      // baked in, BoldSign auto-places fields from them; otherwise the agent
      // places fields visually in the PreparePage before sending — we no
      // longer guess coordinates here.
      //
      // The API writes the tracking row itself, before returning this URL, so a
      // document can never reach a client without the CRM knowing about it (the
      // insert used to happen here in the browser, unchecked, and racing the
      // Sent webhook).
      data = await documentEmbedUrl({
        emailSubject: subject,
        documentUrl,
        documentName: finalDocName,
        deal_id:      deal.id,
        signers:      signerPayload,
        // A same-origin STATIC page, never the CRM's own live URL: BoldSign can
        // redirect the IFRAME itself to RedirectUrl (see BoldSignFrame's
        // handleLoad), and pointing that at window.location.href loaded the
        // whole running CRM — header, sidebar, dashboard and all — inside that
        // small iframe. public/boldsign-return.html exists exactly to be this
        // target instead; see FormLibrary.jsx's template editor for the same
        // pattern.
        redirectUrl:  boldSignReturnUrl(),
        useTextTags,
      })
    } catch (err) {
      setSending(false); pushToast(err.message, 'error'); return
    }
    setSending(false)
    if (!data.url) { pushToast('The document was created but the editor would not open — reopen it from the Signatures tab with Edit Fields.', 'error'); return }
    setEmbedDocId(data.documentId || null)
    setEmbedUrl(data.url)
  }

  // Step 2 — BoldSign's embedded prepare/send UI in-frame. A draft save leaves the
  // frame open (the agent is mid-prep); it's reopenable from the Signatures tab
  // either way, so closing this no longer loses the work.
  if (embedUrl) {
    return (
      <BoldSignStepModal
        url={embedUrl}
        documentId={embedDocId}
        eyebrow="BoldSign · Review & Send"
        heading="Place fields & send"
        onClose={onClose}
        onDone={() => { pushToast('Sent for signature', 'success'); onSent() }}
        onDraft={() => pushToast('Saved as a draft — nothing has been sent yet. You can keep working, or reopen it from the Signatures tab with "Edit Fields".', 'info')}
      />
    )
  }

  return (
    <Modal open={true} onClose={onClose} width={520}>
      <div className="modal__head">
        <div>
          <div className="eyebrow-label">BoldSign · Send for Signature</div>
          <h3 style={{ margin:0, fontFamily:'var(--font-display)', fontSize:20 }}>Set Up Signers</h3>
        </div>
        <button className="drawer__close" onClick={onClose}><Icon name="x" size={18}/></button>
      </div>
      <div className="modal__body">
        {/* Email subject */}
        <div className="form-group">
          <label className="form-label">Email Subject</label>
          <input className="form-control" value={subject} onChange={e=>setSubject(e.target.value)}/>
        </div>

        {/* Signers */}
        <div className="form-group">
          <label className="form-label required">Signers <span style={{fontSize:11,fontWeight:400,color:'var(--gw-mist)'}}>— sign in parallel (same step)</span></label>
          {/* Same picker as the template flow — an ad-hoc send has exactly the
              same problem, and a typo'd address here fails just as silently. */}
          {signers.map((s, i) => (
            <div key={s.id} style={{ display:'flex', gap:8, alignItems:'flex-start' }}>
              <div style={{ flex:1, minWidth:0 }}>
                <SignerPicker
                  order={i + 1}
                  roleLabel={i === 0 ? 'Signer' : `Signer ${i + 1}`}
                  color={SIGNER_COLORS[i] || SIGNER_COLORS[0]}
                  value={s}
                  candidates={signerCandidates}
                  onChange={(next) => setSigners(p => p.map(x => x.id === s.id ? { ...x, ...next } : x))}
                />
              </div>
              {signers.length > 1 && (
                <button className="btn btn--ghost btn--icon btn--sm" style={{ marginTop:22 }} onClick={()=>removeSigner(s.id)} aria-label="Remove signer">
                  <Icon name="x" size={13}/>
                </button>
              )}
            </div>
          ))}
          <button className="btn btn--secondary btn--sm" onClick={addSigner} style={{marginTop:2}}>+ Add another signer</button>
        </div>

        {/* Agent signs last */}
        {activeAgent && (
          <div style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 12px', border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', marginBottom:16, background:'var(--gw-bone)' }}>
            <input type="checkbox" id="agentSigns" checked={agentSigns} onChange={e=>setAgentSigns(e.target.checked)} style={{width:15,height:15,cursor:'pointer'}}/>
            <label htmlFor="agentSigns" style={{ fontSize:13, cursor:'pointer', flex:1 }}>
              <strong>I need to sign as well</strong> — {activeAgent.name} signs <em>after</em> the client{signers.length>1?'s':''}
            </label>
            {agentSigns && <div style={{ width:22, height:22, borderRadius:'50%', background:SIGNER_COLORS[signers.length]||'#6b7280', display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontSize:11, fontWeight:700 }}>{signers.length+1}</div>}
          </div>
        )}

        {/* Document */}
        <div className="form-group">
          <label className="form-label required">Document (PDF)</label>
          {dealFiles.length > 0 && (
            <div style={{ marginBottom:10 }}>
              <div style={{ fontSize:11, color:'var(--gw-mist)', marginBottom:6 }}>Pick from deal documents:</div>
              {dealFiles.map(f => {
                const name = f.name.replace(/^\d+-/,'')
                const picked = pickedFile === f.name
                return (
                  <div key={f.name} onClick={()=>{ setPickedFile(picked?'':f.name); if(!picked){setFile(null)} }}
                    style={{ display:'flex', alignItems:'center', gap:8, padding:'7px 10px', border:`1px solid ${picked?'var(--gw-azure)':'var(--gw-border)'}`, borderRadius:'var(--radius)', marginBottom:4, cursor:'pointer', background:picked?'var(--gw-sky)':'#fff' }}>
                    <Icon name="file" size={13} style={{ color:'var(--gw-mist)', flexShrink:0 }}/>
                    <span style={{ fontSize:12, flex:1, fontWeight:picked?700:400 }}>{name}</span>
                    {picked && <Icon name="check" size={13} style={{ color:'var(--gw-azure)' }}/>}
                  </div>
                )
              })}
              <div style={{ fontSize:11, color:'var(--gw-mist)', margin:'8px 0 4px' }}>— or upload a different file —</div>
            </div>
          )}
          <div style={{ border:`2px dashed ${dragOver?'var(--gw-azure)':file?'var(--gw-green)':'var(--gw-border)'}`, borderRadius:'var(--radius)', padding:'14px 16px', textAlign:'center', cursor:'pointer', background:dragOver?'var(--gw-sky)':file?'var(--gw-green-light)':'transparent', transition:'all 150ms' }}
            onClick={()=>fileRef.current.click()}
            onDragOver={e=>{e.preventDefault();setDragOver(true)}}
            onDragLeave={()=>setDragOver(false)}
            onDrop={e=>{e.preventDefault();setDragOver(false);chooseFile(e.dataTransfer.files[0])}}>
            <input ref={fileRef} type="file" accept=".pdf" style={{display:'none'}} onChange={e=>{chooseFile(e.target.files[0]); e.target.value=''}}/>
            {file
              ? <div style={{fontSize:12,fontWeight:600,color:'var(--gw-green)'}}>{file.name} <span style={{fontWeight:400,color:'var(--gw-mist)'}}>· {fmtBytes(file.size)}</span></div>
              : <><Icon name="upload" size={18} style={{color:'var(--gw-border)',marginBottom:4}}/><div style={{fontSize:12}}>Drop PDF or click to browse</div><div style={{fontSize:10,color:'var(--gw-mist)',marginTop:2}}>PDF up to {fmtBytes(MAX_SEND_BYTES)}</div></>}
          </div>
        </div>

        {/* Striking a clause happens HERE, before anyone signs — never on a
            packet already out for signature, which keeps the acknowledgement
            path (see the Signatures rows). */}
        {(file || pickedFile) && (
          <div style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 12px', border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', marginBottom:16, background:'var(--gw-bone)' }}>
            <span style={{ fontSize:12, flex:1, color:'var(--gw-mist)', lineHeight:1.45 }}>
              <strong style={{ color:'var(--gw-ink)' }}>Striking anything out?</strong> Mark the form up first —
              the line is written into the PDF the client signs.
            </span>
            <button className="btn btn--secondary btn--sm" style={{ flexShrink:0 }} onClick={openMarkup} disabled={opening || sending}>
              <Icon name="edit" size={12}/> {opening ? 'Opening…' : 'Mark up'}
            </button>
          </div>
        )}

        <div style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 12px', border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', marginBottom:16, background:'var(--gw-bone)' }}>
          <input type="checkbox" id="useTextTags" checked={useTextTags} onChange={e=>setUseTextTags(e.target.checked)} style={{width:15,height:15,cursor:'pointer'}}/>
          <label htmlFor="useTextTags" style={{ fontSize:13, cursor:'pointer', flex:1 }}>
            <strong>This PDF has BoldSign text tags</strong> — fields will be placed automatically from <code>{'{{...}}'}</code> tags in the document.
          </label>
        </div>

        {/* What happens next */}
        <div style={{ background:'var(--gw-bone)', border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', padding:'10px 12px', fontSize:12, color:'var(--gw-mist)', lineHeight:1.5 }}>
          <strong style={{ color:'var(--gw-ink)' }}>Next:</strong> BoldSign opens here in the app.
          {useTextTags
            ? ' Fields are placed from the document’s text tags — review, then click Send inside BoldSign.'
            : ' Place signature and date fields for each signer, then click Send inside BoldSign.'} The status here updates automatically as they sign.
        </div>
      </div>
      <div className="modal__foot">
        <button className="btn btn--secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn--primary" onClick={sendForSignature} disabled={sending}>
          {sending ? 'Opening…' : 'Continue in BoldSign'}
        </button>
      </div>

      {markup && (
        <MarkupDocumentModal
          fileName={markup.fileName}
          bytes={markup.bytes}
          eyebrow="Mark up before sending"
          submitLabel="Use this version"
          onClose={() => setMarkup(null)}
          onSubmit={useMarkedVersion}
        />
      )}
    </Modal>
  )
}
