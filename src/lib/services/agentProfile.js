// ─────────────────────────────────────────────────────────────────────────────
// Agent profile writes — the one client for /api/portal `profile-*`.
//
// Three screens edit the `agents` table (Team → Agent drawer, Back Office →
// Caps & Splits, and the pipeline's column-header rename). Two of them used to
// write the table directly from the browser, which is how commission splits
// went missing: `agents` carries a privilege-guard trigger that silently
// FREEZES role / is_admin / split / cap columns for any caller it doesn't
// recognize as trusted. A direct `update()` therefore returns success with the
// old values still in the row — the UI toasted "saved", the number reverted on
// the next load, and nothing anywhere reported an error.
//
// Routing every write through the authenticated endpoint fixes that twice over:
// the server is a trusted caller, and it verifies the row it gets back actually
// contains what was asked for (see api/portal.js) instead of assuming.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from '../supabase.js'
import { isTransportError } from './db.js'

const NETWORK_MSG =
  "Couldn't reach the server — check your connection and try again. If you use an ad or privacy blocker, allow this site."

async function callProfileApi(body, { attempts = 3 } = {}) {
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token || ''

  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch('/api/portal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      // A 4xx/5xx from the server is a real answer, not a flaky connection —
      // surface it immediately rather than retrying a rejected write.
      if (!res.ok || data.error) throw new Error(data.error || 'Could not save profile')
      return data
    } catch (e) {
      // Only a transport failure is worth another attempt.
      if (!isTransportError(e)) throw e
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 400 * 2 ** i))
    }
  }
  throw new Error(NETWORK_MSG)
}

// Create (admin only) or update an agent. Returns the SAVED row as the database
// actually stored it — callers should merge that into state rather than the
// values they sent, so a field the server refused can never look applied.
export async function saveAgentProfile(fields) {
  const { agent } = await callProfileApi({ action: 'profile-save', ...fields })
  return agent
}

// Persist this agent's personal pipeline column headers. `labels` is a
// { stage: 'Custom Name' } map; drop a key (or pass '') to fall back to the
// built-in label.
export async function saveStageLabels(agentId, labels) {
  return saveAgentProfile({ id: agentId, stage_labels: labels || {} })
}

export async function deleteAgentProfile(id) {
  await callProfileApi({ action: 'profile-delete', id })
}
