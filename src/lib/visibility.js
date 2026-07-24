// ─────────────────────────────────────────────────────────────────────────────
// Visibility — the single source of truth for "may this agent see this record,
// and WHY." Pure (no I/O) so it backs both the data layer and the UI: the value
// we scope a fetch on is the same value the badge renders.
//
// Rule (2026-07 — deals, contacts, properties alike):
//   OWN        record.<ownerField> === me
//   CO_AGENT   me is tagged on the record (deals: participant / co_agent_ids)
//   PARTNER    the owner is an admin-created Partner of mine (share-all)
//   NONE       none of the above — must never render in a member's view
//
// Priority OWN > CO_AGENT > PARTNER: we surface the most personal reason. See
// docs/co-agent-visibility.md.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {'own' | 'co-agent' | 'partner' | 'none'} VisibilityReason
 * @typedef {{ reason: VisibilityReason, partnerId?: string }} Visibility
 */

export const REASON = Object.freeze({
  OWN: 'own',
  CO_AGENT: 'co-agent',
  PARTNER: 'partner',
  NONE: 'none',
})

/** Per-entity field mapping so one engine serves deals, contacts, and properties. */
export const ENTITY = Object.freeze({
  deal:     { ownerField: 'agent_id',          coAgentField: 'co_agent_ids' },
  contact:  { ownerField: 'assigned_agent_id', coAgentField: 'co_agent_ids' },
  property: { ownerField: 'assigned_agent_id', coAgentField: 'co_agent_ids' },
})

export function reasonLabel(reason) {
  switch (reason) {
    case REASON.OWN:      return 'Yours'
    case REASON.CO_AGENT: return 'Co-agent'
    case REASON.PARTNER:  return 'Partner'
    default:              return 'Not visible'
  }
}

/** Membership test tolerant of Set, array, or nullish. */
function has(collection, id) {
  if (!collection || !id) return false
  if (collection instanceof Set) return collection.has(id)
  if (Array.isArray(collection)) return collection.includes(id)
  return false
}

/**
 * Why (if at all) the agent may see this record.
 *
 * @param {object} record
 * @param {object} ctx
 * @param {string} ctx.agentId
 * @param {string} [ctx.ownerField='agent_id']       Field holding the owner agent id.
 * @param {string} [ctx.coAgentField='co_agent_ids'] Field holding co-agent ids on the record.
 * @param {Set<string>|string[]} [ctx.coAgentIds]     Record ids the agent is co-tagged on (authoritative for deals).
 * @param {Set<string>|string[]} [ctx.partnerIds]     Agent ids partnered with the current agent (admin-created).
 * @returns {Visibility}
 */
export function recordVisibility(record, ctx = {}) {
  const { agentId, ownerField = 'agent_id', coAgentField = 'co_agent_ids', coAgentIds, partnerIds } = ctx
  if (!record || !agentId) return { reason: REASON.NONE }

  const owner = record[ownerField]
  if (owner === agentId) return { reason: REASON.OWN }
  if (has(coAgentIds, record.id) || has(record[coAgentField], agentId)) return { reason: REASON.CO_AGENT }
  if (has(partnerIds, owner)) return { reason: REASON.PARTNER, partnerId: owner }
  return { reason: REASON.NONE }
}

/** True when the agent may see the record in any capacity. */
export function isVisible(record, ctx) {
  return recordVisibility(record, ctx).reason !== REASON.NONE
}

/**
 * Split records into what the agent may see vs. anything that leaked through a
 * looser upstream query. The UI renders `visible` and quarantines `leaked`.
 *
 * @returns {{ visible: object[], leaked: object[], byId: Map<string, Visibility> }}
 */
export function partitionVisible(records, ctx) {
  const visible = []
  const leaked = []
  const byId = new Map()
  for (const record of records || []) {
    const v = recordVisibility(record, ctx)
    byId.set(record.id, v)
    if (v.reason === REASON.NONE) leaked.push(record)
    else visible.push(record)
  }
  return { visible, leaked, byId }
}
