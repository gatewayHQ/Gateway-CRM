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
 * Reading is a UNION of both records, not a fallback to one of them. It used to
 * be a fallback — the property was consulted only when the deal's own column
 * was EMPTY — and that is what hid the bug this module caused for months:
 *
 *   create property → start deal → THEN add the second agent to the listing
 *
 * writes the new agent to the property and nowhere else, because an existing
 * deal never re-seeds (Pipeline.jsx: `deal?.id ? [] : …`). The deal's column
 * was non-empty, so the fallback never fired, so the team card showed one name
 * — while RLS, reading the same stale column, hid the deal and every document
 * on it from an agent everyone believed was on the deal.
 *
 * Migration 0055 makes the database derive access from BOTH records. These
 * helpers read them the same way, so what the card shows and what the agent can
 * open are the same list, and neither depends on a copy being up to date.
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
 * Every co-agent on a deal, for display and for seeding commission splits: the
 * deal's own column UNIONED with the linked property's list (pass the property
 * in when you have it). Never includes the deal's primary agent.
 *
 * The union — rather than "the deal's column, or the property's if that is
 * empty" — is what keeps this in step with `app_visible_deal_ids()`, which
 * grants on either record. A fallback disagreed with the grant the moment a
 * deal carried one co-agent and its listing carried two.
 */
export function dealCoAgentIds(deal, property = null) {
  const own = Array.isArray(deal?.co_agent_ids) ? deal.co_agent_ids.filter(Boolean) : []
  return uniqueIds([...own, ...propertyCoAgentIds(property)], deal?.agent_id)
}

/**
 * Primary agent first, then co-agents — the canonical ordering used by the
 * "Agents on deal" card, the pipeline cards, and the signer prefill.
 *
 * The linked property's ASSIGNED agent is on this list too. They hold the
 * listing, so migration 0055 grants them the deal whoever started it; leaving
 * them off the card would put the UI back out of step with the database, in the
 * one direction nobody thinks to check — the deal a colleague started on your
 * own listing.
 *
 * NOT named `dealAgentIds`: that is already an unrelated PROP threaded through
 * App.jsx → PipelinePage / CommissionPage (the array of agent ids a user may
 * see deals for). Importing this under that name shadowed the prop inside
 * PipelinePage and crashed the board with "not a function".
 */
export function agentIdsOnDeal(deal, property = null) {
  return uniqueIds([
    deal?.agent_id,
    ...dealCoAgentIds(deal, property),
    property?.assigned_agent_id,
  ])
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
