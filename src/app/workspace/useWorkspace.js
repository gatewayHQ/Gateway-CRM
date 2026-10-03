// ─────────────────────────────────────────────────────────────────────────────
// The signed-in agent's workspace as React state: boot status, identity,
// per-dimension visibility, and the in-memory `db` every page reads.
//
// The loading rules themselves live in loadWorkspace.js; this hook only drives
// them and holds the result.
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase.js'
import {
  EMPTY_DB, EMPTY_VISIBILITY, loadIdentity, loadScopedData, primeWorkspaceCache,
} from './loadWorkspace.js'

export function useWorkspace(session) {
  const [db, setDb] = useState(EMPTY_DB)
  const [loading, setLoading] = useState(true)
  const [activeAgentId, setActiveAgentId] = useState(null)
  const [visibility, setVisibility] = useState(EMPTY_VISIBILITY)
  const [needsOnboarding, setNeedsOnboarding] = useState(false)
  // A boot that couldn't reach the database. Shown as a retry screen — never
  // as onboarding (which is what a failed agents read used to look like) or as
  // an empty book (which is what a failed contacts read looked like).
  const [bootError, setBootError] = useState(null)
  const [bootAttempt, setBootAttempt] = useState(0)

  // The whole database is refetched when the SIGNED-IN USER changes — not whenever a
  // new session OBJECT arrives.
  //
  // Supabase refreshes the access token on its own schedule, and notably when a
  // backgrounded tab is brought back to the front. Each refresh fires
  // onAuthStateChange with a fresh session object, and while the dependency here was
  // `session` that object identity alone re-ran this loader and called setDb with
  // newly-built arrays. Nothing had changed, but every component keyed on those
  // arrays behaved as though it had — which is how switching browser tabs used to
  // slam the deal drawer back to its Details tab and take an open BoldSign editor
  // down with it (see the comment on DealDrawer's seeding effect).
  //
  // Keyed on the user id, a token refresh is now what it should be: invisible.
  const sessionUserId = session?.user?.id || null

  useEffect(() => {
    if (!session) return
    const fail = (error) => { setBootError(error); setLoading(false) }

    const load = async () => {
      const identity = await loadIdentity(supabase, session.user)
      if (identity.error) return fail(identity.error)
      if (!identity.agent) {
        setNeedsOnboarding(true)
        setLoading(false)
        return
      }

      setActiveAgentId(identity.agent.id)
      setVisibility(identity.visibility)

      const scoped = await loadScopedData(supabase, identity)
      if (scoped.error) return fail(scoped.error)
      setBootError(null)
      setDb(scoped.db)
      primeWorkspaceCache(identity.agent.id, scoped.db)
      setLoading(false)
    }
    load().catch(fail)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on WHO is signed
    // in, deliberately not on the session object; see the comment above.
  }, [sessionUserId, bootAttempt])

  return {
    db, setDb, loading, bootError, needsOnboarding,
    activeAgentId, setActiveAgentId, visibility,

    retry: () => { setBootError(null); setLoading(true); setBootAttempt(n => n + 1) },

    // Signed out: drop everything so the next sign-in boots from scratch.
    reset: () => {
      setDb(EMPTY_DB)
      setNeedsOnboarding(false)
      setBootError(null)
      setLoading(true)
    },

    completeOnboarding: (agent) => {
      setDb(p => ({ ...p, agents: [...p.agents, agent] }))
      setActiveAgentId(agent.id)
      setNeedsOnboarding(false)
    },
  }
}
