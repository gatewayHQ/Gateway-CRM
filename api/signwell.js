import { createClient } from '@supabase/supabase-js'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

// ─── SignWell REST API client ────────────────────────────────────────────────
// https://developers.signwell.com — auth via X-Api-Key header, base /api/v1.
const API_BASE = 'https://www.signwell.com/api/v1'
const API_KEY  = process.env.SIGNWELL_API_KEY
const TEST_MODE = process.env.SIGNWELL_TEST_MODE === 'true'

async function signwell(path, { method = 'GET', body, raw = false } = {}) {
  const r = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'X-Api-Key':    API_KEY,
      'Accept':       'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (raw) return r
  const data = await r.json().catch(() => ({}))
  if (!r.ok) {
    const msg = data?.meta?.message
              || data?.message
              || (data?.errors && JSON.stringify(data.errors))
              || `SignWell API ${r.status}`
    const err = new Error(msg)
    err.status = r.status
    err.data   = data
    throw err
  }
  return data
}

// ─── Field translation: app shape → SignWell shape ───────────────────────────
// App stores fields as { type, page, xPosition, yPosition } where coords are in
// unscaled PDF pixels (top-left origin) — the same coordinate system SignWell
// uses. SignWell's `fields` is a 2D array: one inner array per file. We always
// send a single file, so we emit one inner array.
function buildFields(signers) {
  const items = []
  signers.forEach((s, i) => {
    const recipientId = String(i + 1)
    for (const t of (s.tabs || [])) {
      const f = {
        recipient_id: recipientId,
        type:         mapFieldType(t.type),
        page:         Number(t.page) || 1,
        x:            Number(t.xPosition) || 0,
        y:            Number(t.yPosition) || 0,
        required:     t.required !== false,
      }
      if (t.tabLabel) f.label = t.tabLabel
      if (t.value != null) f.value = t.value
      if (t.api_id)  f.api_id = t.api_id
      items.push(f)
    }
  })
  return [items]   // 2D: one file
}

function mapFieldType(t) {
  switch (t) {
    case 'signature': return 'signature'
    case 'initials':  return 'initials'
    case 'date':      return 'autofill_date_signed'  // auto-fills on signing
    case 'checkbox':  return 'checkbox'
    case 'text':      return 'text'
    default:          return 'signature'
  }
}

// ─── Status normalization ────────────────────────────────────────────────────
// SignWell returns capitalized statuses (Sent / Completed / Declined / Expired
// / Voided / Draft / Created). Frontend code expects lowercase docusign-style
// values, so we normalize on every read.
function normalizeStatus(s) {
  const v = String(s || '').toLowerCase()
  if (v === 'completed' || v === 'signed') return 'completed'
  if (v === 'declined')                    return 'declined'
  if (v === 'voided'   || v === 'canceled' || v === 'cancelled') return 'voided'
  if (v === 'expired')                     return 'voided'
  if (v === 'delivered'|| v === 'viewed')  return 'delivered'
  if (v === 'sent')                        return 'sent'
  if (v === 'draft'    || v === 'created') return 'sent'
  return v || 'sent'
}

