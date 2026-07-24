import { useMemo } from 'react'
import { REL, dealRelationship, partitionTaggedDeals } from '../../lib/dealVisibility.js'

/** View filters exposed by the Team Deals screen. */
export const VIEW = Object.freeze({
  ALL: 'all',
  PRIMARY: 'primary',
  CO_AGENT: 'co-agent',
})

const MATCHES = {
  [VIEW.ALL]:      () => true,
  [VIEW.PRIMARY]:  rel => rel === REL.PRIMARY || rel === REL.BOTH,
  [VIEW.CO_AGENT]: rel => rel === REL.CO_AGENT || rel === REL.BOTH,
}

/**
 * Derive the current agent's deal view from already-loaded app state. Pure and
 * memoised: recomputes only when its inputs change (e.g. a mid-session refresh
 * or an agent switch), which is what makes permission changes reflect without a
 * full reload.
 *
 * @param {object}   args
 * @param {object[]} args.deals            Deals in scope (already co-agent-scoped for members).
 * @param {string[]} [args.coAgentDealIds] Deal ids the agent is co-tagged on (from the data layer).
 * @param {object[]} [args.commissions]    Commission rows if present (admins) — augments co-agent detection.
 * @param {string}   [args.agentId]        The active agent's id.
 * @param {string}   [args.view]           One of VIEW.* — filters the returned `deals`.
 */
export default function useTaggedDeals({ deals, coAgentDealIds, commissions, agentId, view = VIEW.ALL }) {
  const ctx = useMemo(
    () => ({ agentId, coAgentDealIds: new Set(coAgentDealIds || []), commissions }),
    [agentId, coAgentDealIds, commissions],
  )

  const { tagged, leaked, byId } = useMemo(
    () => partitionTaggedDeals(deals || [], ctx),
    [deals, ctx],
  )

  const counts = useMemo(() => {
    let primary = 0, coAgent = 0, both = 0
    for (const rel of byId.values()) {
      if (rel === REL.PRIMARY) primary++
      else if (rel === REL.CO_AGENT) coAgent++
      else if (rel === REL.BOTH) both++
    }
    return { total: tagged.length, primary, coAgent, both }
  }, [byId, tagged.length])

  const match = MATCHES[view] || MATCHES[VIEW.ALL]
  const visible = useMemo(
    () => tagged.filter(d => match(byId.get(d.id))),
    [tagged, byId, match],
  )

  const relationshipOf = useMemo(
    () => (deal) => byId.get(deal?.id) ?? dealRelationship(deal, ctx),
    [byId, ctx],
  )

  return { deals: visible, allTagged: tagged, leaked, counts, relationshipOf }
}
