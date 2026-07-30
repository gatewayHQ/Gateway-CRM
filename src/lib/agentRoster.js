// ─────────────────────────────────────────────────────────────────────────────
// AGENT ROSTER — the single source of truth for "who is on this deal/property".
//
// Why this file exists: co-listing was stored in two unrelated places and read
// differently by every consumer, so a property with two agents produced a deal
// with one.
//
//   • properties.details.co_agent_ids (jsonb array)  — written by the Property
//     modal's co-agent picker. Lives in `details` because properties predate the
//     co-listing feature; it holds live production data, so it stays.
//   • deals.co_agent_ids (uuid[])                    — the deal-level roster.
//     Legacy in production, added to the repo schema by migration 0025.
//   • commissions.participants (jsonb)               — who gets PAID. Admin-only
//     data and driven by commission math, so it is deliberately NOT an input
//     here; it is a downstream consequence of the roster, not its definition.
//
// The rule this module enforces everywhere:
//
//     roster(deal) = [deal.agent_id, ...deal.co_agent_ids]      (deduped)
//
// with a read-time fallback to the linked property's co-agents for deals created
// before the carry-over fix, so historical deals display correctly without a
// backfill. Index 0 is always the PRIMARY (listing) agent.
// ─────────────────────────────────────────────────────────────────────────────

// Order-preserving de-dupe that drops null/undefined/'' ids.
const uniq = (ids) => [...new Set((ids || []).filter(Boolean))]

const asIdArray = (v) => (Array.isArray(v) ? v.filter(Boolean) : [])

/** Co-agent ids stored on a PROPERTY (details.co_agent_ids jsonb array). */
export function propertyCoAgentIds(property) {
  return asIdArray(property?.details?.co_agent_ids)
}

/** Co-agent ids stored on a DEAL (co_agent_ids uuid[]). */
export function dealCoAgentIds(deal) {
  return asIdArray(deal?.co_agent_ids)
}

/** Every agent id on a property, primary first. */
export function propertyRosterIds(property) {
  return uniq([property?.assigned_agent_id, ...propertyCoAgentIds(property)])
}

/**
 * Every agent id on a deal, primary first.
 *
 * The deal's own co_agent_ids win outright. Only when the deal carries none do
 * we fall back to the linked property — that covers deals created before this
 * fix (and before migration 0025 reached the database), so nothing silently
 * loses its second agent. Once a deal has its own roster, removing an agent
 * from the property no longer rewrites deal history.
 */
export function dealRosterIds(deal, property = null) {
  const own = dealCoAgentIds(deal)
  const co  = own.length ? own : propertyCoAgentIds(property)
  return uniq([deal?.agent_id, ...co])
}

/** True when the deal is showing property-derived co-agents rather than its own. */
export function isRosterInherited(deal, property = null) {
  return !dealCoAgentIds(deal).length && propertyCoAgentIds(property).length > 0
}

// Accepts whichever agent collection the caller already has: an array of agent
// records, a Map, or the plain id→agent object the pages build with
// Object.fromEntries. Normalized to a Map so lookups are uniform.
const toAgentMap = (agents) => {
  if (agents instanceof Map) return agents
  if (Array.isArray(agents)) return new Map(agents.filter(Boolean).map(a => [a.id, a]))
  if (agents && typeof agents === 'object') return new Map(Object.entries(agents))
  return new Map()
}

/**
 * Resolve a deal's roster to agent records, primary first, unknown ids dropped.
 * This is what every UI surface should render — card, list, deal page, packet.
 */
export function dealRoster(deal, agents = [], property = null) {
  const byId = toAgentMap(agents)
  return dealRosterIds(deal, property).map(id => byId.get(id)).filter(Boolean)
}

/** Same, for a property. */
export function propertyRoster(property, agents = []) {
  const byId = toAgentMap(agents)
  return propertyRosterIds(property).map(id => byId.get(id)).filter(Boolean)
}

/**
 * The agent columns for a deal being created from a property.
 *
 * The property's assignment is authoritative — NOT whoever happens to be logged
 * in. (The original bug: `agent_id: activeAgent?.id || form.assigned_agent_id`
 * put the acting user on the deal, so an admin or the co-agent starting the deal
 * silently displaced the listing agent.) The acting agent is only a fallback for
 * an unassigned property, and is recorded as a co-agent when they are neither
 * the primary nor already on the roster.
 */
export function dealAgentPayloadFromProperty(property, { actingAgentId = null } = {}) {
  const primary = property?.assigned_agent_id || actingAgentId || null
  const co = uniq(propertyCoAgentIds(property)).filter(id => id !== primary)
  return { agent_id: primary, co_agent_ids: co }
}

/**
 * Roster equality check used to verify a transfer actually landed, so a failed
 * carry-over surfaces instead of passing silently. Order-insensitive.
 */
export function sameRoster(a, b) {
  const A = uniq(a), B = uniq(b)
  if (A.length !== B.length) return false
  const setB = new Set(B)
  return A.every(id => setB.has(id))
}

/**
 * Human-readable summary of a roster for toasts, audit lines and packet
 * cover pages. `agents` may be records or a Map.
 */
export function rosterNames(ids, agents = []) {
  const byId = toAgentMap(agents)
  return uniq(ids).map(id => byId.get(id)?.name).filter(Boolean)
}
