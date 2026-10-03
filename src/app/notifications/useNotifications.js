import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase.js'
import { pushToast } from '../../components/UI.jsx'
import {
  fetchUnreadNotifications, subscribeToNotifications,
  markNotificationRead, markNotificationsRead, notificationToastText,
} from '../../lib/services/notifications.js'

/** The active agent's unread notifications: loaded once, then kept live over realtime. */
export function useNotifications(agentId) {
  const [notifications, setNotifications] = useState([])

  useEffect(() => {
    if (!agentId) return
    fetchUnreadNotifications(supabase, agentId)
      .then(rows => { if (rows) setNotifications(rows) })

    return subscribeToNotifications(supabase, agentId, row => {
      setNotifications(prev => [row, ...prev])
      pushToast(notificationToastText(row), 'success')
    })
  }, [agentId])

  const markRead = async (id) => {
    await markNotificationRead(supabase, id)
    setNotifications(prev => prev.filter(n => n.id !== id))
  }

  const markAllRead = async () => {
    const ids = notifications.map(n => n.id)
    if (ids.length === 0) return
    await markNotificationsRead(supabase, ids)
    setNotifications([])
  }

  return { notifications, markRead, markAllRead, clear: () => setNotifications([]) }
}
