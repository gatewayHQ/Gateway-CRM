// ─────────────────────────────────────────────────────────────────────────────
// Workspace boot — everything the signed-in agent's session needs in memory.
//
// Two phases, because the second depends on the first:
//
//   1. Identity: the roster and team membership, then which agent row is the
//      signed-in user's and which teammates share what with them.
//   2. Scoped data: the book itself, filtered to what that agent may see.
//
// Pure orchestration over src/lib/services — no React, no component state —
// so the rules (who sees what, which failures are fatal) are testable with a
// stub client and the hook that drives this stays a thin state machine.
// ─────────────────────────────────────────────────────────────────────────────
import { primeCache } from '../../lib/queryCache.js'
import { fetchAllRows } from '../../lib/services/fetchAll.js'
import { fetchVisibleDeals, fetchVisibleCommissions } from '../../lib/services/deals.js'
import { fetchVisibleProperties } from '../../lib/services/properties.js'
import { fetchVisibleContacts } from '../../lib/services/contacts.js'
import { fetchAgentRoster, fetchTeamSplits, resolveSignedInAgent } from '../../lib/services/agents.js'
import { isOfficeAdmin } from '../../lib/officeAdmins.js'
import { teamVisibleAgentIds } from '../../lib/teamVisibility.js'

export const EMPTY_DB = {
  contacts: [], properties: [], deals: [], tasks: [],
  agents: [], templates: [], commissions: [], commissionsReady: true,
  activities: [], activitiesReady: true,
  dealContacts: [], propertyContacts: [],
}

export const EMPTY_VISIBILITY = { contacts: [], properties: [], deals: [] }

/**
 * Phase 1. Resolves to one of:
 *   { error }                          — the roster could not be read
 *   { agent: null, agents }            — signed in, but no profile yet
 *   { agent, agents, visibility }      — ready for phase 2
 *
 * `visibility` holds one agent-id list per shared dimension, because each has
 * its own opt-in flag on the team member row (see teamVisibility.js). Contacts
 * is not a general-purpose "people I can see" list — using it for properties
 * is what once made the Properties sharing toggle do nothing.
 */
export async function loadIdentity(supabase, user) {
  const [agentsRes, teamSplitsRes] = await Promise.all([
    fetchAgentRoster(supabase),
    fetchTeamSplits(supabase),
  ])
  if (agentsRes.error) return { error: agentsRes.error }

  const { agent, agents } = await resolveSignedInAgent(supabase, agentsRes.data || [], user)
  if (!agent) return { agent: null, agents }

  return { agent, agents, visibility: teamVisibleAgentIds(teamSplitsRes.data || [], agent.id) }
}

/**
 * Phase 2. Resolves to `{ error }` when the book itself failed to load, or
 * `{ db }` — the in-memory workspace every page reads from.
 *
 * Office admin sees EVERYTHING firm-wide (deals, contacts, properties,
 * commissions, activities, documents-by-deal) so they can oversee the whole
 * office. Tasks stay personal even for admins — a to-do list isn't oversight
 * data and the admin's own tasks are all that's useful to them. Regular agents
 * receive only rows scoped to their visibility lists. Everything pages past
 * PostgREST's 1,000-row cap (fetchAllRows).
 */
export async function loadScopedData(supabase, { agent, agents, visibility }) {
  const isAdmin = isOfficeAdmin(agent)
  const agentId = agent.id

  const [contacts, properties, deals, tasks, templates, activitiesRes, dealContactsRes, propertyContactsRes, commissionsRes] = await Promise.all([
    // Own book + team peers sharing contacts + the buyer and seller on any
    // deal this agent is on. That last arm (migration 0055) is what stops a
    // co-agent opening a deal they can see and finding no client on it.
    fetchVisibleContacts(supabase, { isAdmin, agentId, contactAgentIds: visibility.contacts }),
    // Assigned to me + team peers sharing properties + anything I co-agent
    fetchVisibleProperties(supabase, { isAdmin, agentId, propertyAgentIds: visibility.properties }),
    // Own + team-shared + co-listed (commission participant) deals
    fetchVisibleDeals(supabase, { isAdmin, agentId, dealAgentIds: visibility.deals }),
    // Tasks are personal — never shared, even for an admin
    fetchAllRows(() => supabase.from('tasks').select('*').eq('agent_id', agentId).order('due_date', { ascending: true })),
    fetchAllRows(() => supabase.from('templates').select('*').order('created_at', { ascending: false })),
    fetchAllRows(() => supabase.from('activities').select('*').order('created_at', { ascending: false })),
    // Additional-contact links (husband & wife etc. — migration 0021).
    // deal_contacts is RLS-scoped to visible deals; property_contacts is
    // open like properties. If the migration hasn't run yet these error and
    // the app degrades gracefully to single-contact behavior.
    fetchAllRows(() => supabase.from('deal_contacts').select('*')),
    fetchAllRows(() => supabase.from('property_contacts').select('*')),
    // Commissions are back-office data: only admins load raw rows. Agents
    // get their own slice via /api/portal?action=my-earnings (the database
    // enforces this too — non-admin queries return zero rows).
    isAdmin
      ? fetchVisibleCommissions(supabase, { isAdmin: true })
      : Promise.resolve({ data: [], error: null }),
  ])

  // The book itself must load. A failed read here would otherwise show as
  // an agent with no contacts or deals — indistinguishable from data loss.
  const coreError = [contacts, properties, deals, tasks].find(r => r?.error)?.error
  if (coreError) return { error: coreError }

  return {
    db: {
      contacts:         contacts.data     || [],
      properties:       properties.data   || [],
      deals:            deals.data         || [],
      tasks:            tasks.data         || [],
      agents,
      templates:        templates.data     || [],
      commissions:      commissionsRes.data || [],
      commissionsReady: !commissionsRes.error,
      activities:       activitiesRes.data || [],
      activitiesReady:  !activitiesRes.error,
      dealContacts:     dealContactsRes.data     || [],
      propertyContacts: propertyContactsRes.data || [],
    },
  }
}

/** Seed the query cache so page components skip redundant first fetches. */
export function primeWorkspaceCache(agentId, db) {
  primeCache(`contacts:${agentId}`,    db.contacts)
  primeCache(`properties:${agentId}`,  db.properties)
  primeCache(`deals:${agentId}`,       db.deals)
  primeCache(`tasks:${agentId}`,       db.tasks)
  primeCache(`templates:${agentId}`,   db.templates)
  primeCache(`activities:${agentId}`,  db.activities)
  primeCache(`agents:all`,             db.agents)
}