// ─── Handler ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' })

  const body = req.body || {}

  // SignWell webhook payloads do NOT carry an `action` field. Route those to
  // the webhook handler. All frontend calls include `action`.
  if (!body.action) return handleWebhook(req, res)

  // Co-hosted closing packet generator (Vercel Hobby 12-fn cap). Admin-only.
  if (body.action === 'closing-packet') return handleClosingPacket(req, res)

  if (!API_KEY) {
    return res.status(500).json({
      error: 'SignWell environment variables not configured',
      missing: { SIGNWELL_API_KEY: true },
    })
  }

  if (body.action === 'debug') {
    return res.json({
      apiBase:        API_BASE,
      apiKeyPresent:  Boolean(API_KEY),
      apiKeyPrefix:   API_KEY ? `${API_KEY.slice(0, 6)}…` : null,
      testMode:       TEST_MODE,
    })
  }

  try {
    if (body.action === 'send') {
      const { signers, documentBase64, documentName, emailSubject, draft } = body
      if (!documentBase64) return res.status(400).json({ error: 'documentBase64 required' })
      if (!signers?.length) return res.status(400).json({ error: 'At least one signer required' })

      const orderedSigners = [...signers].sort((a, b) =>
        Number(a.routingOrder || 1) - Number(b.routingOrder || 1)
      )
      const hasOrder = orderedSigners.some(s => Number(s.routingOrder || 1) !== 1)
      const isDraft  = Boolean(draft)

      const recipients = orderedSigners.map((s, i) => ({
        id:            String(i + 1),
        name:          s.name,
        email:         s.email,
        signing_order: Number(s.routingOrder || 1),
      }))

      const payload = {
        test_mode:           TEST_MODE,
        name:                documentName || 'Document',
        subject:             emailSubject || 'Please sign this document',
        draft:               isDraft,
        apply_signing_order: hasOrder,
        files: [{
          name:        documentName || 'document.pdf',
          file_base64: documentBase64,
        }],
        recipients,
        // Drafts open in SignWell's editor — fields are placed there.
        // Direct sends require fields up front.
        ...(isDraft ? {} : { fields: buildFields(orderedSigners) }),
      }

      const data = await signwell('/documents', { method: 'POST', body: payload })

      return res.json({
        envelopeId:      data.id,           // alias for app compatibility
        documentId:      data.id,
        status:          normalizeStatus(data.status),
        embeddedEditUrl: data.embedded_edit_url || null,
      })
    }

    if (body.action === 'status') {
      const id = body.envelopeId || body.documentId
      if (!id) return res.status(400).json({ error: 'documentId required' })
      const data = await signwell(`/documents/${id}`)
      const completedAt = data.completed_at || data.signed_at || null
      return res.json({
        status:            normalizeStatus(data.status),
        sentDateTime:      data.created_at || null,
        completedDateTime: completedAt,
      })
    }

    if (body.action === 'download') {
      const id = body.envelopeId || body.documentId
      if (!id) return res.status(400).json({ error: 'documentId required' })
      // Ask SignWell for a temporary URL, then fetch the bytes ourselves so we
      // can hand the caller a base64 payload — matches the old DocuSign shape.
      const meta = await signwell(`/documents/${id}/completed_pdf?url_only=true`)
      if (!meta.file_url) return res.status(400).json({ error: 'Completed PDF not available' })
      const pdfRes = await fetch(meta.file_url)
      if (!pdfRes.ok) return res.status(400).json({ error: 'Failed to download signed PDF' })
      const buffer = await pdfRes.arrayBuffer()
      return res.json({
        base64:      Buffer.from(buffer).toString('base64'),
        contentType: 'application/pdf',
      })
    }

    if (body.action === 'remind') {
      const id = body.envelopeId || body.documentId
      if (!id) return res.status(400).json({ error: 'documentId required' })
      await signwell(`/documents/${id}/remind`, { method: 'POST', body: {} })
      return res.json({ ok: true })
    }

    return res.status(400).json({ error: 'Unknown action' })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}

