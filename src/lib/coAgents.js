/**
 * Gateway CRM — Co-agents
 *
 * A co-agent is an agent who shares the commission on a listing without owning
 * the record. They are picked on the PROPERTY (Co-Agents section →
 * `properties.details.co_agent_ids`) and, from 2026-08, carried onto the DEAL
 * when the property is converted (`deals.co_agent_ids`, migration 0025).
 *
 * Before that carry-over existed, converting a property to a deal silently
 * dropped the co-agents: the deal page's "Agents on deal" card and the
 * commission editor only ever saw the assigned agent, so a co-listing agent had
 * to be re-added by hand (and, if nobody noticed, was never paid).
 *
 * Reading is deliberately forgiving. `dealCoAgentIds` falls back to the linked
 * property for deals converted BEFORE this shipped, so historical pipelines
 * render their real team without a data backfill.
 *
 * The primary/assigned agent is never a co-agent — every helper here strips
 * `deal.agent_id` / the property's assigned agent out, so the two roles can't
 * double up on one deal.
 */

const uniqueIds = (ids, exclude) => {
  const skip = new Set((Array.isArray(exclude) ? exclude : [exclude]).filter(Boolean))
  const out = []
  for (const id of ids) {
    if (!id || skip.has(id) || out.includes(id)) continue
    out.push(id)
  }
  return out
}

/** Co-agents selected on a property, as stored in its `details` blob. */
export function propertyCoAgentIds(property) {
  const ids = property?.details?.co_agent_ids
  return Array.isArray(ids) ? ids.filter(Boolean) : []
}

/**
 * The co-agent list to stamp on a deal being created from `property`.
 * `primaryAgentId` is whoever the deal is assigned to — they own the deal, so
 * they are removed from the co-agent list even if they were also ticked as a
 * co-agent on the property.
 */
export function coAgentIdsForNewDeal(property, primaryAgentId) {
  return uniqueIds(propertyCoAgentIds(property), primaryAgentId)
}

/**
 * Every co-agent on a deal, for display and for seeding commission splits.
 * Prefers the deal's own column; falls back to the linked property (pass it in
 * when you have it) so deals converted before migration 0025 still show their
 * team. Never includes the deal's primary agent.
 */
export function dealCoAgentIds(deal, property = null) {
  const own = Array.isArray(deal?.co_agent_ids) ? deal.co_agent_ids.filter(Boolean) : []
  const ids = own.length ? own : propertyCoAgentIds(property)
  return uniqueIds(ids, deal?.agent_id)
}

/**
 * Primary agent first, then co-agents — the canonical ordering used by the
 * "Agents on deal" card, the pipeline cards, and the signer prefill.
 *
 * NOT named `dealAgentIds`: that is already an unrelated PROP threaded through
 * App.jsx → PipelinePage / CommissionPage (the array of agent ids a user may
 * see deals for). Importing this under that name shadowed the prop inside
 * PipelinePage and crashed the board with "not a function".
 */
export function agentIdsOnDeal(deal, property = null) {
  return uniqueIds([deal?.agent_id, ...dealCoAgentIds(deal, property)])
}

/**
 * True when a write failed only because `deals.co_agent_ids` isn't there yet
 * (migration 0025 not applied). Callers retry without the column so creating a
 * deal is never blocked by a pending migration — same degrade-and-continue
 * pattern the commission columns use in migration 0024.
 */
export function isMissingCoAgentColumn(error) {
  return /co_agent_ids/.test(error?.message || '')
}
