/**
 * Gateway CRM — Mass Email / Deal Announcements
 *
 * A one-time, manual send to a segment of the contact database, through the
 * agent's OWN connected Microsoft 365 mailbox. Deliberately NOT a drip: drip
 * lives in Sequences, this is "we just closed 1200 Grand — tell every
 * multifamily buyer and seller I work with".
 *
 * Four steps, in the order an agent actually thinks:
 *   1. Property + deal status  — what are we announcing?
 *   2. Message                 — template, photo, tokens, custom note, preview
 *   3. Audience                — who gets it (src/components/AudienceFilter.jsx)
 *   4. Review & send           — the numbers, then a paced, resumable send
 *
 * The send itself is chunked: the browser calls ?action=blast-send repeatedly
 * until the server reports done. That loop lives here (rather than in a
 * fire-and-forget server job) so the agent watches real progress on a send that
 * takes minutes by design — Microsoft's per-mailbox pacing, not our slowness.
 */

import React, { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { compressForUpload, IMMUTABLE_CACHE } from '../lib/imageCompress.js'
import { Icon, Badge, EmptyState, SearchDropdown, pushToast, ConfirmDialog } from '../components/UI.jsx'
import AudienceFilter from '../components/AudienceFilter.jsx'
import { BLANK_AUDIENCE, describeAudience } from '../lib/audience.js'
import { TEMPLATE_CATEGORY_LABELS } from '../lib/enums.js'
import {
  DEAL_ANNOUNCEMENT_STATUSES, DEAL_ANNOUNCEMENT_STATUS_LABELS, DEAL_ANNOUNCEMENT_STATUS_COLORS,
  ANNOUNCEMENT_TOKENS, defaultAnnouncementBody, defaultAnnouncementSubject,
  renderAnnouncementHtml, renderTokens, announcementTokens,
  propertyPhotos, defaultPhotoUrl, fullAddress, statusLabel,
} from '../lib/dealAnnouncement.js'

const STEPS = [
  { id: 1, label: 'Property' },
  { id: 2, label: 'Message'  },
  { id: 3, label: 'Audience' },
  { id: 4, label: 'Review'   },
]

const card = {
  border: '1px solid var(--gw-border)', borderRadius: 'var(--radius)',
  background: '#fff', padding: 16, marginBottom: 14,
}

async function authedPost(action, payload) {
  const { data: { session } } = await supabase.auth.getSession()
  const res = await fetch(`/api/email-send?action=${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token || ''}` },
    body: JSON.stringify(payload),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Request failed (HTTP ${res.status})`)
  return data
}

export default function MassEmail({ db, activeAgent, go, focusProperty = null, onFocusHandled }) {
  const [step, setStep] = useState(1)

  // ── Step 1 ──
  const [propertyId, setPropertyId] = useState(focusProperty || '')
  const [dealStatus, setDealStatus] = useState('closed')

  // ── Step 2 ──
  const [templateId, setTemplateId]       = useState('')
  const [subject, setSubject]             = useState(defaultAnnouncementSubject('closed'))
  const [body, setBody]                   = useState(defaultAnnouncementBody('closed'))
  const [terms, setTerms]                 = useState('')
  const [customMessage, setCustomMessage] = useState('')
  const [photoUrl, setPhotoUrl]           = useState('')
  const [photoTouched, setPhotoTouched]   = useState(false)
  const [uploading, setUploading]         = useState(false)
  const [savingTemplate, setSavingTemplate] = useState(false)

  // ── Step 3 ──
  const [audience, setAudience] = useState(BLANK_AUDIENCE)
  const [manual, setManual]     = useState({ added: [], removed: [] })
  const [resolved, setResolved] = useState({ recipients: [], skipped: [], duplicates: [] })

  // ── Step 4 ──
  const [outlook, setOutlook]   = useState(null)   // null = loading, false = not connected
  const [progress, setProgress] = useState(null)
  const [sending, setSending]   = useState(false)
  const [confirmSend, setConfirmSend] = useState(false)

  const contacts   = db?.contacts   || []
  const properties = db?.properties || []
  const templates  = (db?.templates || []).filter(t => t.category === 'deal-announcement')
  const property   = properties.find(p => p.id === propertyId) || null

  // A property handed over from the Properties page seeds step 1 once, then the
  // parent clears it — so coming back later starts blank rather than silently
  // re-announcing whatever was last opened.
  useEffect(() => {
    if (!focusProperty) return
    setPropertyId(focusProperty)
    setPhotoTouched(false)
    onFocusHandled?.()
  }, [focusProperty])   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    supabase.from('ms_graph_connection_status').select('*').maybeSingle()
      .then(({ data }) => setOutlook(data && data.status === 'connected' ? data : false))
  }, [])

  // The subject/body follow the chosen status until the agent edits them —
  // switching "Just Closed" to "Price Reduced" after typing a message must not
  // silently throw that message away.
  const [contentTouched, setContentTouched] = useState(false)
  useEffect(() => {
    if (contentTouched || templateId) return
    setSubject(defaultAnnouncementSubject(dealStatus))
    setBody(defaultAnnouncementBody(dealStatus))
  }, [dealStatus])   // eslint-disable-line react-hooks/exhaustive-deps

  // Photo defaults to the property's own first image, and keeps following the
  // property until the agent picks or uploads something for this send.
  const photos = propertyPhotos(property)
  useEffect(() => {
    if (photoTouched) return
    setPhotoUrl(defaultPhotoUrl(property) || '')
  }, [propertyId])   // eslint-disable-line react-hooks/exhaustive-deps

  const applyTemplate = (id) => {
    setTemplateId(id)
    const t = templates.find(x => x.id === id)
    if (!t) return
    setSubject(t.subject || defaultAnnouncementSubject(dealStatus))
    setBody(t.body || defaultAnnouncementBody(dealStatus))
    setContentTouched(true)
  }

  const previewHtml = useMemo(() => renderAnnouncementHtml({
    property, status: dealStatus, agent: activeAgent,
    contact: resolved.recipients[0] || { first_name: 'Pat', last_name: 'Ryan' },
    terms, customMessage, photoUrl, body,
  }), [property, dealStatus, activeAgent, resolved.recipients, terms, customMessage, photoUrl, body])

  const previewSubject = useMemo(() => renderTokens(subject, announcementTokens({
    property, status: dealStatus, agent: activeAgent,
    contact: resolved.recipients[0] || { first_name: 'Pat' }, terms, customMessage,
  })), [subject, property, dealStatus, activeAgent, resolved.recipients, terms, customMessage])

  const uploadPhoto = async (file) => {
    if (!file) return
    setUploading(true)
    try {
      const { blob, ext, type } = await compressForUpload(file, 'landing')
      const path = `announcements/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
      const { error } = await supabase.storage.from('campaign-images')
        .upload(path, blob, { contentType: type, upsert: false, cacheControl: IMMUTABLE_CACHE })
      if (error) throw error
      const { data: { publicUrl } } = supabase.storage.from('campaign-images').getPublicUrl(path)
      setPhotoUrl(publicUrl)
      setPhotoTouched(true)
      pushToast('Photo uploaded for this send')
    } catch (err) {
      pushToast(`Upload failed: ${err.message}`, 'error')
    }
    setUploading(false)
  }

  const saveAsTemplate = async () => {
    setSavingTemplate(true)
    const { error } = await supabase.from('templates').insert([{
      name:     `${statusLabel(dealStatus)} — ${property?.address || 'Announcement'}`,
      subject, body,
      category: 'deal-announcement',
      agent_id: activeAgent?.id || null,
    }])
    setSavingTemplate(false)
    if (error) { pushToast(`Could not save template: ${error.message}`, 'error'); return }
    pushToast('Saved to Email Templates')
  }

  // ── The send loop ──────────────────────────────────────────────────────────
  // Each call sends a bounded batch and reports what is left. Looping in the
  // browser keeps the agent watching a real number climb instead of a spinner,
  // and a closed tab stops the loop between batches rather than mid-message —
  // the pending rows simply stay pending and the send can be resumed.
  const startSend = async () => {
    setConfirmSend(false)
    setSending(true)
    try {
      // Resume the blast already on screen rather than creating a second one.
      // A batch that errored halfway leaves its recipient rows pending, so
      // continuing that blast finishes the send; creating a new one would mail
      // everyone who already received it a second time.
      let blastId = progress?.blastId || null
      if (!blastId) {
        const { blast } = await authedPost('blast-create', {
          propertyId: propertyId || null,
          templateId: templateId || null,
          dealStatus, subject, body, terms, customMessage,
          photoUrl: photoUrl || null,
          audience: { ...audience, manual },
          contactIds: resolved.recipients.map(c => c.id),
        })
        blastId = blast.id
        setProgress({
          blastId, status: 'sending', total: blast.recipient_count, sent: 0, failed: 0,
          skipped: blast.skipped_count, remaining: blast.recipient_count, done: false,
        })
      }

      let done = false
      let guard = 0
      while (!done && guard < 200) {
        guard++
        const p = await authedPost('blast-send', { blastId })
        setProgress({ ...p, blastId })
        done = p.done
      }
      const final = await authedPost('blast-status', { blastId })
      setProgress({ ...final, blastId })
      pushToast(final.failed > 0
        ? `Sent to ${final.sent} of ${final.total} — ${final.failed} failed`
        : `Announcement sent to ${final.sent} contact${final.sent === 1 ? '' : 's'}`,
        final.failed > 0 ? 'error' : 'success')
    } catch (err) {
      pushToast(err.message, 'error')
      setProgress(p => ({ ...(p || {}), lastError: err.message }))
    }
    setSending(false)
  }

  // ── Gates ──────────────────────────────────────────────────────────────────
  const stepReady = {
    1: Boolean(propertyId && dealStatus),
    2: Boolean(subject.trim() && body.trim()),
    3: resolved.recipients.length > 0,
    4: true,
  }

  const propertyItems = properties.map(p => ({ ...p, name: fullAddress(p) }))

  return (
    <div className="page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 6 }}>
          {STEPS.map(s => (
            <button key={s.id} type="button"
              onClick={() => { if (s.id < step || stepReady[step]) setStep(s.id) }}
              style={{
                padding: '6px 12px', borderRadius: 999, fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
                fontFamily: 'var(--font-body)',
                border: `1px solid ${step === s.id ? 'var(--gw-azure)' : 'var(--gw-border)'}`,
                background: step === s.id ? 'var(--gw-azure)' : '#fff',
                color: step === s.id ? '#fff' : step > s.id ? 'var(--gw-slate)' : 'var(--gw-mist)',
              }}>
              {s.id}. {s.label}
            </button>
          ))}
        </div>
        {outlook === false && (
          <div style={{ marginLeft: 'auto', fontSize: 12.5, color: '#b45309' }}>
            Outlook isn't connected —{' '}
            <button className="btn btn--ghost btn--sm" onClick={() => go?.('integrations')}>connect it in Integrations</button>
          </div>
        )}
      </div>

      {/* ── Step 1: property + status ── */}
      {step === 1 && (
        <>
          <div style={card}>
            <label className="form-label required">Property</label>
            <div style={{ fontSize: 12, color: 'var(--gw-mist)', marginBottom: 8 }}>
              The announcement pulls its address, asset type, unit count, price and photo from this record.
            </div>
            <SearchDropdown items={propertyItems} value={propertyId}
              onSelect={(id) => { setPropertyId(id); setPhotoTouched(false) }}
              placeholder="Search properties…" />
            {property && (
              <div style={{ marginTop: 12, display: 'flex', gap: 12, alignItems: 'center' }}>
                {defaultPhotoUrl(property) && (
                  <img src={defaultPhotoUrl(property)} alt="" style={{ width: 96, height: 72, objectFit: 'cover', borderRadius: 6 }} />
                )}
                <div style={{ fontSize: 13 }}>
                  <div style={{ fontWeight: 600 }}>{fullAddress(property)}</div>
                  <div style={{ color: 'var(--gw-mist)' }}>
                    {property.type}
                    {property.details?.total_units ? ` · ${property.details.total_units} units` : ''}
                    {property.list_price ? ` · list ${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(property.list_price)}` : ''}
                  </div>
                  {photos.length === 0 && (
                    <div style={{ color: '#b45309', fontSize: 12, marginTop: 4 }}>
                      No photos on this property — the email will send without one unless you upload it in the next step.
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          <div style={card}>
            <label className="form-label required">Deal status</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
              {DEAL_ANNOUNCEMENT_STATUSES.map(s => (
                <button key={s} type="button" onClick={() => setDealStatus(s)}
                  style={{
                    padding: '7px 14px', borderRadius: 999, fontSize: 13, fontWeight: 600, cursor: 'pointer',
                    fontFamily: 'var(--font-body)',
                    border: `1px solid ${dealStatus === s ? DEAL_ANNOUNCEMENT_STATUS_COLORS[s] : 'var(--gw-border)'}`,
                    background: dealStatus === s ? DEAL_ANNOUNCEMENT_STATUS_COLORS[s] : '#fff',
                    color: dealStatus === s ? '#fff' : 'var(--gw-slate)',
                  }}>
                  {DEAL_ANNOUNCEMENT_STATUS_LABELS[s]}
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {/* ── Step 2: message ── */}
      {step === 2 && (
        <>
          <div style={card}>
            <label className="form-label">Start from a template</label>
            <select className="form-control" value={templateId} onChange={e => applyTemplate(e.target.value)}>
              <option value="">Default {statusLabel(dealStatus)} wording</option>
              {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <div style={{ fontSize: 12, color: 'var(--gw-mist)', marginTop: 6 }}>
              Templates saved under the <strong>{TEMPLATE_CATEGORY_LABELS['deal-announcement']}</strong> category appear here.
            </div>
          </div>

          <div style={card}>
            <label className="form-label">Photo</label>
            <div style={{ fontSize: 12, color: 'var(--gw-mist)', marginBottom: 8 }}>
              Defaults to the property's first photo. Pick another, or upload one just for this send.
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
              {photos.map(url => (
                <button key={url} type="button" onClick={() => { setPhotoUrl(url); setPhotoTouched(true) }}
                  style={{
                    padding: 0, border: `2px solid ${photoUrl === url ? 'var(--gw-azure)' : 'var(--gw-border)'}`,
                    borderRadius: 6, cursor: 'pointer', background: 'none', lineHeight: 0,
                  }}>
                  <img src={url} alt="" style={{ width: 104, height: 76, objectFit: 'cover', borderRadius: 4 }} />
                </button>
              ))}
              {photoUrl && !photos.includes(photoUrl) && (
                <div style={{ position: 'relative' }}>
                  <img src={photoUrl} alt="" style={{ width: 104, height: 76, objectFit: 'cover', borderRadius: 4, border: '2px solid var(--gw-azure)' }} />
                  <span style={{ position: 'absolute', bottom: 2, left: 4, fontSize: 10, fontWeight: 700, color: '#fff', textShadow: '0 1px 2px #000' }}>THIS SEND</span>
                </div>
              )}
            </div>
            <label className="btn btn--ghost btn--sm" style={{ cursor: 'pointer' }}>
              {uploading ? 'Uploading…' : 'Upload a different photo'}
              <input type="file" accept="image/*" style={{ display: 'none' }}
                onChange={e => uploadPhoto(e.target.files?.[0])} />
            </label>
            {photoUrl && (
              <button type="button" className="btn btn--ghost btn--sm" style={{ marginLeft: 8 }}
                onClick={() => { setPhotoUrl(''); setPhotoTouched(true) }}>
                Send without a photo
              </button>
            )}
          </div>

          <div style={card}>
            <div className="form-group">
              <label className="form-label required">Subject</label>
              <input className="form-control" value={subject}
                onChange={e => { setSubject(e.target.value); setContentTouched(true) }} />
            </div>
            <div className="form-group">
              <label className="form-label">Your message</label>
              <textarea className="form-control form-control--textarea" style={{ minHeight: 80 }}
                value={customMessage} onChange={e => setCustomMessage(e.target.value)}
                placeholder="The personal note for this announcement — it renders wherever {{customMessage}} appears." />
            </div>
            <div className="form-group">
              <label className="form-label">Price / terms note</label>
              <input className="form-control" value={terms} onChange={e => setTerms(e.target.value)}
                placeholder="e.g. All cash, 30-day close · 5.8% cap" />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label required">Body</label>
              <textarea className="form-control form-control--textarea" style={{ minHeight: 180 }}
                value={body} onChange={e => { setBody(e.target.value); setContentTouched(true) }} />
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 8 }}>
                {ANNOUNCEMENT_TOKENS.map(t => (
                  <button key={t.token} type="button" title={t.label}
                    onClick={() => { setBody(b => `${b}${t.token}`); setContentTouched(true) }}
                    style={{
                      padding: '3px 8px', fontSize: 11, borderRadius: 4, cursor: 'pointer',
                      border: '1px solid var(--gw-border)', background: 'var(--gw-bone)',
                      fontFamily: 'var(--font-body)', color: 'var(--gw-slate)',
                    }}>
                    {t.token}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div style={card}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
              <label className="form-label" style={{ margin: 0, flex: 1 }}>Preview</label>
              <button className="btn btn--ghost btn--sm" onClick={saveAsTemplate} disabled={savingTemplate}>
                {savingTemplate ? 'Saving…' : 'Save as template'}
              </button>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--gw-mist)', marginBottom: 8 }}>
              Subject: <strong style={{ color: 'var(--gw-slate)' }}>{previewSubject}</strong>
            </div>
            <iframe title="Announcement preview" srcDoc={previewHtml} sandbox=""
              style={{ width: '100%', height: 460, border: '1px solid var(--gw-border)', borderRadius: 6, background: '#fff' }} />
          </div>
        </>
      )}

      {/* ── Step 3: audience ── */}
      {step === 3 && (
        <AudienceFilter
          contacts={contacts}
          audience={audience}
          manual={manual}
          onChange={setAudience}
          onManualChange={setManual}
          onResolved={setResolved}
        />
      )}

      {/* ── Step 4: review & send ── */}
      {step === 4 && (
        <>
          <div style={card}>
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
              <Stat label="Recipients" value={resolved.recipients.length} />
              <Stat label="Announcing" value={statusLabel(dealStatus)} />
              <Stat label="Property" value={property?.address || '—'} />
              <Stat label="Sending as" value={outlook?.email || activeAgent?.email || '—'} />
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--gw-mist)', marginTop: 12 }}>
              Audience: {describeAudience(audience)}
              {manual.added?.length ? ` · ${manual.added.length} added by hand` : ''}
              {manual.removed?.length ? ` · ${manual.removed.length} removed` : ''}
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--gw-mist)', marginTop: 6 }}>
              Messages go out one at a time from your own mailbox, about 30 a minute — a large send
              takes a few minutes and keeps this page open. Each contact receives their own copy;
              nobody sees the rest of the list.
            </div>
          </div>

          {progress && (
            <div style={card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                <Badge variant={progress.status === 'sent' ? 'closed' : progress.status === 'failed' ? 'cold' : 'active'}>
                  {progress.status}
                </Badge>
                <div style={{ fontSize: 13, fontWeight: 600 }}>
                  {progress.sent} sent{progress.failed > 0 ? ` · ${progress.failed} failed` : ''}
                  {progress.remaining > 0 ? ` · ${progress.remaining} to go` : ''}
                </div>
              </div>
              <div style={{ height: 8, borderRadius: 4, background: 'var(--gw-bone)', overflow: 'hidden' }}>
                <div style={{
                  height: '100%', background: 'var(--gw-azure)', transition: 'width 300ms',
                  width: `${progress.total ? Math.round(((progress.sent + progress.failed) / progress.total) * 100) : 0}%`,
                }} />
              </div>
              {progress.lastError && (
                <div style={{ fontSize: 12.5, color: '#b91c1c', marginTop: 10 }}>{progress.lastError}</div>
              )}
              {progress.done && progress.failed > 0 && (
                <div style={{ fontSize: 12.5, color: 'var(--gw-mist)', marginTop: 10 }}>
                  Failed recipients keep their error on the send record — nobody was mailed twice.
                </div>
              )}
            </div>
          )}

          {!progress?.done && (
            <button className="btn btn--primary"
              disabled={sending || !outlook || resolved.recipients.length === 0}
              onClick={() => (progress?.blastId ? startSend() : setConfirmSend(true))}>
              {sending
                ? `Sending… ${progress?.sent || 0}/${progress?.total || resolved.recipients.length}`
                : progress?.blastId
                  ? `Resume — ${progress.remaining ?? 0} left to send`
                  : `Send to ${resolved.recipients.length} contact${resolved.recipients.length === 1 ? '' : 's'}`}
            </button>
          )}
          {progress?.done && (
            <button className="btn btn--ghost" onClick={() => go?.('contacts')}>Back to Contacts</button>
          )}

          {confirmSend && (
            <ConfirmDialog
              eyebrow="Confirm Send"
              title={`Send this announcement to ${resolved.recipients.length} contact${resolved.recipients.length === 1 ? '' : 's'}?`}
              message={`Each one gets their own email from ${outlook?.email || 'your mailbox'}. This cannot be unsent.`}
              confirmLabel="Send now"
              confirmVariant="btn--primary"
              onConfirm={startSend}
              onCancel={() => setConfirmSend(false)}
            />
          )}
        </>
      )}

      {/* ── Wizard nav ── */}
      {!progress && (
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          {step > 1 && <button className="btn btn--ghost" onClick={() => setStep(s => s - 1)}>Back</button>}
          {step < 4 && (
            <button className="btn btn--primary" disabled={!stepReady[step]} onClick={() => setStep(s => s + 1)}>
              Continue
            </button>
          )}
        </div>
      )}

      {properties.length === 0 && step === 1 && (
        <EmptyState icon="building" title="No properties yet"
          message="Add a property first — a deal announcement is built from a property record." />
      )}
    </div>
  )
}

function Stat({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6, color: 'var(--gw-mist)' }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 600, marginTop: 2 }}>{value}</div>
    </div>
  )
}