// ─── SignWell webhook handler ────────────────────────────────────────────────
// SignWell POSTs document lifecycle events (document_sent, document_viewed,
// document_signed, document_completed, document_declined, document_expired)
// to the registered callback URL. The payload shape varies slightly, so we
// extract id + event defensively.
//
// Register webhook (one time):
//   curl -X POST https://www.signwell.com/api/v1/hooks \
//     -H "X-Api-Key: $SIGNWELL_API_KEY" \
//     -H "Content-Type: application/json" \
//     -d '{"callback_url":"https://<your-domain>/api/signwell"}'
//
async function handleWebhook(req, res) {
  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://twgwemkihpwlgliftagg.supabase.co'
  const serviceKey   = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceKey) {
    return res.status(200).json({ received: true, error: 'Server misconfigured: set SUPABASE_SERVICE_KEY' })
  }
  const supabase = createClient(SUPABASE_URL, serviceKey)

  try {
    const body = req.body || {}

    // Defensive extraction — SignWell delivers as either { event: {type}, data: { object } }
    // or a flatter shape. We accept whichever fields are present.
    const eventName =
      body?.event?.type   ||
      body?.event_type    ||
      body?.event         ||
      ''

    const doc =
      body?.data?.object  ||
      body?.data?.document||
      body?.document      ||
      body?.data          ||
      body

    const documentId = doc?.id || body?.document_id || body?.id
    const rawStatus  = doc?.status || eventName
    if (!documentId) return res.status(200).json({ received: true, note: 'No document id' })

    const status      = normalizeStatus(rawStatus)
    const completedAt = doc?.completed_at || doc?.signed_at || null

    const { data: record } = await supabase
      .from('signwell_documents')
      .select('*, deals(id, agent_id, title)')
      .eq('document_id', documentId)
      .maybeSingle()

    if (!record) return res.status(200).json({ received: true, note: 'Document not tracked' })

    const patch = { status }
    if (completedAt) patch.completed_at = completedAt
    await supabase.from('signwell_documents').update(patch).eq('document_id', documentId)

    if (status === 'completed') {
      // Download signed PDF + stash in deal-documents storage so agents can grab
      // it without round-tripping the SignWell API.
      try {
        const meta   = await signwell(`/documents/${documentId}/completed_pdf?url_only=true`)
        if (meta.file_url) {
          const pdfRes = await fetch(meta.file_url)
          if (pdfRes.ok) {
            const pdfBuffer   = await pdfRes.arrayBuffer()
            const baseName    = (record.document_name || 'document').replace(/\.pdf$/i, '')
            const storagePath = `deal-${record.deal_id}/${Date.now()}-signed-${baseName}.pdf`
            await supabase.storage.from('deal-documents').upload(
              storagePath, Buffer.from(pdfBuffer), { contentType: 'application/pdf', upsert: false }
            )
          }
        }
      } catch (_) { /* non-fatal — status was already saved */ }

      const deal = record.deals
      if (deal?.agent_id) {
        await supabase.from('agent_notifications').insert([{
          agent_id:    deal.agent_id,
          deal_id:     record.deal_id,
          envelope_id: documentId,
          title:       'Document Signed',
          message:     `"${record.document_name || 'Document'}" for ${deal.title || 'your deal'} has been fully signed by ${record.signer_name || 'the signer'}. The signed copy has been saved to the deal's Documents tab.`,
          type:        'document_signed',
        }])
      }
    }

    return res.status(200).json({ received: true, documentId, status })
  } catch (err) {
    return res.status(200).json({ received: true, error: err.message })
  }
}

