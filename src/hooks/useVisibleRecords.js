import { useMemo } from 'react'
import { REASON, ENTITY, recordVisibility, partitionVisible } from '../lib/visibility.js'

/** View filters shared by every "records I can see" screen. */
export const VIEW = Object.freeze({
  ALL: 'all',
  OWN: 'own',
  CO_AGENT: 'co-agent',
  PARTNER: 'partner',
})

const MATCHES = {
  [VIEW.ALL]:      () => true,
  [VIEW.OWN]:      r => r === REASON.OWN,
  [VIEW.CO_AGENT]: r => r === REASON.CO_AGENT,
  [VIEW.PARTNER]:  r => r === REASON.PARTNER,
}

/**
 * Derive an agent's visible-record view (deals / contacts / properties) from
 * already-loaded state. Pure + memoised, so a Partner link added or removed
 * mid-session — or an agent switch — re-derives without a reload.
 *
 * @param {object} args
 * @param {object[]} args.records
 * @param {'deal'|'contact'|'property'} [args.entity='deal']  Selects owner/co-agent field mapping.
 * @param {string}   args.agentId
 * @param {Set<string>|string[]} [args.coAgentIds]  Record ids the agent is co-tagged on (deals).
 * @param {Set<string>|string[]} [args.partnerIds]  Agent ids partnered with the agent.
 * @param {string}   [args.view=VIEW.ALL]
 */
export default function useVisibleRecords({ records, entity = 'deal', agentId, coAgentIds, partnerIds, view = VIEW.ALL }) {
  const ctx = useMemo(() => ({
    agentId,
    ...(ENTITY[entity] || ENTITY.deal),
    coAgentIds: new Set(coAgentIds || []),
    partnerIds: new Set(partnerIds || []),
  }), [agentId, entity, coAgentIds, partnerIds])

  const { visible, leaked, byId } = useMemo(
    () => partitionVisible(records || [], ctx),
    [records, ctx],
  )

  const counts = useMemo(() => {
    let own = 0, coAgent = 0, partner = 0
    for (const v of byId.values()) {
      if (v.reason === REASON.OWN) own++
      else if (v.reason === REASON.CO_AGENT) coAgent++
      else if (v.reason === REASON.PARTNER) partner++
    }
    return { total: visible.length, own, coAgent, partner }
  }, [byId, visible.length])

  const match = MATCHES[view] || MATCHES[VIEW.ALL]
  const shown = useMemo(
    () => visible.filter(r => match(byId.get(r.id)?.reason)),
    [visible, byId, match],
  )

  const visibilityOf = useMemo(
    () => (record) => byId.get(record?.id) ?? recordVisibility(record, ctx),
    [byId, ctx],
  )

  return { records: shown, allVisible: visible, leaked, counts, visibilityOf }
}
