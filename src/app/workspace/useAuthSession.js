import { useEffect, useState } from 'react'
import { getAuthSession, onAuthStateChange } from '../../lib/services/auth.js'

/** The current Supabase auth session, kept live across sign-in/out and token refreshes. */
export function useAuthSession() {
  const [session, setSession] = useState(null)

  useEffect(() => {
    getAuthSession()
      .then(({ data }) => setSession(data.session ?? null))
      .catch(() => setSession(null))
    let subscription
    try {
      const { data } = onAuthStateChange((_e, s) => setSession(s ?? null))
      subscription = data.subscription
    } catch {
      setSession(null)
    }
    return () => subscription?.unsubscribe()
  }, [])

  return session
}

