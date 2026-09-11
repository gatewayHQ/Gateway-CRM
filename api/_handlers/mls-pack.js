// ─────────────────────────────────────────────────────────────────────────────
// MLS packager — co-hosted under /api/boldsign (Vercel function cap), the same
// way the closing-packet generator is.
//
// WHY IT IS OURS AND NOT BOLDSIGN'S. Three things BoldSign will not do, all of
// them load-bearing for an MLS upload:
//
//   • it will not split pages out of a single signed combined PDF;
//   • it will not merge two already-completed envelopes into a new envelope;
//   • it will not restripe or re-file a signed document.
//
// So once a packet completes, everything MLS needs is assembled here, from the
// files already archived on the deal, with pdf-lib and a zip writer. NOTHING in
// this file calls BoldSign, and nothing it produces is ever pushed back into a
// BoldSign document id — a locally merged PDF is a new artifact filed on the
// deal, never a mutation of the signed record.
//
// The two modes are genuinely different requests, not a formatting preference:
//   ZIP   — one file per form, which is what a board that wants "one form per
//           upload" needs, and the only shape a per-form upload can take.
//   MERGE — one PDF in an order the agent chose, for a board that wants the
//           whole file as a single document, optionally behind a cover sheet.
// ─────────────────────────────────────────────────────────────────────────────
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { requireAgent, errorResponse, getServiceClient, getUserClient } from '../_lib/auth.js'
import { zip } from '../_lib/zip.js'
import {
  packableFiles, orderSelection, correctionPair, validateMlsPack, mlsPackName, applyPreset,
} from '../../src/lib/services/signaturePackets.js'

const DEAL_BUCKET = 'deal-documents'
const isUuid = (s) => /^[0-9a-f-]{36}$/i.test(s || '')

