import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase.js'

/** The current Supabase auth session, kept live across sign-in/out and token refreshes. */
export function useAuthSession() {
  const [session, setSession] = useState(null)

  useEffect(() => {
    supabase.auth.getSession()
      .then(({ data }) => setSession(data.session ?? null))
      .catch(() => setSession(null))
    let subscription
    try {
      const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s ?? null))
      subscription = data.subscription
    } catch {
      setSession(null)
    }
    return () => subscription?.unsubscribe()
  }, [])

  return session
}

export const signOutUser = () => supabase.auth.signOut()
