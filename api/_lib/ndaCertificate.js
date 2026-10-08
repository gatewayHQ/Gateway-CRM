/**
 * The signed copy of a Deal Room NDA.
 *
 * A click-through signature is only as good as the record of it. The record is
 * the row on mailing_om_requests (who, when, IP, browser, the SHA-256 of the
 * file); this module builds the document a person can hold: the NDA exactly as
 * the agent uploaded it, with one Electronic Signature Certificate page
 * appended that restates that record.
 *
 * Pure apart from pdf-lib: bytes in, bytes out. When the uploaded NDA cannot be
 * parsed (encrypted, damaged) the certificate is returned on its own — the
 * signature is already recorded, and a certificate naming the file's hash still
 * ties it to the exact agreement.
 */
import crypto from 'node:crypto'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { winAnsiLine } from './winAnsi.js'

export function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

/** Greedy word wrap against a font's real widths. */
function wrap(text, font, size, maxWidth) {
  const words = winAnsiLine(text).split(' ').filter(Boolean)
  const lines = []
  let line = ''
  for (const w of words) {
    const next = line ? `${line} ${w}` : w
    if (font.widthOfTextAtSize(next, size) <= maxWidth || !line) line = next
    else { lines.push(line); line = w }
  }
  if (line) lines.push(line)
  return lines
}

/**
 * @param {object} p
 * @param {Uint8Array|null} p.ndaBytes  the agreement as uploaded (null → certificate only)
 * @param {string} p.ndaSha256
 * @param {string} p.ndaFilename
 * @param {string} p.propertyName
 * @param {{ name, company, email, phone, ip, userAgent, signedAt }} p.signer
 * @returns {Promise<Uint8Array>}
 */
export async function buildSignedNda({ ndaBytes, ndaSha256, ndaFilename, propertyName, signer }) {
  let doc = null
  if (ndaBytes) {
    try { doc = await PDFDocument.load(ndaBytes, { ignoreEncryption: true }) } catch { doc = null }
  }
  if (!doc) doc = await PDFDocument.create()

  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const oblique = await doc.embedFont(StandardFonts.HelveticaOblique)
  const page = doc.addPage([612, 792])
  const left = 60, width = 612 - 120
  const ink = rgb(0.12, 0.15, 0.26), mist = rgb(0.42, 0.45, 0.5)
  let y = 720

  page.drawText('Electronic Signature Certificate', { x: left, y, size: 18, font: bold, color: ink })
  y -= 22
  for (const l of wrap(propertyName ? `Confidentiality Agreement - ${propertyName}` : 'Confidentiality Agreement', font, 11, width)) {
    page.drawText(l, { x: left, y, size: 11, font, color: mist }); y -= 15
  }
  y -= 14
  page.drawLine({ start: { x: left, y }, end: { x: left + width, y }, thickness: 0.6, color: rgb(0.85, 0.83, 0.78) })
  y -= 30

  // The signature itself, as typed.
  page.drawText(winAnsiLine(signer.name) || '-', { x: left, y, size: 22, font: oblique, color: ink })
  y -= 8
  page.drawLine({ start: { x: left, y }, end: { x: left + 300, y }, thickness: 0.8, color: ink })
  y -= 14
  page.drawText('Electronic signature (typed name)', { x: left, y, size: 9, font, color: mist })
  y -= 32

  const rows = [
    ['Signer',          signer.name],
    ['Company',         signer.company || '-'],
    ['Email',           signer.email],
    ['Phone',           signer.phone || '-'],
    ['Signed (UTC)',    new Date(signer.signedAt).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')],
    ['IP address',      signer.ip || 'not available'],
    ['Browser',         signer.userAgent || 'not available'],
    ['Agreement file',  ndaFilename],
    ['SHA-256',         ndaSha256 || 'not available'],
  ]
  for (const [k, v] of rows) {
    page.drawText(k, { x: left, y, size: 9.5, font: bold, color: ink })
    const lines = wrap(String(v ?? ''), font, 9.5, width - 110)
    lines.forEach((l, i) => page.drawText(l, { x: left + 110, y: y - i * 13, size: 9.5, font, color: ink }))
    y -= Math.max(1, lines.length) * 13 + 7
  }

  y -= 16
  const statement =
    'The signer reviewed the Confidentiality Agreement on the property\'s landing page, typed their full name as ' +
    'their electronic signature and confirmed "I have read and agree to the Confidentiality Agreement" before ' +
    'any confidential materials were released. They agreed that this electronic signature has the same effect as ' +
    'a handwritten one (U.S. ESIGN Act, 15 U.S.C. 7001 et seq., and the Uniform Electronic Transactions Act). ' +
    'The SHA-256 above identifies the exact agreement file that was presented and signed.'
  for (const l of wrap(statement, font, 9, width)) {
    page.drawText(l, { x: left, y, size: 9, font, color: mist }); y -= 12.5
  }

  return doc.save()
}
