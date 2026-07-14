// ─────────────────────────────────────────────────────────────────────────────
// Pipeline intelligence — pure helpers shared by the Board, List, and Focus
// views (Milestone 1b redesign). Everything here is deterministic and unit
// tested; the page components stay thin.
//
// Design goals drawn from the competitive study:
//   • Pipedrive's activity dot — every deal answers "is a next step scheduled?"
//   • Pipedrive's rotting flag — deals idle in a stage past a threshold surface
//   • A Focus view none of the competitors put on the pipeline: "what needs
//     attention today" across every stage at once.
// ─────────────────────────────────────────────────────────────────────────────
import { isOpenStage } from './stages.js'

const DAY = 86_400_000
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x }
export const daysBetween = (a, b) => Math.round((startOfDay(a) - startOfDay(b)) / DAY)

// Expected value of a deal = value × probability. Falls back to raw value when
// no probability is set (so a deal never reads as $0 just for lacking a %).
export function weightedValue(deal) {
  const v = Number(deal?.value) || 0
  const p = deal?.probability == null || deal.probability === '' ? null : Number(deal.probability)
  if (p == null || Number.isNaN(p)) return v
  return Math.round(v * (p / 100))
}

// When the deal last entered its current stage. We stamp comp_data.stage_since
// on every stage move (no schema change — comp_data is jsonb). Legacy deals
// without it fall back to updated_at, then created_at — so "days in stage"
// degrades gracefully to "days since last touched" for old rows.
export function stageSince(deal) {
  return deal?.comp_data?.stage_since || deal?.updated_at || deal?.created_at || null
}
export function daysInStage(deal, now = new Date()) {
  const s = stageSince(deal)
  return s ? Math.max(0, daysBetween(now, s)) : null
}

// How long a deal may sit in a stage before it's "rotting". Early/active stages
// expect frequent motion; legal/closing stages (PSA, DD, under-contract) legitimately
// sit longer. Closed/lost never rot.
export const ROTTING_THRESHOLDS = {
  lead: 14, qualified: 14, showing: 10, offer: 7, 'under-contract': 30,
  pursuit: 21, 'om-marketing': 21, 'listing-agreement': 14, 'on-market': 30,
  loi: 10, psa: 30, 'due-diligence': 21, 'pre-list': 14, active: 30,
}
const DEFAULT_ROT = 21

export function rotThreshold(stage) {
  return ROTTING_THRESHOLDS[stage] ?? DEFAULT_ROT
}
export function isRotting(deal, now = new Date()) {
  if (!isOpenStage(deal?.stage)) return false
  const d = daysInStage(deal, now)
  return d != null && d >= rotThreshold(deal.stage)
}

// Pipedrive-style activity signal from a deal's OPEN tasks:
//   'overdue'   → a task is past due           (red)
//   'scheduled' → a future task exists          (green)
//   'none'      → nothing planned               (grey) — the nudge to act
export function dealActivityState(deal, tasks = [], now = new Date()) {
  const open = tasks.filter(t => t.deal_id === deal.id && !t.completed)
  if (!open.length) return { state: 'none', color: 'var(--gw-mist)', nextTask: null, overdueBy: null }
  let overdue = null, soonest = null
  for (const t of open) {
    if (!t.due_date) continue
    const due = new Date(t.due_date)
    if (due < now) { if (!overdue || due < new Date(overdue.due_date)) overdue = t }
    else if (!soonest || due < new Date(soonest.due_date)) soonest = t
  }
  if (overdue) return { state: 'overdue', color: '#dc2626', nextTask: overdue, overdueBy: daysBetween(now, overdue.due_date) }
  if (soonest) return { state: 'scheduled', color: 'var(--gw-green)', nextTask: soonest, overdueBy: null }
  // open tasks exist but none dated → treat as planned-but-unscheduled
  return { state: 'scheduled', color: 'var(--gw-green)', nextTask: open[0], overdueBy: null }
}

// Nearest upcoming/overdue key date from comp_data.key_dates.
export function nextKeyDate(deal, now = new Date()) {
  const dates = (deal?.comp_data?.key_dates || []).filter(k => k?.date && k?.type)
  if (!dates.length) return null
  const withDays = dates.map(k => ({ type: k.type, date: k.date, daysUntil: daysBetween(k.date, now) }))
  const upcoming = withDays.filter(k => k.daysUntil >= 0).sort((a, b) => a.daysUntil - b.daysUntil)
  return upcoming[0] || null
}

// ── Focus view: "what needs attention today" across every open deal ──────────
// Produces one item per (deal, reason). severity: 'critical' | 'warning'.
const SEV_RANK = { critical: 0, warning: 1 }

export function focusItems(deals = [], tasks = [], now = new Date()) {
  const items = []
  for (const deal of deals) {
    if (!isOpenStage(deal.stage)) continue

    // 1) Overdue tasks (one item per overdue task, capped)
    const overdueTasks = tasks
      .filter(t => t.deal_id === deal.id && !t.completed && t.due_date && new Date(t.due_date) < now)
      .sort((a, b) => new Date(a.due_date) - new Date(b.due_date))
    for (const t of overdueTasks.slice(0, 3)) {
      const by = daysBetween(now, t.due_date)
      items.push({ deal, kind: 'task', severity: 'critical', sortDays: -by, daysBy: by, label: `Task overdue ${by}d`, detail: t.title })
    }

    // 2) Key date within 7 days (or already passed but stage still open)
    const kd = nextKeyDate(deal, now)
    if (kd && kd.daysUntil <= 7) {
      const sev = kd.daysUntil <= 2 ? 'critical' : 'warning'
      const label = kd.daysUntil === 0 ? `${kd.type} today` : kd.daysUntil === 1 ? `${kd.type} tomorrow` : `${kd.type} in ${kd.daysUntil}d`
      items.push({ deal, kind: 'date', severity: sev, sortDays: kd.daysUntil, daysBy: kd.daysUntil, label, detail: kd.type })
    }

    // 3) Rotting (no recent motion) — only if not already flagged by a task/date
    if (isRotting(deal, now)) {
      const d = daysInStage(deal, now)
      items.push({ deal, kind: 'rotting', severity: 'warning', sortDays: 1000 + d, daysBy: d, label: `Idle ${d}d in stage`, detail: deal.stage })
    }
  }
  return items.sort((a, b) =>
    (SEV_RANK[a.severity] - SEV_RANK[b.severity]) || (a.sortDays - b.sortDays)
  )
}

// A "buyer lead" is a deal that was created as just a person — no property
// attached AND the title is simply the linked contact's name (e.g. "Sky Olson").
// These are house-hunting prospects that clog the transaction pipeline; the
// board offers a per-agent toggle to hide them. Deliberately NARROW: a deal with
// a linked property, or an address-titled deal like "123 Main Street" (title
// doesn't equal the contact's name), is NOT a buyer lead and always shows.
export function isBuyerLead(deal, contact) {
  if (!deal || deal.property_id) return false
  if (!contact) return false
  const name = `${contact.first_name || ''} ${contact.last_name || ''}`.trim().toLowerCase()
  return name.length > 0 && (deal.title || '').trim().toLowerCase() === name
}

// Board/summary rollup: count, raw $, and weighted $ for a set of deals.
export function pipelineTotals(deals = []) {
  return deals.reduce((acc, d) => {
    acc.count += 1
    acc.value += Number(d.value) || 0
    acc.weighted += weightedValue(d)
    return acc
  }, { count: 0, value: 0, weighted: 0 })
}