// ─── Closing packet generator (admin-only) ───────────────────────────────────
// POST /api/signwell { action: 'closing-packet', deal_id: 'uuid' }
// Merges every signed envelope and the latest version of each uploaded
// document into one PDF, stores in the closing-packets bucket, and records a
// closing_packets row + audit log entry.
async function handleClosingPacket(req, res) {
  const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://twgwemkihpwlgliftagg.supabase.co'
  const serviceKey   = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  const anonKey      = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
  if (!serviceKey) return res.status(500).json({ error: 'Server misconfigured: SUPABASE_SERVICE_KEY missing' })

  // 1. Verify the caller's JWT → resolve agent → require admin
  const jwt = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
  if (!jwt) return res.status(401).json({ error: 'Sign in required' })
  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: anonKey || serviceKey, Authorization: `Bearer ${jwt}` },
  })
  if (!userRes.ok) return res.status(401).json({ error: 'Invalid session' })
  const user = await userRes.json()
  if (!user?.id) return res.status(401).json({ error: 'Invalid session' })

  const svc = createClient(SUPABASE_URL, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: me } = await svc.from('agents').select('id, name, is_admin, role').eq('auth_id', user.id).maybeSingle()
  const isAdmin = me?.is_admin === true || (me?.role || '').toLowerCase().includes('admin')
  if (!isAdmin) return res.status(403).json({ error: 'Admin only' })

  const dealId = (req.body?.deal_id || '').trim()
  if (!/^[0-9a-f-]{36}$/i.test(dealId)) return res.status(400).json({ error: 'deal_id required' })

  // 2. Pull deal + signed envelopes + document versions
  const [{ data: deal }, { data: envelopes }, { data: versions }] = await Promise.all([
    svc.from('deals').select('id, title, value, expected_close_date, prop_category, prop_subtype').eq('id', dealId).maybeSingle(),
    svc.from('signwell_documents').select('id, document_name, signer_name, completed_at').eq('deal_id', dealId).eq('status', 'completed').order('completed_at', { ascending: true }),
    svc.from('document_versions').select('id, document_name, storage_path, version_num, pinned_as, source').eq('deal_id', dealId).order('created_at', { ascending: true }),
  ])
  if (!deal) return res.status(404).json({ error: 'Deal not found' })

  // 3. Decide what makes it in: pinned 'final' wins; otherwise the latest
  //    version per document_name. Always skip 'closing_packet' sources to
  //    prevent recursive bundling.
  const latestByName = new Map()
  for (const v of versions || []) {
    if (v.source === 'closing_packet') continue
    const cur = latestByName.get(v.document_name)
    if (!cur || v.version_num > cur.version_num) latestByName.set(v.document_name, v)
  }
  const finalPinned = (versions || []).filter(v => v.pinned_as === 'final')
  const docSet = finalPinned.length > 0 ? finalPinned : [...latestByName.values()]

  // 4. Build the merged PDF
  const merged = await PDFDocument.create()
  const font   = await merged.embedFont(StandardFonts.HelveticaBold)
  const fontR  = await merged.embedFont(StandardFonts.Helvetica)

  // Cover page
  const cover = merged.addPage([612, 792])
  cover.drawText('Closing Packet', { x: 56, y: 720, size: 28, font, color: rgb(0.18, 0.21, 0.38) })
  cover.drawText(deal.title || 'Untitled Deal', { x: 56, y: 690, size: 16, font: fontR, color: rgb(0.12, 0.15, 0.26) })
  let y = 640
  const line = (label, value) => {
    if (!value) return
    cover.drawText(label, { x: 56, y, size: 10, font, color: rgb(0.45, 0.49, 0.59) })
    cover.drawText(String(value), { x: 200, y, size: 11, font: fontR, color: rgb(0.12, 0.15, 0.26) })
    y -= 22
  }
  line('Deal value',        deal.value > 0 ? `$${Number(deal.value).toLocaleString()}` : null)
  line('Expected close',    deal.expected_close_date || null)
  line('Property type',     [deal.prop_category, deal.prop_subtype].filter(Boolean).join(' · ') || null)
  line('Generated',         new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC')
  line('Generated by',      me.name || 'Admin')
  cover.drawText('Index', { x: 56, y: y - 16, size: 12, font, color: rgb(0.18, 0.21, 0.38) })
  y -= 38
  const indexItems = [
    ...(envelopes || []).map(e => `Signed · ${e.document_name || 'Document'}${e.signer_name ? ` (${e.signer_name})` : ''}`),
    ...docSet.map(v => `${v.pinned_as === 'final' ? 'Final · ' : ''}${v.document_name}${v.version_num > 1 ? ` (v${v.version_num})` : ''}`),
  ]
  for (const item of indexItems.slice(0, 26)) {
    cover.drawText(`• ${item}`, { x: 56, y, size: 10, font: fontR, color: rgb(0.20, 0.24, 0.38), maxWidth: 500 })
    y -= 16
    if (y < 80) break
  }

  // Helper: download and append a PDF; non-PDFs get a placeholder page
  const tryAppend = async (path, label) => {
    try {
      const { data, error } = await svc.storage.from('deal-documents').download(path)
      if (error || !data) return { ok: false, reason: error?.message || 'not found' }
      const bytes = new Uint8Array(await data.arrayBuffer())
      if (!(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) {
        const p = merged.addPage([612, 792])
        p.drawText(`[Skipped non-PDF: ${label}]`, { x: 56, y: 700, size: 14, font: fontR, color: rgb(0.6, 0.3, 0.3) })
        return { ok: true, skipped: true }
      }
      const src   = await PDFDocument.load(bytes, { ignoreEncryption: true })
      const pages = await merged.copyPages(src, src.getPageIndices())
      pages.forEach(p => merged.addPage(p))
      return { ok: true }
    } catch (e) {
      return { ok: false, reason: e?.message || 'load failed' }
    }
  }

  // Pull signed PDFs from storage. The webhook stores them as
  //   deal-{id}/{epoch-ms}-signed-{base}.pdf
  // so we match strictly on that prefix to avoid grabbing an uploaded file
  // that happens to have "signed" in its name. Also dedupe against docSet
  // by storage path so the same file isn't appended twice.
  const docSetPaths = new Set(docSet.map(v => v.storage_path))
  const { data: dealFiles } = await svc.storage.from('deal-documents').list(`deal-${deal.id}`)
  const signedFiles = (dealFiles || []).filter(f => /^\d+-signed-/.test(f.name))
  let appended = 0
  const failures = []
  for (const f of signedFiles) {
    const path = `deal-${deal.id}/${f.name}`
    if (docSetPaths.has(path)) continue
    const r = await tryAppend(path, f.name)
    if (r.ok) appended++; else failures.push({ name: f.name, reason: r.reason })
  }
  for (const v of docSet) {
    const r = await tryAppend(v.storage_path, v.document_name)
    if (r.ok) appended++; else failures.push({ name: v.document_name, reason: r.reason })
  }

  if (appended === 0 && (envelopes?.length || 0) === 0) {
    return res.status(400).json({ error: 'No documents to bundle yet — upload or sign at least one document first' })
  }

  // 5. Save to storage + record the packet
  const pdfBytes    = await merged.save()
  const stamp       = new Date().toISOString().replace(/[:.]/g, '-')
  const storagePath = `deal-${deal.id}/closing-packet-${stamp}.pdf`

  const { error: upErr } = await svc.storage.from('closing-packets').upload(storagePath, Buffer.from(pdfBytes), {
    contentType: 'application/pdf', upsert: false,
  })
  if (upErr) return res.status(500).json({ error: `Storage upload failed: ${upErr.message}` })

  const docCount = appended + (envelopes?.length || 0)
  const { data: packet, error: rowErr } = await svc.from('closing_packets').insert([{
    deal_id: deal.id, storage_path: storagePath, size: pdfBytes.byteLength,
    doc_count: docCount, generated_by: me.id,
    notes: failures.length ? `Skipped: ${failures.map(f => f.name).join(', ')}` : null,
  }]).select().single()
  if (rowErr) return res.status(500).json({ error: `Packet row insert failed: ${rowErr.message}` })

  // Mirror the packet as a document_version row so it appears in the deal's
  // document list naturally.
  await svc.from('document_versions').insert([{
    deal_id: deal.id, document_name: `closing-packet-${stamp}.pdf`,
    storage_path: storagePath, size: pdfBytes.byteLength,
    mime_type: 'application/pdf', version_num: 1,
    source: 'closing_packet', uploaded_by: me.id,
  }])

  await svc.from('audit_log').insert([{
    table_name: 'closing_packets', record_id: packet.id, deal_id: deal.id,
    actor_id: me.id, action: 'packet_generated',
    new_values: { doc_count: docCount, storage_path: storagePath },
    summary: `Closing packet generated (${docCount} document${docCount === 1 ? '' : 's'})`,
  }])

  return res.json({
    ok: true,
    packet_id: packet.id,
    storage_path: storagePath,
    doc_count: docCount,
    skipped: failures.length,
    skipped_files: failures.map(f => f.name),
  })
}
