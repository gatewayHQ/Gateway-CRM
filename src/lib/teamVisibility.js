// ─────────────────────────────────────────────────────────────────────────────
// Which agents' rows a given agent may see, per shared dimension.
//
// A team member row carries three independent opt-ins — share_contacts,
// share_properties, share_deals — and each answers for exactly the thing it
// names. Reading one flag for another dimension is not a small bug: properties
// were scoped by the CONTACTS list, so unchecking "Properties" for a teammate
// changed nothing while "Contacts" stayed on, and the peer kept seeing every
// property. Deriving all three in one place, from one rule, is what keeps that
// from drifting back.
//
// A null/absent flag counts as SHARED — that is the column default and the
// behavior of a database that predates the columns.
//
// The database enforces the same split for contacts and deals
// (app_visible_agent_ids(dimension) in schema.sql). It does NOT for properties:
// that table is `allow_all_authenticated`, so for properties this list is the
// entire scoping story client-side.
// ─────────────────────────────────────────────────────────────────────────────

const FLAGS = {
  contacts:   'share_contacts',
  properties: 'share_properties',
  deals:      'share_deals',
}

/**
 * @param splits  every team_splits row (agent_id, team_id, share_* flags)
 * @param agentId the signed-in agent
 * @returns { contacts, properties, deals } — each `[agentId, ...sharing peers]`,
 *          de-duplicated. Always includes the agent themselves, so a caller can
 *          use the list directly in an `.in()` filter.
 */
export function teamVisibleAgentIds(splits, agentId) {
  const rows = Array.isArray(splits) ? splits : []
  const myTeamIds = new Set(rows.filter(r => r.agent_id === agentId).map(r => r.team_id))
  const peers = rows.filter(r => myTeamIds.has(r.team_id) && r.agent_id !== agentId)

  const forDimension = (dimension) => [...new Set([
    agentId,
    ...peers.filter(r => r[FLAGS[dimension]] !== false).map(r => r.agent_id),
  ])].filter(Boolean)

  return {
    contacts:   forDimension('contacts'),
    properties: forDimension('properties'),
    deals:      forDimension('deals'),
  }
}
