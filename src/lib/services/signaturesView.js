// ─────────────────────────────────────────────────────────────────────────────
// WHAT THE SIGNATURES TAB SHOWS, AND IN WHAT ORDER.
//
// The tab used to render every packet at the same volume: a recalled envelope
// from last week sat in the same weight of card as the one a client is holding
// up today, each carrying nine controls and stating its own status three times.
// An agent opening the tab had to read it one card at a time to answer the only
// question they came with — "is any of this mine to do right now?"
//
// This module answers that question before a row is read, by putting every
// packet in one of four groups and saying, in a sentence above them, how many
// need the agent and how late the worst one is.
//
// IT IS PURE ON PURPOSE. Grouping is a judgement the screen makes on the
// agent's behalf, and a judgement made in JSX cannot be tested. Everything here
// takes a row (or rows) and returns a verdict; the component decides only how
// to draw it. The status vocabulary itself is signaturePackets.js's, not a
// second copy of it.
// ─────────────────────────────────────────────────────────────────────────────
import { isInFlight, canSendCorrection } from './signaturePackets.js'

/** The stored status, trimmed — the same reading signaturePackets.js takes. */
const status = (row) => String(row?.status ?? '').trim()

/**
 * How long a packet can sit with a signer before it stops being "out for
 * signature" and becomes something the agent has to chase.
 *
 * A week, because that is when an agent starts apologising for it. It is the
 * ONE number that decides whether a live packet is filed under "needs you", so
 * it lives here with its reason rather than inline in a comparison.
 */
export const OVERDUE_DAYS = 7

/**
 * The four groups, in the order they appear. Order is the message: what needs
 * the agent is first, what is merely in motion second, and the two kinds of
 * finished — dead and done — last, collapsed.
 */
export const GROUPS = Object.freeze([
  {
    id: 'needs_you',
    label: 'Needs you',
    tone: 'amber',
    open: true,
    empty: null,               // an empty "needs you" is good news; say nothing
  },
  {
    id: 'out',
    label: 'Out for signature',
    tone: 'azure',
    open: true,
    empty: null,
  },
  {
    id: 'stalled',
    label: 'Recalled & declined',
    tone: 'mist',
    open: false,               // nothing here can be worked on; it is reference
    empty: null,
  },
  {
    id: 'signed',
    label: 'Signed',
    tone: 'green',
    open: false,               // the old "hide completed" filter, made structural
    empty: null,
  },
])

/** Days since a packet went out, or null for one that never did. */
export function daysOut(row, now = Date.now()) {
  const sent = row?.sent_at || row?.created_at
  if (!sent) return null
  const ms = now - new Date(sent).getTime()
  if (!Number.isFinite(ms)) return null
  return Math.max(0, Math.floor(ms / 86_400_000))
}

/**
 * Which group a packet belongs in.
 *
 *   needs_you — a draft (nobody has been asked yet), a packet BoldSign has
 *               flagged, or one that has been out longer than OVERDUE_DAYS.
 *   out       — with signers, moving, not yet late.
 *   signed    — completed.
 *   stalled   — recalled, declined, expired: nothing to chase, but the deal
 *               still needs the document, so it stays findable.
 *
 * A packet lands in exactly one group. Where two could be argued — a recalled
 * packet DOES need the agent to send a correction — the quieter one wins: the
 * tab's first group is a list of things to do today, and padding it with work
 * that has no deadline is how a triage list stops being read.
 */
export function packetGroup(row, now = Date.now()) {
  const state = status(row)
  if (state === 'completed') return 'signed'
  if (state === 'draft')     return 'needs_you'
  if (state === 'needs_attention') return 'needs_you'
  if (isInFlight(row)) {
    const days = daysOut(row, now)
    return days != null && days >= OVERDUE_DAYS ? 'needs_you' : 'out'
  }
  return 'stalled'
}

/**
 * The packets, grouped and ordered. Empty groups are dropped — a header over
 * nothing is a row of furniture — so the caller renders exactly what it gets.
 *
 * Within a group, newest first, which is the order the tab already loads in and
 * the order an agent thinks in ("the one I sent Tuesday").
 */
export function groupPackets(rows = [], now = Date.now()) {
  const byId = new Map(GROUPS.map(g => [g.id, []]))
  for (const row of rows) {
    const id = packetGroup(row, now)
    ;(byId.get(id) || byId.get('stalled')).push(row)
  }
  const when = (r) => new Date(r?.sent_at || r?.created_at || 0).getTime()
  return GROUPS
    .map(g => ({ ...g, packets: (byId.get(g.id) || []).slice().sort((a, b) => when(b) - when(a)) }))
    .filter(g => g.packets.length > 0)
}

/**
 * The sentence above the list. Returns null when there is nothing worth saying
 * — a tab with nothing outstanding should not manufacture a status line to
 * prove it is working.
 */
export function summaryLine(rows = [], now = Date.now()) {
  const needs = rows.filter(r => packetGroup(r, now) === 'needs_you')
  if (!needs.length) {
    const out = rows.filter(r => packetGroup(r, now) === 'out')
    if (!out.length) return null
    return `${out.length} document${out.length === 1 ? '' : 's'} out for signature — nothing needs you right now.`
  }
  const waits = needs.map(r => (isInFlight(r) ? daysOut(r, now) : null)).filter(d => d != null)
  const worst = waits.length ? Math.max(...waits) : null
  const head  = `${needs.length} document${needs.length === 1 ? '' : 's'} need${needs.length === 1 ? 's' : ''} you`
  return worst != null && worst >= OVERDUE_DAYS
    ? `${head}. The oldest has been out ${worst} days.`
    : `${head}.`
}

/**
 * The one action that moves this packet forward — the button that stays on the
 * row while everything else goes behind the ⋯ menu.
 *
 * Returns { id, label } or null. `id` is what the component switches on; the
 * label is the words on the button, chosen to say what will happen rather than
 * to name the feature ("Send correction", not "Correction packet").
 *
 * A packet BoldSign has flagged does NOT get Remind: the recipient cannot open
 * the link or their address bounced, and emailing them again teaches a client
 * to ignore the next one. It gets Fix packet, which is the thing that helps.
 */
export function nextStep(row) {
  const state = status(row)
  if (state === 'draft')     return { id: 'send',     label: 'Send' }
  if (state === 'completed') return { id: 'download', label: 'Download' }
  if (state === 'needs_attention') return { id: 'fix', label: 'Fix packet' }
  if (['sent', 'delivered'].includes(state)) return { id: 'remind', label: 'Remind' }
  if (canSendCorrection(row)) return { id: 'correction', label: 'Send correction' }
  return null
}

/**
 * Whether the status word still earns its chip. The colour rail down the left
 * of every row already carries the state; the word is only added where it says
 * something the colour cannot ("Recalled" is not merely "grey").
 */
export function showsStatusChip(row) {
  return !['sent', 'delivered'].includes(status(row))
}
