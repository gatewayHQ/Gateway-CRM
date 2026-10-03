// ─────────────────────────────────────────────────────────────────────────────
// Route → screen.
//
// Every page is lazy-loaded, so only the current route's bundle downloads.
// Each route declares exactly the props its page takes: most take the shared
// page context (`ctx.page`), a few take a narrower slice or a one-shot
// handoff. Adding a screen means one lazy import and one entry below.
// ─────────────────────────────────────────────────────────────────────────────
import React from 'react'
import { HIDEABLE_NAV, isDealRoute, parseDealRoute } from './navigation.js'

const Dashboard          = React.lazy(() => import('../pages/Dashboard.jsx'))
const ContactsPage       = React.lazy(() => import('../pages/Contacts.jsx'))
const PropertiesPage     = React.lazy(() => import('../pages/Properties.jsx'))
const PipelinePage       = React.lazy(() => import('../pages/pipeline/PipelinePage.jsx'))
const DealPage           = React.lazy(() => import('../pages/DealPage.jsx'))
const TasksPage          = React.lazy(() => import('../pages/Tasks.jsx'))
const MessagesPage       = React.lazy(() => import('../pages/Messages.jsx'))
const CommissionPage     = React.lazy(() => import('../pages/Commission.jsx'))
const TemplatesPage      = React.lazy(() => import('../pages/Templates.jsx'))
const TeamPage           = React.lazy(() => import('../pages/Team/index.jsx'))
const SettingsPage       = React.lazy(() => import('../pages/Settings.jsx'))
const LeadsPage          = React.lazy(() => import('../pages/Leads.jsx'))
const DataManagementPage = React.lazy(() => import('../pages/DataManagement.jsx'))
const ReportsPage        = React.lazy(() => import('../pages/Reports.jsx'))
const SequencesPage      = React.lazy(() => import('../pages/Sequences.jsx'))
const MassEmailPage      = React.lazy(() => import('../pages/MassEmail.jsx'))
const ColdCallsPage      = React.lazy(() => import('../pages/ColdCalls.jsx'))
const IntegrationsPage   = React.lazy(() => import('../pages/Integrations.jsx'))
const CampaignsPage      = React.lazy(() => import('../pages/Campaigns.jsx'))
const FormLibraryPage    = React.lazy(() => import('../pages/FormLibrary.jsx'))
const AdminReviewPage    = React.lazy(() => import('../pages/AdminReview.jsx'))
// Unreleased. Reached only by ?preview=markup — deliberately not in the nav,
// so testing it cannot become an agent stumbling onto it mid-transaction.
const MarkupPreviewPage  = React.lazy(() => import('../pages/MarkupPreview.jsx'))

// ComposeModal is a named export — wrap in a lazy default-export shim
export const ComposeModalLazy = React.lazy(() =>
  import('../pages/Templates.jsx').then(m => ({ default: m.ComposeModal }))
)

// The one-shot "open this record" handoff, for pages that accept one.
const focusProps = (ctx) => ({ focusRecord: ctx.focusRecord, onFocusHandled: ctx.clearFocus })

/**
 * ctx = {
 *   page,                          shared page context (db, activeAgent, go, …)
 *   focusRecord, clearFocus,       record handoff (search hit, deep link, "+ New")
 *   announceProperty, clearAnnounce,  Properties → "Announce" → Mass Email
 *   activeAgentId, onSwitchAgent,
 * }
 */
const ROUTES = {
  dashboard:    (ctx) => <Dashboard {...ctx.page} />,
  contacts:     (ctx) => <ContactsPage {...ctx.page} {...focusProps(ctx)} />,
  properties:   (ctx) => <PropertiesPage {...ctx.page} {...focusProps(ctx)} />,
  pipeline:     (ctx) => <PipelinePage {...ctx.page} {...focusProps(ctx)} />,
  coldcalls:    ({ page: { db, setDb, activeAgent } }) => <ColdCallsPage db={db} setDb={setDb} activeAgent={activeAgent} />,
  campaigns:    ({ page: { db, setDb, activeAgent } }) => <CampaignsPage db={db} setDb={setDb} activeAgent={activeAgent} />,
  commission:   (ctx) => <CommissionPage {...ctx.page} />,
  tasks:        (ctx) => <TasksPage {...ctx.page} />,
  messages:     ({ page: { db, activeAgent } }) => <MessagesPage db={db} activeAgent={activeAgent} />,
  team:         (ctx) => <TeamPage {...ctx.page} onSwitchAgent={ctx.onSwitchAgent} />,
  templates:    (ctx) => <TemplatesPage {...ctx.page} />,
  sequences:    (ctx) => <SequencesPage {...ctx.page} />,
  'mass-email': (ctx) => (
    <MassEmailPage {...ctx.page} focusProperty={ctx.announceProperty}
      onFocusHandled={ctx.clearAnnounce} />
  ),
  reports:      (ctx) => <ReportsPage {...ctx.page} />,
  review:       (ctx) => <AdminReviewPage {...ctx.page} />,
  'form-library': ({ page: { isAdmin } }) => <FormLibraryPage isAdmin={isAdmin} />,
  leads:        (ctx) => <LeadsPage {...ctx.page} />,
  integrations: ({ page: { isAdmin } }) => <IntegrationsPage isAdmin={isAdmin} />,
  'data-management': ({ page: { isAdmin } }) => (isAdmin ? <DataManagementPage /> : null),
  settings:     (ctx) => <SettingsPage {...ctx.page} activeAgentId={ctx.activeAgentId} hideableNav={HIDEABLE_NAV} />,
  'markup-preview': () => <MarkupPreviewPage />,
}

/** The screen for `route`, or nothing for a route this build doesn't know. */
export function RouteOutlet({ route, ...ctx }) {
  // `deal/<id>` and `deal/<id>/<drawer tab>`. The suffix is how another
  // screen hands an agent straight to the thing they clicked — the
  // dashboard's signature queue lands on that deal's Signatures tab
  // rather than on the deal page for them to find it again.
  if (isDealRoute(route)) {
    const { dealId, openTab } = parseDealRoute(route)
    return <DealPage {...ctx.page} dealId={dealId} openTab={openTab} />
  }
  return Object.prototype.hasOwnProperty.call(ROUTES, route) ? ROUTES[route](ctx) : null
}
