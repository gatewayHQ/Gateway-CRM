// ─────────────────────────────────────────────────────────────────────────────
// BoldSign admin reads — the sender-identity table behind Settings → BoldSign.
// Identity writes (create / sync / resend / update / delete) go through the
// BoldSign API in boldsign.js.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from '../supabase.js'

export const fetchSenderIdentities = () =>
  supabase.from('boldsign_sender_identities').select('*')
