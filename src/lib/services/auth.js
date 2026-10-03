// ─────────────────────────────────────────────────────────────────────────────
// Supabase Auth — the signed-in session and user, sign-in and sign-out.
//
// The session's access_token is the bearer token for every /api call, and the
// user's metadata holds per-user settings (the Resend key on Settings). Every
// screen goes through here rather than touching `supabase.auth` directly.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from '../supabase.js'

export const getAuthSession = () => supabase.auth.getSession()

export const getAuthUser = () => supabase.auth.getUser()

export const updateAuthUserMetadata = (data) => supabase.auth.updateUser({ data })

export const signInWithPassword = (credentials) => supabase.auth.signInWithPassword(credentials)

export const signOutUser = () => supabase.auth.signOut()

/** Subscribe to sign-in/out and token refreshes. Returns Supabase's `{ data: { subscription } }`. */
export const onAuthStateChange = (callback) => supabase.auth.onAuthStateChange(callback)
