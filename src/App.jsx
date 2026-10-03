// ─────────────────────────────────────────────────────────────────────────────
// The signed-in CRM shell — composition root.
//
// This file wires the app together and holds no business rules of its own:
//
//   app/workspace/      session, boot (identity → visibility → scoped data)
//   app/notifications/  the bell: unread list, realtime feed, read receipts
//   app/navigation.js   nav model, titles, per-agent visibility of entries
//   app/launchIntent.js deep links from outside the app (?deal=, ?contact=, …)
//   app/routes.jsx      route → lazy page, with each page's exact props
//   app/layout/         Sidebar, Topbar, MobileNav — presentational only
//   lib/services/       every Supabase read/write the above depend on
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState } from 'react'
import { Analytics } from '@vercel/analytics/react'
import { resolveStageLabels } from './lib/stageLabels.js'
import { StageLabelContext } from './lib/stageLabelContext.js'
import { mutationErrorMessage } from './lib/services/db.js'
import { ToastHost, Loading, BootScreen, BootError, ErrorBoundary, pushToast } from './components/UI.jsx'
import LoginPage from './pages/Login.jsx'
import QuickAdd from './pages/QuickAdd.jsx'
import InstallPrompt from './components/InstallPrompt.jsx'
import { useAuthSession } from './app/workspace/useAuthSession.js'
import { signOutUser } from './lib/services/auth.js'
import { useWorkspace } from './app/workspace/useWorkspace.js'
import { useNotifications } from './app/notifications/useNotifications.js'
import NotificationBell from './app/notifications/NotificationBell.jsx'
import AgentOnboardingModal from './app/onboarding/AgentOnboardingModal.jsx'
import { useAppNavigation } from './app/useAppNavigation.js'
import { pageTitleFor } from './app/navigation.js'
import { RouteOutlet, ComposeModalLazy } from './app/routes.jsx'
import Sidebar from './app/layout/Sidebar.jsx'
import Topbar from './app/layout/Topbar.jsx'
import MobileNav from './app/layout/MobileNav.jsx'

export default function App() {
  const session = useAuthSession()
  const workspace = useWorkspace(session)
  const { db, setDb, activeAgentId, visibility } = workspace
  const navigation = useAppNavigation({ agents: db.agents, activeAgentId })
  const { route, setRoute, navTo, nav, activeAgent, isAdmin } = navigation
  const bell = useNotifications(activeAgentId)

  const [collapsed, setCollapsed] = useState(false)
  const [compose, setCompose] = useState(null)
  const [notifOpen, setNotifOpen] = useState(false)
  // The property an agent chose to announce from the Properties page. Carried
  // as state rather than a URL param because this app has no real router;
  // cleared once Mass Email has consumed it so a later visit to the page
  // starts blank instead of re-seeding a stale listing.
  const [announceProperty, setAnnounceProperty] = useState(null)

  const signOut = async () => {
    await signOutUser()
    workspace.reset()
    bell.clear()
  }

  if (!session) return <LoginPage />

  // Pipeline column headers this agent renamed, layered over the built-in
  // labels. Resolved once here and provided to every screen so the board, the
  // deal page, and the dashboard all speak the agent's own vocabulary. Cheap
  // enough to recompute (one spread over ~16 keys) that memoizing it after the
  // early returns above would only buy a rules-of-hooks violation.
  const stageLabels = resolveStageLabels(activeAgent?.stage_labels)

  // The shared context most pages take.
  const page = {
    db, setDb, activeAgent, go: setRoute, openCompose: setCompose, isAdmin,
    // One list per shared dimension — each has its own opt-in flag.
    visibleAgentIds: visibility.contacts,
    propertyAgentIds: visibility.properties,
    dealAgentIds: visibility.deals,
    // Properties → "Announce" → the mass-email wizard, with the property preselected.
    announce: (propertyId) => { setAnnounceProperty(propertyId); setRoute('mass-email') },
    startNew: navigation.startNew,
    openContact: navigation.openContact,
  }

  if (workspace.loading) return <BootScreen />
  if (workspace.bootError) {
    return (
      <BootError
        message={mutationErrorMessage(workspace.bootError, undefined, "We couldn't load your CRM.")}
        onRetry={workspace.retry}
        onSignOut={signOut}
      />
    )
  }

  // Where a bell item goes: its contact (a new lead) or its deal (reminders,
  // nudges, signatures). Opening it also marks it read.
  const openNotification = (n) => {
    if (!n.contact_id && !n.deal_id) return null
    return () => {
      setNotifOpen(false)
      bell.markRead(n.id)
      if (n.contact_id) navigation.openContact(n.contact_id)
      else setRoute(`deal/${n.deal_id}`)
    }
  }

  return (
    <StageLabelContext.Provider value={stageLabels}>
    <div className="app" onClick={() => notifOpen && setNotifOpen(false)}>
      {workspace.needsOnboarding && (
        <AgentOnboardingModal
          session={session}
          onComplete={(agent) => {
            workspace.completeOnboarding(agent)
            pushToast(`Welcome, ${agent.name}!`)
          }}
        />
      )}

      <Sidebar
        nav={nav} route={route} navTo={navTo} isAdmin={isAdmin} activeAgent={activeAgent}
        collapsed={collapsed} onToggleCollapsed={() => setCollapsed(!collapsed)}
        toolsOpen={navigation.toolsOpen} onToggleTools={navigation.toggleTools}
      />

      <div className="main">
        <Topbar
          pageTitle={pageTitleFor(route, db.deals || [])}
          onHome={() => setRoute('dashboard')}
          search={{
            db,
            visibleAgentIds: visibility.contacts,
            propertyAgentIds: visibility.properties,
            isAdmin,
            onNavigate: navigation.openSearchResult,
          }}
          activeAgent={activeAgent}
          onSignOut={signOut}
          bell={
            <NotificationBell
              notifications={bell.notifications}
              open={notifOpen}
              onToggle={() => setNotifOpen(o => !o)}
              onDismiss={bell.markRead}
              onDismissAll={bell.markAllRead}
              onOpenItem={openNotification}
            />
          }
        />

        <React.Suspense fallback={<div style={{ display:'flex', alignItems:'center', justifyContent:'center', flex:1 }}><Loading /></div>}>
        <ErrorBoundary>
          <RouteOutlet
            route={route}
            page={page}
            focusRecord={navigation.focusRecord}
            clearFocus={navigation.clearFocus}
            announceProperty={announceProperty}
            clearAnnounce={() => setAnnounceProperty(null)}
            activeAgentId={activeAgentId}
            onSwitchAgent={workspace.setActiveAgentId}
          />
        </ErrorBoundary>
        </React.Suspense>
      </div>

      {compose && (
        <React.Suspense fallback={null}>
          <ComposeModalLazy ctx={compose} db={db} activeAgent={activeAgent} onClose={() => setCompose(null)} />
        </React.Suspense>
      )}

      <MobileNav nav={nav} route={route} navTo={navTo} isAdmin={isAdmin} onSignOut={signOut} />

      <QuickAdd db={db} setDb={setDb} activeAgent={activeAgent} go={setRoute} />
      <InstallPrompt />
      <ToastHost />
      <Analytics />
    </div>
    </StageLabelContext.Provider>
  )
}