export default async function mlsPackHandler(req, res) {
  let actor
  try { actor = await requireAgent(req) } catch (e) { return errorResponse(res, e) }

  const dealId = String(req.body?.deal_id || req.body?.dealId || '').trim()
  if (!isUuid(dealId)) return res.status(400).json({ error: 'deal_id required' })

  const svc = getServiceClient()

  try {
    // AUTHORIZATION IS THE CALLER'S, NOT THE SERVICE KEY'S. Everything below
    // reads deal documents, so the very first question is whether this agent can
    // see this deal at all — asked by making the read WITH THEIR CREDENTIALS and
    // letting RLS answer. The service key would happily return another agent's
    // listing packet, and "the deal id was in the request body" is not an
    // authorization check.
    const { data: visible } = await getUserClient(req)
      .from('deals').select('id').eq('id', dealId).maybeSingle()
    if (!visible && !actor.isAdmin) {
      return res.status(403).json({ error: 'You do not have access to this deal.' })
    }

    // The packet rows, with everything the manifest needs. A database without
    // migration 0046 has no manifest at all, and the honest answer there is a
    // sentence naming the migration — not an empty checklist that reads as
    // "this deal has no signed forms".
    const { data: rows, error } = await svc
      .from('boldsign_documents')
      .select('id, document_id, document_name, status, completed_at, local_files, correction_of_document_id, mls_number, download_option, mode')
      .eq('deal_id', dealId)
      .order('completed_at', { ascending: true })
    if (error) {
      const missing = error.code === '42703' || error.code === 'PGRST204' || /local_files/.test(error.message || '')
      return res.status(missing ? 501 : 500).json({
        error: missing
          ? 'MLS packaging is not set up on this database yet — the packet columns are missing. Ask your admin to run migrations/0046_signature_packets.sql in Supabase.'
          : `Could not read this deal's packets: ${error.message}`,
      })
    }

    const available = packableFiles(rows || [])

    // LIST — what can be packed. The checklist's data, and the answer to "why is
    // this form not here?" without the agent having to guess.
    if (req.body?.mode === 'list' || !req.body?.mode) {
      return res.json({
        files: available,
        // A completed packet with nothing packable is the one case worth
        // explaining: its signed PDF has not been archived yet (the webhook is
        // still working, or it never arrived), and pressing Download Signed PDF
        // on the row heals it.
        unarchived: (rows || [])
          .filter(r => r.status === 'completed' && !available.some(f => f.documentId === r.document_id))
          .map(r => ({ documentId: r.document_id, documentName: r.document_name })),
      })
    }

    const mode = String(req.body.mode || '').trim()
    if (!['zip', 'merge'].includes(mode)) {
      return res.status(400).json({ error: 'mode must be "zip", "merge" or "list".' })
    }

    // Three ways to say which files: an explicit list, a preset, or a
    // correction pair. They resolve to the same thing — a selection — so the
    // packing code below has one input, not three.
    let selected
    if (req.body.correctionOf) {
      selected = correctionPair(available, String(req.body.correctionOf))
      if (!selected.length) {
        return res.status(400).json({ error: 'That packet has no archived files to pack yet.' })
      }
    } else if (req.body.preset) {
      selected = applyPreset(available, String(req.body.preset))
      if (!selected.length) {
        return res.status(400).json({
          error: `No completed forms on this deal match the "${req.body.preset}" preset. Tick the forms you want instead.`,
        })
      }
    } else {
      const wanted = new Set((Array.isArray(req.body.fileIds) ? req.body.fileIds : []).map(String))
      selected = available.filter(f => wanted.has(f.id))
      // A file id that names nothing is the agent's checklist being out of date
      // with the deal — surfaced rather than silently dropped, because a pack
      // that quietly omits a form is the worst failure this feature has.
      const missing = [...wanted].filter(id => !available.some(f => f.id === id))
      if (missing.length) {
        return res.status(409).json({
          error: `${missing.length} selected file${missing.length === 1 ? ' is' : 's are'} no longer on this deal. Refresh and choose again.`,
          missing,
        })
      }
    }

    const ordered = orderSelection(selected, req.body.order)
    const refusal = validateMlsPack({ mode, files: ordered })
    if (refusal) return res.status(400).json({ error: refusal })

    // Fetch every selected object. Read with the SERVICE key, which is correct
    // here and only here: the caller's access to the deal was established above,
    // and these are archive paths this app wrote itself — not paths the caller
    // named. (A caller-named path would have to be read as the caller; see
    // resolveDocumentBytes in api/boldsign.js.)
    const fetched = []
    const unreadable = []
    for (const f of ordered) {
      const { data, error: dlErr } = await svc.storage.from(DEAL_BUCKET).download(f.path)
      if (dlErr || !data) { unreadable.push({ name: f.form_name, reason: dlErr?.message || 'not found' }); continue }
      const bytes = Buffer.from(await data.arrayBuffer())
      if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
        unreadable.push({ name: f.form_name, reason: 'not a PDF' }); continue
      }
      fetched.push({ ...f, bytes })
    }
    // Nothing partial. An MLS packet that is quietly missing a disclosure is
    // worse than no packet: the agent uploads it, the board accepts it, and the
    // gap surfaces at closing.
    if (unreadable.length) {
      return res.status(502).json({
        error: `${unreadable.length} of the selected forms could not be read, so nothing was packed: ${unreadable.map(u => `${u.name} (${u.reason})`).join(', ')}.`,
        unreadable,
      })
    }

    const mlsNumber = (rows || []).find(r => r.mls_number)?.mls_number || null
    const address   = String(req.body.address || '').trim() || null
    const filename  = mlsPackName({ mode, mlsNumber, address, count: fetched.length })

    let bytes
    if (mode === 'zip') {
      bytes = await zip(fetched.map(f => ({ name: `${f.form_name}.pdf`, bytes: f.bytes })))
    } else {
      bytes = await mergeForMls(fetched, {
        cover: req.body.coverSheet ? { address, mlsNumber, dealId, agent: actor.agent } : null,
      })
    }

    // Filed under `mls/`, a prefix the Documents tab does not list — the same
    // reasoning as `print/`: a packed upload is a derived convenience copy, not
    // a filing, and one per attempt would bury the deal's real paperwork. It IS
    // recorded on the packet manifest (kind: 'mls_bundle') so the deal can say
    // what was handed to MLS and when.
    const path = `deal-${dealId}/mls/${Date.now()}-${filename}`
    const { error: upErr } = await svc.storage.from(DEAL_BUCKET).upload(path, bytes, {
      contentType: mode === 'zip' ? 'application/zip' : 'application/pdf', upsert: false,
    })
    if (upErr) return res.status(500).json({ error: `Could not build the MLS pack: ${upErr.message}` })

    const { data: signed, error: signErr } = await svc.storage.from(DEAL_BUCKET)
      .createSignedUrl(path, 300, { download: filename })
    if (signErr || !signed?.signedUrl) {
      return res.status(500).json({ error: `Built the pack but could not create a download link${signErr?.message ? `: ${signErr.message}` : ''}` })
    }

    // Record it against the packet the selection leads with, so "what did we
    // send MLS?" has an answer on the deal rather than in someone's downloads
    // folder. Best-effort: the file exists and is downloadable either way.
    await recordBundle(svc, { rows, lead: fetched[0], path, filename, mode })

    await svc.from('audit_log').insert([{
      table_name: 'boldsign_documents', deal_id: dealId, actor_id: actor.agent.id,
      action: 'mls_pack',
      new_values: { mode, filename, path, forms: fetched.map(f => f.form_name) },
      summary: `Packed ${fetched.length} signed form${fetched.length === 1 ? '' : 's'} for MLS (${mode === 'zip' ? 'separate files' : 'merged PDF'})`,
    }]).then(() => {}, () => {})

    return res.json({
      ok: true, url: signed.signedUrl, filename, path, mode,
      count: fetched.length,
      forms: fetched.map(f => f.form_name),
    })
  } catch (e) {
    return errorResponse(res, e)
  }
}

