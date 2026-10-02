// ─────────────────────────────────────────────────────────────────────────────
// The dashboard's "Today" card: what this agent should do before anything else.
//
//   • tasks   — their open tasks that are overdue or due today, overdue first
//   • leads   — contacts assigned to them in the last 7 days that nobody has
//               called, emailed or met yet (last_contacted_at is stamped by the
//               activities trigger, migration 0062)
//   • deals   — their open deals that need attention, from the same rules as
//               the pipeline's Focus view (overdue task, key date ≤ 7 days,
//               idle in stage), one row per deal, most urgent first
//
// Pure: the dashboard passes in what's loaded.
// ─────────────────────────────────────────────────────────────────────────────
import { focusItems } from './pipeline.js'

const DAY = 86400000
const NEW_LEAD_DAYS = 7

const endOfToday = (now) => { const d = new Date(now); d.setHours(23, 59, 59, 999); return d }

export function todayAgenda({ tasks = [], contacts = [], deals = [], agentId, now = new Date() }) {
  const eod = endOfToday(now)

  const dueTasks = tasks
    .filter(t => !t.completed && t.due_date && (!agentId || t.agent_id === agentId) && new Date(t.due_date) <= eod)
    .map(t => ({ ...t, overdue: new Date(t.due_date) < now && new Date(t.due_date).toDateString() !== now.toDateString() }))
    .sort((a, b) => new Date(a.due_date) - new Date(b.due_date))

  const leads = contacts
    .filter(c => (!agentId || c.assigned_agent_id === agentId)
      && !c.last_contacted_at
      && c.created_at && now - new Date(c.created_at) <= NEW_LEAD_DAYS * DAY)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))

  const mine = agentId
    ? deals.filter(d => d.agent_id === agentId || (Array.isArray(d.co_agent_ids) && d.co_agent_ids.includes(agentId)))
    : deals
  const seen = new Set()
  const dealItems = []
  for (const item of focusItems(mine, tasks, now)) {
    if (seen.has(item.deal.id)) continue
    seen.add(item.deal.id)
    dealItems.push(item)
  }

  return { tasks: dueTasks, leads, deals: dealItems }
}
