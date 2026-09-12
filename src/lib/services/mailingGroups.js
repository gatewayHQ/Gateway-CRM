// ─────────────────────────────────────────────────────────────────────────────
// MAIL CAMPAIGNS, GROUPED BY WHERE THEY ARE.
//
// Eleven mailings in one flat list, each drawn as a wide card with a funnel
// meter, meant two screens of scrolling to answer "which of these is actually
// out there?" — and the drafts, which cannot be answered at all, sat at the
// same weight as the postcard that pulled two leads last week.
//
// Four groups, in the order an agent cares about them: what is in the mail and
// pulling scans, what is written but not sent, what is finished, and what has
// been put away. Same language as the Signatures tab, on purpose — a CRM that
// groups two lists two different ways teaches nothing.
//
// Pure: statuses in, groups out.
// ─────────────────────────────────────────────────────────────────────────────

/** The groups, in display order. `open` is whether the group starts expanded. */
export const MAILING_GROUPS = Object.freeze([
  { id: 'out',      label: 'Out in the mail', tone: 'azure', open: true,
    hint: 'Sent or active — these are the ones a QR scan can still come from.' },
  { id: 'drafts',   label: 'Drafts',          tone: 'mist',  open: true,
    hint: 'Written, not sent. Nothing can be scanned until one goes out.' },
  { id: 'archived', label: 'Archived',        tone: 'mist',  open: false, hint: null },
])

const STATUS_GROUP = {
  active: 'out',
  sent: 'out',
  draft: 'drafts',
  archived: 'archived',
}

/** Which group one mailing belongs in. An unknown status is a draft: it has never gone out. */
export function mailingGroup(mailing) {
  return STATUS_GROUP[String(mailing?.status || '').trim().toLowerCase()] || 'drafts'
}

/**
 * The list, grouped and in order. Empty groups are dropped. Order WITHIN a group
 * is the caller's — the page's own sort control decides it, and re-sorting here
 * would silently override the agent's choice.
 */
export function groupMailings(mailings = []) {
  const buckets = new Map(MAILING_GROUPS.map(g => [g.id, []]))
  for (const m of mailings) buckets.get(mailingGroup(m)).push(m)
  return MAILING_GROUPS
    .map(g => ({ ...g, mailings: buckets.get(g.id) }))
    .filter(g => g.mailings.length > 0)
}

/**
 * The line above the list. Leads first: it is the only number on this page that
 * is money, and the one an agent is deciding the next mailing on.
 */
export function mailingsSummary(mailings = []) {
  if (!mailings.length) return null
  const out    = mailings.filter(m => mailingGroup(m) === 'out')
  const mailed = mailings.reduce((n, m) => n + (Number(m?.recipient_count) || 0), 0)
  const scans  = mailings.reduce((n, m) => n + (Number(m?.scan_count) || 0), 0)
  const leads  = mailings.reduce((n, m) => n + (Number(m?.lead_count) || 0), 0)
  const bits = [`${out.length} out in the mail`]
  if (mailed) bits.push(`${mailed.toLocaleString()} pieces`)
  if (scans)  bits.push(`${scans} scan${scans === 1 ? '' : 's'}`)
  bits.push(`${leads} lead${leads === 1 ? '' : 's'}`)
  return bits.join(' · ')
}