/**
 * Concatenate the selected PDFs in the given order, optionally behind a cover
 * sheet. pdf-lib, locally, page for page — the order is the agent's and is not
 * re-sorted here, because "amendments after the purchase agreement" is a filing
 * requirement, not a display preference.
 */
async function mergeForMls(files, { cover } = {}) {
  const out  = await PDFDocument.create()
  const bold = await out.embedFont(StandardFonts.HelveticaBold)
  const reg  = await out.embedFont(StandardFonts.Helvetica)

  if (cover) drawCover(out, bold, reg, { ...cover, files })

  for (const f of files) {
    const src   = await PDFDocument.load(f.bytes, { ignoreEncryption: true })
    const pages = await out.copyPages(src, src.getPageIndices())
    for (const p of pages) out.addPage(p)
  }
  return Buffer.from(await out.save({ useObjectStreams: true }))
}

function drawCover(doc, bold, reg, { address, mlsNumber, agent, files }) {
  const page = doc.addPage([612, 792])
  const ink  = rgb(0.12, 0.15, 0.26)
  const mist = rgb(0.45, 0.49, 0.59)

  page.drawText('Signature Packet', { x: 56, y: 720, size: 26, font: bold, color: rgb(0.18, 0.21, 0.38) })
  if (address) page.drawText(address, { x: 56, y: 692, size: 14, font: reg, color: ink, maxWidth: 500 })

  let y = 650
  const line = (label, value) => {
    if (!value) return
    page.drawText(label, { x: 56, y, size: 10, font: bold, color: mist })
    page.drawText(String(value), { x: 190, y, size: 11, font: reg, color: ink, maxWidth: 366 })
    y -= 22
  }
  line('MLS number', mlsNumber)
  line('Prepared',   new Date().toISOString().slice(0, 10))
  line('Prepared by', agent?.name || agent?.email || null)
  line('Forms',      `${files.length}`)

  page.drawText('Contents', { x: 56, y: y - 14, size: 12, font: bold, color: rgb(0.18, 0.21, 0.38) })
  y -= 36
  // Numbered, because the order is the point of a merged pack — a board reading
  // it should be able to check that nothing is missing without paging through.
  let running = 1
  for (const f of files) {
    if (y < 70) break
    const pages = f.pages ? `  (${f.pages} page${f.pages === 1 ? '' : 's'})` : ''
    page.drawText(`${running}.  ${f.form_name}${pages}`, {
      x: 56, y, size: 10, font: reg, color: rgb(0.20, 0.24, 0.38), maxWidth: 500,
    })
    y -= 16
    running++
  }
  // Says what this document is, so nobody mistakes a locally-assembled upload
  // copy for the signed original — they are different artifacts and only one of
  // them carries the audit trail.
  page.drawText(
    'Assembled from the signed PDFs on this deal for MLS upload. The signed originals and their audit trails remain on the deal.',
    { x: 56, y: 48, size: 8, font: reg, color: mist, maxWidth: 500, lineHeight: 11 },
  )
}

/**
 * Add the bundle to its packet's manifest. Best-effort and non-fatal: the file
 * is already built, uploaded and linked by the time this runs.
 */
async function recordBundle(svc, { rows, lead, path, filename, mode }) {
  try {
    const row = (rows || []).find(r => r.document_id === lead?.documentId)
    if (!row) return
    const { normalizeLocalFiles, upsertLocalFile } = await import('../../src/lib/services/signaturePackets.js')
    const manifest = upsertLocalFile(normalizeLocalFiles(row.local_files), {
      kind: 'mls_bundle', path, form_name: `${filename} (${mode === 'zip' ? 'separate files' : 'merged'})`,
    })
    await svc.from('boldsign_documents').update({ local_files: manifest }).eq('id', row.id)
  } catch (e) {
    console.warn(`[boldsign] could not record the MLS bundle on the packet: ${e.message}`)
  }
}
