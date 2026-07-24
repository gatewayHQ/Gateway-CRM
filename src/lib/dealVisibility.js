// ─────────────────────────────────────────────────────────────────────────────
// Co-agent deal visibility — the single source of truth for "which deals is
// this agent allowed to see, and why."
//
// Product rule (2026-07, supersedes team-wide pipeline sharing):
//   A team member sees a deal ONLY when they are personally on it —
//   either the PRIMARY agent (deals.agent_id) or a tagged CO-AGENT
//   (commissions.participants[].agent_id, or the legacy deals.co_agent_ids[]).
//   Being on the same team as the deal's owner is NOT sufficient.
//   Admins (office admin / transaction coordinator) still see the whole firm.
//
// This module is PURE (no I/O) so it can back both the data layer
// (src/lib/services/deals.js) and the UI (useTaggedDeals / DealCard). The number
// the fetch layer scopes on is the exact same relationship the badge renders.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {'primary' | 'co-agent' | 'primary+co-agent' | 'none'} DealRelationship
 */

/** How the current agent relates to a deal. */
export const REL = Object.freeze({
  /** Owns the deal (deals.agent_id). */
  PRIMARY: 'primary',
  /** Tagged as a co-agent (participant or legacy co_agent_ids). */
  CO_AGENT: 'co-agent',
  /** Both the owner and separately tagged as a co-agent. */
  BOTH: 'primary+co-agent',
  /** Not on the deal — must never appear in a member's view. */
  NONE: 'none',
})

/** Short, human-readable label for a relationship. */
export function relationshipLabel(rel) {
  switch (rel) {
    case REL.PRIMARY:  return 'Primary agent'
    case REL.CO_AGENT: return 'Co-agent'
    case REL.BOTH:     return 'Primary + co-agent'
    default:           return 'Not tagged'
  }
}

/** Accepts a Set, an array, or nullish and answers membership without throwing. */
function has(collection, id) {
  if (!collection || !id) return false
  if (collection instanceof Set) return collection.has(id)
  if (Array.isArray(collection)) return collection.includes(id)
  return false
}

/**
 * Does `agentId` appear as a participant on this deal's commission?
 * Commissions are admin-only data, so this branch only contributes when the
 * caller actually has the rows (admins); for non-admins the co-agent signal
 * arrives pre-computed via `coAgentDealIds` instead.
 */
function isCommissionParticipant(commissions, dealId, agentId) {
  if (!Array.isArray(commissions) || !dealId || !agentId) return false
  return commissions.some(c =>
    c?.deal_id === dealId &&
    Array.isArray(c?.participants) &&
    c.participants.some(p => p?.agent_id === agentId))
}

/**
 * Classify how an agent relates to one deal.
 *
 * @param {object} deal                      A deal row (needs `id`, `agent_id`; may have `co_agent_ids`).
 * @param {object} ctx
 * @param {string} ctx.agentId               The current agent's id.
 * @param {Set<string>|string[]} [ctx.coAgentDealIds]  Deal ids the agent is co-tagged on
 *                                           (from the data layer — the authoritative signal for non-admins).
 * @param {object[]} [ctx.commissions]       Commission rows, when available (admins) — augments co-agent detection.
 * @returns {DealRelationship}
 */
export function dealRelationship(deal, { agentId, coAgentDealIds, commissions } = {}) {
  if (!deal || !agentId) return REL.NONE

  const isPrimary = deal.agent_id === agentId
  const isCoAgent =
    has(coAgentDealIds, deal.id) ||
    has(deal.co_agent_ids, agentId) ||
    isCommissionParticipant(commissions, deal.id, agentId)

  if (isPrimary && isCoAgent) return REL.BOTH
  if (isPrimary)  return REL.PRIMARY
  if (isCoAgent)  return REL.CO_AGENT
  return REL.NONE
}

/** True when the agent is on the deal in any capacity (primary or co-agent). */
export function isTaggedOn(deal, ctx) {
  return dealRelationship(deal, ctx) !== REL.NONE
}

/**
 * Split a deal list into what the agent is allowed to see and anything that
 * leaked through a looser upstream query. The UI renders `tagged` and can
 * quarantine `leaked` instead of silently showing another member's deal.
 *
 * @param {object[]} deals
 * @param {object} ctx  Same shape as {@link dealRelationship}'s ctx.
 * @returns {{ tagged: object[], leaked: object[], byId: Map<string, DealRelationship> }}
 */
export function partitionTaggedDeals(deals, ctx) {
  const tagged = []
  const leaked = []
  const byId = new Map()
  for (const deal of deals || []) {
    const rel = dealRelationship(deal, ctx)
    byId.set(deal.id, rel)
    if (rel === REL.NONE) leaked.push(deal)
    else tagged.push(deal)
  }
  return { tagged, leaked, byId }
}
