import { createClient } from '@supabase/supabase-js'

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
