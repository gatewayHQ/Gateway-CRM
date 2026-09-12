// ─────────────────────────────────────────────────────────────────────────────
// "HERE ARE THE PEOPLE I WANT THIS TO GO TO."
//
// The audience step could only build a list out of contacts already in the CRM.
// An agent with a spreadsheet of 400 owners pulled from the county had two
// options: type them in one at a time, or send from Outlook and lose every
// scan, reply and unsubscribe the CRM knows how to track.
//
// This parses what they actually have — a CSV export, or a column pasted out of
// Excel — and matches it against the contact book by email.
//
// WHAT IT REFUSES TO DO QUIETLY:
//   • It never sends to an unsubscribed address. Somebody who has opted out
//     stays opted out no matter which file their address turns up in; they are
//     COUNTED and NAMED so the agent knows the list was trimmed and why.
//   • It never invents a contact. Rows that match nobody are reported as new,
//     and creating them is a separate, deliberate act.
//   • It never guesses at a row it cannot read. A line with no email address is
//     returned in `unusable` with its line number.
//
// Pure: text in, a verdict out. No Supabase, no fetch.
// ─────────────────────────────────────────────────────────────────────────────

/** Enough of an email to send to. Deliberately permissive — the server validates. */
const EMAIL_RE = /[^\s,;<>"']+@[^\s,;<>"']+\.[a-z]{2,}/i

/** The most rows one paste will take, so a wrong file cannot hang the browser. */
export const MAX_ROWS = 5000

const clean = (v) => String(v ?? '').trim().replace(/^["']|["']$/g, '')
const normEmail = (v) => clean(v).toLowerCase()

/**
 * Split one CSV line, respecting quoted fields — "Smith, John",j@x.com is two
 * cells, not three. Tabs count as separators too, because a column pasted out
 * of Excel arrives tab-delimited.
 */
export function splitRow(line) {
  const out = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { cell += '"'; i++; continue }
      quoted = !quoted
      continue
    }
    if (!quoted && (ch === ',' || ch === '\t' || ch === ';')) { out.push(cell); cell = ''; continue }
    cell += ch
  }
  out.push(cell)
  // Trim only. The quote handling above has already done its job, and running
  // `clean` here would strip the closing quote off a cell that legitimately
  // ends in one: a doubled-quote escape came back one character short.
  return out.map(c => c.trim())
}

/** Does this line look like a header rather than a person? */
export function isHeaderRow(cells = []) {
  const joined = cells.join(' ').toLowerCase()
  return !cells.some(c => EMAIL_RE.test(c)) && /\b(e-?mail|first|last|name|company|owner|phone)\b/.test(joined)
}

/**
 * The people in a pasted or uploaded list.
 *
 * Column order is not assumed: the email is whichever cell looks like one, and
 * the name is built from the cells around it. A file whose columns are in an
 * order nobody predicted still works, which is the point — the agent did not
 * make this file.
 */
export function parseContactList(text = '') {
  const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const rows = []
  const unusable = []
  const seen = new Set()
  let truncated = false

  lines.forEach((line, i) => {
    if (rows.length >= MAX_ROWS) { truncated = true; return }
    const cells = splitRow(line)
    if (i === 0 && isHeaderRow(cells)) return

    const emailCell = cells.find(c => EMAIL_RE.test(c))
    if (!emailCell) { unusable.push({ line: i + 1, text: line.slice(0, 80) }); return }

    const email = normEmail(emailCell.match(EMAIL_RE)[0])
    if (seen.has(email)) return                    // the same address twice is one send
    seen.add(email)

    // A name, if the file carried one: the non-email cells, joined. "Smith,
    // John" in one quoted cell survives as typed.
    const name = cells.filter(c => c && c !== emailCell && !EMAIL_RE.test(c)).slice(0, 2).join(' ').trim()
    rows.push({ email, name })
  })

  return { rows, unusable, truncated }
}

/**
 * Match a parsed list against the contact book.
 *
 * Returns four buckets an agent can act on, and a `recipients` list that is
 * ALREADY safe to send to: matched contacts who are not unsubscribed, plus new
 * addresses. Nothing downstream has to remember to filter again.
 */
export function matchContactList(rows = [], contacts = []) {
  const byEmail = new Map()
  for (const c of contacts) {
    const e = normEmail(c?.email)
    if (e && !byEmail.has(e)) byEmail.set(e, c)
  }

  const matched = []
  const unsubscribed = []
  const fresh = []

  for (const row of rows) {
    const contact = byEmail.get(row.email)
    if (!contact) { fresh.push(row); continue }
    // The one rule that is not the agent's to override.
    if (contact.unsubscribed || contact.email_opt_out) { unsubscribed.push({ ...row, contact }); continue }
    matched.push({ ...row, contact })
  }

  return {
    matched,
    unsubscribed,
    fresh,
    recipients: [
      ...matched.map(m => ({ email: m.email, name: m.contact?.name || m.name, contact_id: m.contact?.id || null })),
      ...fresh.map(f => ({ email: f.email, name: f.name, contact_id: null })),
    ],
  }
}

/**
 * The sentence under the upload box. Every number an agent needs to trust the
 * list, in the order they need them — and it says out loud when addresses were
 * dropped, because a silently shorter list is how somebody gets emailed who
 * asked not to be (or doesn't get emailed who should have).
 */
export function describeMatch(fileName, parsed, match) {
  if (!parsed) return ''
  const bits = [`${parsed.rows.length} address${parsed.rows.length === 1 ? '' : 'es'}`]
  if (match) {
    bits.push(`${match.matched.length} matched a contact`)
    if (match.fresh.length) bits.push(`${match.fresh.length} new`)
    if (match.unsubscribed.length) bits.push(`${match.unsubscribed.length} unsubscribed — skipped`)
  }
  if (parsed.unusable.length) bits.push(`${parsed.unusable.length} line${parsed.unusable.length === 1 ? '' : 's'} had no email address`)
  if (parsed.truncated) bits.push(`only the first ${MAX_ROWS} rows were read`)
  return `${fileName ? `${fileName} — ` : ''}${bits.join(' · ')}`
}
