// ─────────────────────────────────────────────────────────────────────────────
// SMS inbox — `conversations` and `messages`, plus their realtime feeds.
//
// Outbound sends go through /api/twilio-send (server-side); this module is the
// read side the Messages page needs. Realtime subscriptions return an
// unsubscribe function for use as a useEffect cleanup.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from '../supabase.js'

// ── conversations ────────────────────────────────────────────────────────────

export const fetchConversations = () =>
  supabase
    .from('conversations')
    .select('*')
    .order('last_message_at', { ascending: false })

export const markConversationRead = (convId) =>
  supabase.from('conversations').update({ unread_count: 0 }).eq('id', convId)

// Any change to any conversation row calls onEvent(payload).
export function subscribeToConversations(onEvent) {
  const ch = supabase.channel('gw-convs')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'conversations' }, onEvent)
    .subscribe()
  return () => supabase.removeChannel(ch)
}

// ── messages ─────────────────────────────────────────────────────────────────

export const fetchConversationMessages = (convId) =>
  supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', convId)
    .order('created_at', { ascending: true })

// New messages in one conversation call onInsert(payload).
export function subscribeToConversationMessages(convId, onInsert) {
  const ch = supabase.channel(`gw-msgs-${convId}`)
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'messages',
      filter: `conversation_id=eq.${convId}`,
    }, onInsert)
    .subscribe()
  return () => supabase.removeChannel(ch)
}
