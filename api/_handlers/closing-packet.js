// ─────────────────────────────────────────────────────────────────────────────
// Closing packet handler — co-hosted under /api/boldsign (Vercel Hobby cap).
//
// The packet generator's only relation to BoldSign is that it bundles BoldSign-
// signed PDFs alongside other uploaded documents. Keeping it in its own module
// makes boldsign.js focused on the e-sign integration and lets this handler
// evolve (templating, branding, additional sources) without touching that file.
// ─────────────────────────────────────────────────────────────────────────────
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { requireAdmin, errorResponse } from '../_lib/auth.js'

const DEAL_BUCKET   = 'deal-documents'
const PACKET_BUCKET = 'closing-packets'

const isUuid = (s) => /^[0-9a-f-]{36}$/i.test(s || '')

export default async function closingPacketHandler(req, res) {
  let admin
  try { admin = await requireAdmin(req) } catch (e) { return errorResponse(res, e) }
  const { agent: me, svc } = admin

  const dealId = (req.body?.deal_id || '').trim()
  if (!isUuid(dealId)) return res.status(400).json({ error: 'deal_id required' })

  try {
    const { data: deal } = await svc
      .from('deals')
      .select('id, title, value, expected_close_date, prop_category, prop_subtype')
      .eq('id', dealId).maybeSingle()
    if (!deal) return res.status(404).json({ error: 'Deal not found' })

    const [{ data: envelopes }, { data: versions }] = await Promise.all([
      svc.from('boldsign_documents')
        .select('id, document_name, signer_name, completed_at')
        .eq('deal_id', dealId).eq('status', 'completed')
        .order('completed_at', { ascending: true }),
      svc.from('document_versions')
        .select('id, document_name, storage_path, version_num, pinned_as, source')
        .eq('deal_id', dealId)
        .order('created_at', { ascending: true }),
    ])

    // Pick the doc set: pinned 'final' wins, else latest version per name.
    // Always exclude packets themselves to avoid recursive bundling.
    const latestByName = new Map()
    for (const v of versions || []) {
      if (v.source === 'closing_packet') continue
      const cur = latestByName.get(v.document_name)
      if (!cur || v.version_num > cur.version_num) latestByName.set(v.document_name, v)
    }
    const finalPinned = (versions || []).filter(v => v.pinned_as === 'final')
    const docSet = finalPinned.length > 0 ? finalPinned : [...latestByName.values()]

    const merged = await PDFDocument.create()
    const font   = await merged.embedFont(StandardFonts.HelveticaBold)
    const fontR  = await merged.embedFont(StandardFonts.Helvetica)

    drawCoverPage(merged, font, fontR, { deal, me, envelopes: envelopes || [], docSet })

    const tryAppend = async (path, label) => {
      try {
        const { data, error } = await svc.storage.from(DEAL_BUCKET).download(path)
        if (error || !data) return { ok: false, reason: error?.message || 'not found' }
        const bytes = new Uint8Array(await data.arrayBuffer())
        // PDF magic bytes (%PDF)
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

    // Webhook stores signed PDFs at deal-{id}/{epoch-ms}-signed-{base}.pdf
    const docSetPaths = new Set(docSet.map(v => v.storage_path))
    const { data: dealFiles } = await svc.storage.from(DEAL_BUCKET).list(`deal-${deal.id}`)
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

    const pdfBytes    = await merged.save()
    const stamp       = new Date().toISOString().replace(/[:.]/g, '-')
    const storagePath = `deal-${deal.id}/closing-packet-${stamp}.pdf`

    const { error: upErr } = await svc.storage.from(PACKET_BUCKET).upload(storagePath, Buffer.from(pdfBytes), {
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

    // Mirror as document_version so it appears in the deal's docs list naturally
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
  } catch (e) {
    return errorResponse(res, e)
  }
}

function drawCoverPage(merged, font, fontR, { deal, me, envelopes, docSet }) {
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
  line('Deal value',     deal.value > 0 ? `$${Number(deal.value).toLocaleString()}` : null)
  line('Expected close', deal.expected_close_date || null)
  line('Property type',  [deal.prop_category, deal.prop_subtype].filter(Boolean).join(' · ') || null)
  line('Generated',      new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC')
  line('Generated by',   me.name || 'Admin')

  cover.drawText('Index', { x: 56, y: y - 16, size: 12, font, color: rgb(0.18, 0.21, 0.38) })
  y -= 38
  const indexItems = [
    ...envelopes.map(e => `Signed · ${e.document_name || 'Document'}${e.signer_name ? ` (${e.signer_name})` : ''}`),
    ...docSet.map(v => `${v.pinned_as === 'final' ? 'Final · ' : ''}${v.document_name}${v.version_num > 1 ? ` (v${v.version_num})` : ''}`),
  ]
  for (const item of indexItems.slice(0, 26)) {
    cover.drawText(`• ${item}`, { x: 56, y, size: 10, font: fontR, color: rgb(0.20, 0.24, 0.38), maxWidth: 500 })
    y -= 16
    if (y < 80) break
  }
}
