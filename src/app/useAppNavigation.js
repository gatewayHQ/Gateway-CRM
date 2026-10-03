// ─────────────────────────────────────────────────────────────────────────────
// Route state and every way the app moves between screens.
//
// Owns the current route, the one-shot "open this record" handoff to the
// destination page (`focusRecord`), the collapsible Marketing & Tools group,
// and the guards that bounce an agent off a screen they can't see.
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useState } from 'react'
import { pushToast } from '../components/UI.jsx'
import { isOfficeAdmin } from '../lib/officeAdmins.js'
import { routeForResult } from '../lib/search.js'
import {
  TOOLS_IDS, TOOLKIT_URL, buildNav, hiddenNavFor, isAdminOnlyRoute,
} from './navigation.js'
import { readLaunchIntent } from './launchIntent.js'

const TOOLS_OPEN_KEY = 'gw_tools_open'

export function useAppNavigation({ agents, activeAgentId }) {
  const [route, setRoute] = useState('dashboard')
  // Set by a global-search hit (or a deep link, or "+ New") so the
  // destination page opens that record; the page clears it once handled.
  const [focusRecord, setFocusRecord] = useState(null)
  const [toolsOpen, setToolsOpen] = useState(
    () => localStorage.getItem(TOOLS_OPEN_KEY) === 'true'
  )
  const persistToolsOpen = (open) => {
    setToolsOpen(open)
    localStorage.setItem(TOOLS_OPEN_KEY, String(open))
  }

  // Auto-expand tools section when navigating to a tools page
  useEffect(() => {
    if (TOOLS_IDS.includes(route) && !toolsOpen) persistToolsOpen(true)
  }, [route])

  // A link from outside the app (OAuth redirect, email) — see launchIntent.js.
  useEffect(() => {
    const intent = readLaunchIntent(window.location)
    if (!intent) return
    if (intent.focus) setFocusRecord(intent.focus)
    setRoute(intent.route)
    if (intent.toast) pushToast(intent.toast.message, intent.toast.type)
    if (intent.replaceUrl != null) window.history.replaceState(null, '', intent.replaceUrl)
  }, [])

  const activeAgent = agents?.find(a => a.id === activeAgentId) || null
  const isAdmin = isOfficeAdmin(activeAgent)
  // Keyed on the roster and id (not the row) so a roster reload re-checks the
  // current route against the hidden list, as the redirect below expects.
  const hiddenNav = useMemo(
    () => hiddenNavFor(agents?.find(a => a.id === activeAgentId)),
    [agents, activeAgentId],
  )
  const nav = buildNav({ isAdmin, hiddenNav })

  // If the current route is now hidden, redirect to dashboard
  useEffect(() => {
    if (hiddenNav.includes(route)) setRoute('dashboard')
  }, [hiddenNav])

  // An admin-only page reached by anyone else (a stale route after switching
  // agents) goes to the dashboard rather than rendering nothing. Waits for the
  // roster, so an admin is never bounced while their own row is still loading.
  useEffect(() => {
    if (!agents?.length || isAdmin) return
    if (isAdminOnlyRoute(route)) setRoute('dashboard')
  }, [isAdmin, route, agents?.length])

  // Nav click handler — Toolkit opens in a new tab (uses its own login); everything else routes
  const navTo = (id) => {
    if (id === 'toolkit') {
      window.open(TOOLKIT_URL, '_blank', 'noopener,noreferrer')
      return
    }
    setRoute(id)
  }

  const openRecord = (focus, toRoute) => { setFocusRecord(focus); setRoute(toRoute) }

  return {
    route, setRoute, navTo, nav, activeAgent, isAdmin,
    toolsOpen, toggleTools: () => persistToolsOpen(!toolsOpen),
    focusRecord, clearFocus: () => setFocusRecord(null),

    // Open one contact's drawer from anywhere (dashboard, bell, search).
    openContact: (id) => openRecord({ type: 'contact', id }, 'contacts'),

    // "+ Contact" / "+ Deal" from anywhere: go to the page AND open its blank
    // form, through the same one-shot handoff a search hit uses.
    startNew: (kind) => openRecord(
      { type: `new-${kind}` },
      { contact: 'contacts', property: 'properties', deal: 'pipeline' }[kind],
    ),

    openSearchResult: (item) => {
      const target = routeForResult(item)
      if (!target) return
      if (target.focus) setFocusRecord(target.focus)
      setRoute(target.route)
    },
  }
}
