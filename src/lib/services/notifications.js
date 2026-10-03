// ─────────────────────────────────────────────────────────────────────────────
// Agent notifications — the bell in the top bar.
//
// Reads, the realtime INSERT feed, and the read-receipts. The table may not
// exist on an un-migrated database, so the initial read swallows failures and
// the bell simply stays empty.
// ─────────────────────────────────────────────────────────────────────────────

/** Unread notifications for one agent, newest first. Resolves [] on failure. */
export const fetchUnreadNotifications = (supabase, agentId) =>
  supabase
    .from('agent_notifications')
    .select('*')
    .eq('agent_id', agentId)
    .eq('read', false)
    .order('created_at', { ascending: false })
    .then(({ data }) => data || null, () => null)

/**
 * Call `onInsert(row)` for every notification created for this agent.
 * Returns the unsubscribe function.
 */
export function subscribeToNotifications(supabase, agentId, onInsert) {
  const channel = supabase.channel(`notif-agent-${agentId}`)
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'agent_notifications',
      filter: `agent_id=eq.${agentId}`,
    }, payload => onInsert(payload.new))
    .subscribe()
  return () => { supabase.removeChannel(channel) }
}

export const markNotificationRead = (supabase, id) =>
  supabase.from('agent_notifications').update({ read: true }).eq('id', id)

export const markNotificationsRead = (supabase, ids) =>
  supabase.from('agent_notifications').update({ read: true }).in('id', ids)

/** The toast text a freshly-arrived notification raises. */
export const notificationToastText = (n) =>
  n.title ? `${n.title}: ${n.message}` : n.message || 'New notification'
