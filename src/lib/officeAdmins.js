// ─────────────────────────────────────────────────────────────────────────────
// Who owns the office-admin switch.
//
// `agents.is_admin` is firm-wide X-ray: every agent's deals, documents,
// signatures, commissions and contacts. Exactly two accounts are trusted to
// turn that on and off — Erin (the broker) and Daniel (who builds this system).
// Everyone else must never see the checkbox, and the API refuses the column for
// them even if the request is hand-rolled (api/portal.js).
//
// To change who holds the switch, edit OFFICE_ADMIN_ACCOUNTS. A two-name list
// is the whole mechanism on purpose: a roles table for two people would be more
// moving parts to get wrong, and this file is imported by both the browser and
// the API so the UI and the server can never disagree about the answer.
//
// Note what this does NOT do: it does not revoke anyone. An agent who already
// carries is_admin keeps their access — the restriction is on the switch, not
// on the flag.
// ─────────────────────────────────────────────────────────────────────────────

const norm = (v) => String(v ?? '').trim().toLowerCase()

export const OFFICE_ADMIN_ACCOUNTS = [
  'erin@gatewayreadvisors.com',    // Erin — broker
  'daniel@gatewayreadvisors.com',  // Daniel — builds/maintains the CRM
].map(norm)

/**
 * May this account hold — and toggle — the office-admin flag?
 * Accepts an agent row or a bare email.
 */
export function canHoldOfficeAdmin(agentOrEmail) {
  const email = norm(typeof agentOrEmail === 'string' ? agentOrEmail : agentOrEmail?.email)
  return !!email && OFFICE_ADMIN_ACCOUNTS.includes(email)
}

/**
 * Is this agent currently an office admin (sees the whole firm)?
 *
 * The explicit `is_admin` flag (migration 0005) wins; the free-text role is a
 * fallback for profiles that predate the column. For the two accounts that own
 * the switch the flag is the ONLY answer — otherwise a role reading "Broker /
 * Admin" would quietly keep firm-wide visibility after they toggled themselves
 * off, and the switch they can see would do nothing.
 */
export function isOfficeAdmin(agent) {
  if (!agent) return false
  if (agent.is_admin === true) return true
  if (canHoldOfficeAdmin(agent)) return false
  return (agent.role || '').toLowerCase().includes('admin')
}
