import React, { useState, useEffect } from 'react'
import { supabase } from './lib/supabase.js'
import { Icon, Avatar, Modal, Badge, ToastHost, Loading, pushToast } from './components/UI.jsx'
import Dashboard from './pages/Dashboard.jsx'
import ContactsPage from './pages/Contacts.jsx'
import PropertiesPage from './pages/Properties.jsx'
import PipelinePage from './pages/Pipeline.jsx'
import CommissionPage from './pages/Commission.jsx'
import TasksPage from './pages/Tasks.jsx'
import TemplatesPage, { ComposeModal } from './pages/Templates.jsx'
import TeamPage from './pages/Team.jsx'
import SettingsPage from './pages/Settings.jsx'
import LoginPage from './pages/Login.jsx'
import LeadsPage from './pages/Leads.jsx'
import OmPage from './pages/Om.jsx'
import SocialPage from './pages/Social.jsx'
import ReportsPage from './pages/Reports.jsx'
import SequencesPage from './pages/Sequences.jsx'
import ColdCallsPage from './pages/ColdCalls.jsx'
import QuickAdd from './pages/QuickAdd.jsx'
import IntegrationsPage from './pages/Integrations.jsx'
import { Analytics } from '@vercel/analytics/react'

// Primary: what every agent uses every day
const NAV_CORE = [
  { id: 'dashboard',  label: 'Dashboard',  icon: 'dashboard' },
  { id: 'contacts',   label: 'Contacts',   icon: 'contacts' },
  { id: 'properties', label: 'Properties', icon: 'building' },
  { id: 'pipeline',   label: 'Pipeline',   icon: 'pipeline' },
  { id: 'tasks',      label: 'Tasks',      icon: 'tasks' },
]

// Office: business operations, reviewed regularly
const NAV_OFFICE = [
  { id: 'commission', label: 'Commission', icon: 'commission' },
  { id: 'coldcalls',  label: 'Cold Calls', icon: 'phone' },
  { id: 'reports',    label: 'Reports',    icon: 'reports' },
  { id: 'team',       label: 'Team',       icon: 'team' },
]

// Marketing & Tools: power features, collapsed for new users
const NAV_TOOLS = [
  { id: 'templates',  label: 'Email Templates', icon: 'mail' },
  { id: 'sequences',  label: 'Drip Sequences',  icon: 'sequences' },
  { id: 'om',         label: 'OM Generator',    icon: 'om' },
  { id: 'social',     label: 'Social Media',    icon: 'social' },
  { id: 'leads',      label: 'Website Leads',   icon: 'leads' },
]

// Always visible at the bottom — never buried
const NAV_ADMIN = [
  { id: 'integrations', label: 'Integrations', icon: 'pipeline' },
  { id: 'settings',     label: 'Settings',     icon: 'settings' },
]

const TOOLS_IDS = NAV_TOOLS.map(n => n.id)

const TITLES = {
  dashboard:  { title: 'Dashboard',        crumb: 'Overview' },
  contacts:   { title: 'Contacts',         crumb: 'CRM · People' },
  properties: { title: 'Properties',       crumb: 'Database · Listings' },
  pipeline:   { title: 'Pipeline',         crumb: 'Deals · Kanban' },
  coldcalls:  { title: 'Cold Call Lists',  crumb: 'Prospecting · Dialer' },
  commission: { title: 'Commission',       crumb: 'Deals · Earnings' },
  tasks:      { title: 'Tasks',            crumb: 'Follow-ups · Reminders' },
  team:       { title: 'Team',             crumb: 'Agents · Roster' },
  templates:  { title: 'Email Templates',  crumb: 'Communications · Library' },
  sequences:  { title: 'Drip Sequences',   crumb: 'Marketing · Automation' },
  reports:    { title: 'Reports',          crumb: 'Analytics · ROI' },
  om:         { title: 'OM Generator',     crumb: 'Tools · Documents' },
  social:     { title: 'Social Media',     crumb: 'Tools · Content' },
  leads:      { title: 'Website Leads',    crumb: 'Marketing · Captures' },
  integrations: { title: 'Integrations',    crumb: 'Tools · Connections' },
  settings:     { title: 'Settings',        crumb: 'Workspace' },
}

const COLORS = ['#2d3561','#4a6fa5','#2e7d5e','#c9a84c','#6b4fa5','#c0392b','#d4820a','#1a1a2e']

const nameFromEmail = (email = '') => {
  const local = (email || '').split('@')[0]
  return local.split(/[._-]+/).filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
}

function AgentOnboardingModal({ session, onComplete }) {
  const guessedName = nameFromEmail(session?.user?.email || '')
  const [name, setName] = useState(guessedName)
  const [role, setRole] = useState('')
  const [color, setColor] = useState(COLORS[0])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const autoInitials = (n) => n.trim().split(/\s+/).map(w => w[0] || '').join('').toUpperCase().slice(0, 2)

  const save = async () => {
    if (!name.trim()) { setError('Please enter your full name.'); return }
    setSaving(true)
    const { data, error: err } = await supabase.from('agents').insert([{
      auth_id: session?.user?.id,
      name: name.trim(),
      initials: autoInitials(name),
      role: role.trim() || 'Agent',
      email: session?.user?.email || '',
      color,
    }]).select().single()
    setSaving(false)
    if (err) { setError(err.message); return }
    onComplete(data)
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(10,14,28,0.7)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 24,
    }}>
      <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 440, boxShadow: 'var(--shadow-modal)' }}>
        <div style={{ padding: '28px 32px 0' }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 26, fontWeight: 600, color: 'var(--gw-slate)', marginBottom: 6 }}>
            Welcome to Gateway CRM
          </div>
          <div style={{ fontSize: 14, color: 'var(--gw-mist)', lineHeight: 1.6, marginBottom: 24 }}>
            Let's set up your agent profile. This creates your shared identity across the team.
          </div>

          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
            <div style={{ width: 64, height: 64, borderRadius: 12, background: color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, fontWeight: 700, color: '#fff', transition: 'background 200ms' }}>
              {autoInitials(name) || '?'}
            </div>
          </div>

          <div className="form-group">
            <label className="form-label required">Full Name</label>
            <input className="form-control" value={name} onChange={e => setName(e.target.value)} placeholder="Jane Smith" autoFocus />
          </div>

          <div className="form-group">
            <label className="form-label">Role / Title</label>
            <input className="form-control" value={role} onChange={e => setRole(e.target.value)} placeholder="Lead Agent, Buyer's Agent, Admin…" />
          </div>

          <div className="form-group">
            <label className="form-label">Avatar Color</label>
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              {COLORS.map(c => (
                <div key={c} onClick={() => setColor(c)} style={{ width: 28, height: 28, borderRadius: 6, background: c, cursor: 'pointer', border: color === c ? '3px solid var(--gw-ink)' : '3px solid transparent', transition: 'border 150ms' }} />
              ))}
            </div>
          </div>

          {error && <div style={{ color: 'var(--gw-red)', fontSize: 13, marginBottom: 12 }}>{error}</div>}
        </div>

        <div style={{ padding: '16px 32px 28px', borderTop: '1px solid var(--gw-border)', marginTop: 8 }}>
          <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginBottom: 12 }}>
            Logged in as <strong>{session?.user?.email}</strong>. Your profile is shared with the whole team.
          </div>
          <button className="btn btn--primary" style={{ width: '100%', justifyContent: 'center' }} onClick={save} disabled={saving}>
            {saving ? 'Creating Profile…' : 'Get Started →'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function App() {
  const [session, setSession] = useState(null)
  const [db, setDb] = useState({ contacts: [], properties: [], deals: [], tasks: [], agents: [], templates: [], commissions: [], commissionsReady: true, activities: [], activitiesReady: true })
  const [loading, setLoading] = useState(true)
  const [route, setRoute] = useState('dashboard')
  const [collapsed, setCollapsed] = useState(false)
  const [activeAgentId, setActiveAgentId] = useState(null)
  const [compose, setCompose] = useState(null)
  const [mobileMore, setMobileMore] = useState(false)
  const [needsOnboarding, setNeedsOnboarding] = useState(false)
  const [notifications,   setNotifications]   = useState([])
  const [notifOpen,       setNotifOpen]       = useState(false)
  const [websiteEnabled, setWebsiteEnabled] = useState(
    () => localStorage.getItem('gw_website_enabled') === 'true'
  )
  const [toolsOpen, setToolsOpen] = useState(
    () => localStorage.getItem('gw_tools_open') === 'true'
  )

  // Auto-expand tools section when navigating to a tools page
  useEffect(() => {
    if (TOOLS_IDS.includes(route) && !toolsOpen) {
      setToolsOpen(true)
      localStorage.setItem('gw_tools_open', 'true')
    }
  }, [route])

  // Flat list for mobile nav (filter leads if website is disabled)
  const NAV = [
    ...NAV_CORE,
    ...NAV_OFFICE,
    ...(websiteEnabled ? NAV_TOOLS : NAV_TOOLS.filter(n => n.id !== 'leads')),
    ...NAV_ADMIN,
  ]
  // Tools items visible in sidebar (leads gated by websiteEnabled)
  const visibleTools = websiteEnabled ? NAV_TOOLS : NAV_TOOLS.filter(n => n.id !== 'leads')

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

  useEffect(() => {
    if (!session) return
    const load = async () => {
      const [contacts, properties, deals, tasks, agents, templates, commissionsRes, activitiesRes] = await Promise.all([
        supabase.from('contacts').select('*').order('created_at', { ascending: false }),
        supabase.from('properties').select('*').order('created_at', { ascending: false }),
        supabase.from('deals').select('*').order('created_at', { ascending: false }),
        supabase.from('tasks').select('*').order('due_date', { ascending: true }),
        supabase.from('agents').select('*').order('created_at', { ascending: true }),
        supabase.from('templates').select('*').order('created_at', { ascending: false }),
        supabase.from('commissions').select('*'),
        supabase.from('activities').select('*').order('created_at', { ascending: false }),
      ])
      const agentsData = agents.data || []
      setDb({
        contacts: contacts.data || [],
        properties: properties.data || [],
        deals: deals.data || [],
        tasks: tasks.data || [],
        agents: agentsData,
        templates: templates.data || [],
        commissions: commissionsRes.data || [],
        commissionsReady: !commissionsRes.error,
        activities: activitiesRes.data || [],
        activitiesReady: !activitiesRes.error,
      })

      const userId        = session?.user?.id
      const loggedInEmail = session?.user?.email?.toLowerCase()

      // Priority 1: match by auth_id (the bulletproof way)
      let matched = userId ? agentsData.find(a => a.auth_id === userId) : null

      // Priority 2: claim an unclaimed agent record with matching email
      if (!matched && userId) {
        const orphan = agentsData.find(a =>
          !a.auth_id && a.email?.toLowerCase() === loggedInEmail
        )
        if (orphan) {
          const { error } = await supabase
            .from('agents').update({ auth_id: userId }).eq('id', orphan.id)
          if (!error) {
            matched = { ...orphan, auth_id: userId }
          } else {
            // Unique constraint failed → someone else already claimed this auth_id.
            // Reload agents to find the one that actually has it.
            const { data: fresh } = await supabase.from('agents').select('*')
            matched = (fresh || []).find(a => a.auth_id === userId) || null
            if (fresh) setDb(p => ({ ...p, agents: fresh }))
          }
        }
      }

      if (matched) {
        setActiveAgentId(matched.id)
      } else {
        setNeedsOnboarding(true)
      }
      setLoading(false)
    }
    load()
  }, [session])

  // Realtime: listen for new agent_notifications for the active agent
  useEffect(() => {
    if (!activeAgentId) return
    // Load existing unread notifications
    supabase
      .from('agent_notifications')
      .select('*')
      .eq('agent_id', activeAgentId)
      .eq('read', false)
      .order('created_at', { ascending: false })
      .then(({ data }) => { if (data) setNotifications(data) })
      .catch(() => {}) // table may not exist yet — fail silently

    const channel = supabase.channel(`notif-agent-${activeAgentId}`)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'agent_notifications',
        filter: `agent_id=eq.${activeAgentId}`,
      }, payload => {
        setNotifications(prev => [payload.new, ...prev])
        pushToast(payload.new.title
          ? `${payload.new.title}: ${payload.new.message}`
          : payload.new.message || 'New notification', 'success')
      })
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [activeAgentId])

  const markNotifRead = async (id) => {
    await supabase.from('agent_notifications').update({ read: true }).eq('id', id)
    setNotifications(prev => prev.filter(n => n.id !== id))
  }

  const markAllRead = async () => {
    const ids = notifications.map(n => n.id)
    if (ids.length === 0) return
    await supabase.from('agent_notifications').update({ read: true }).in('id', ids)
    setNotifications([])
  }

  const signOut = async () => {
    await supabase.auth.signOut()
    setDb({ contacts: [], properties: [], deals: [], tasks: [], agents: [], templates: [], commissions: [], commissionsReady: true, activities: [], activitiesReady: true })
    setNotifications([])
    setNeedsOnboarding(false)
    setLoading(true)
  }

  if (!session) return <LoginPage />

  const activeAgent = db.agents.find(a => a.id === activeAgentId) || null
  const props = { db, setDb, activeAgent, go: setRoute, openCompose: setCompose }

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', flexDirection: 'column', gap: 16 }}>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: 32, fontWeight: 600, color: 'var(--gw-slate)' }}>Gateway</div>
      <Loading />
    </div>
  )

  return (
    <div className="app" onClick={() => notifOpen && setNotifOpen(false)}>
      {needsOnboarding && (
        <AgentOnboardingModal
          session={session}
          onComplete={(agent) => {
            setDb(p => ({ ...p, agents: [...p.agents, agent] }))
            setActiveAgentId(agent.id)
            setNeedsOnboarding(false)
            pushToast(`Welcome, ${agent.name}!`)
          }}
        />
      )}

      <aside className={`sidebar${collapsed ? ' collapsed' : ''}`}>
        <div className="sidebar__brand">
          <div className="sidebar__brand-mark">G</div>
          {!collapsed && (
            <div className="sidebar__brand-text">
              <div className="sidebar__wordmark">Gateway</div>
              <div className="sidebar__sub">Real Estate Advisors</div>
            </div>
          )}
          <button className="sidebar__collapse" onClick={() => setCollapsed(!collapsed)} title={collapsed ? 'Expand' : 'Collapse'}>
            <Icon name={collapsed ? 'chevronRight' : 'chevronLeft'} size={16} />
          </button>
        </div>

        <nav className="sidebar__nav" aria-label="Main navigation">
          {/* ── Core ── */}
          {NAV_CORE.map(n => (
            <div key={n.id} className={`nav-item${route === n.id ? ' active' : ''}`}
              onClick={() => setRoute(n.id)} title={n.label}
              role="button" tabIndex={0} onKeyDown={e => e.key === 'Enter' && setRoute(n.id)}>
              <Icon name={n.icon} size={16} />
              {!collapsed && <span>{n.label}</span>}
            </div>
          ))}

          {/* ── Office ── */}
          {!collapsed && <div className="nav-section-label" style={{ marginTop: 8 }}>Office</div>}
          {collapsed && <div className="nav-section-divider" />}
          {NAV_OFFICE.map(n => (
            <div key={n.id} className={`nav-item${route === n.id ? ' active' : ''}`}
              onClick={() => setRoute(n.id)} title={n.label}
              role="button" tabIndex={0} onKeyDown={e => e.key === 'Enter' && setRoute(n.id)}>
              <Icon name={n.icon} size={16} />
              {!collapsed && <span>{n.label}</span>}
            </div>
          ))}

          {/* ── Marketing & Tools (collapsible) ── */}
          {collapsed ? (
            <div className="nav-section-divider" />
          ) : (
            <button
              className={`nav-group-toggle${TOOLS_IDS.includes(route) ? ' has-active' : ''}${toolsOpen ? ' open' : ''}`}
              onClick={() => { const next = !toolsOpen; setToolsOpen(next); localStorage.setItem('gw_tools_open', String(next)) }}
              aria-expanded={toolsOpen}
              title={toolsOpen ? 'Collapse Marketing & Tools' : 'Expand Marketing & Tools'}
            >
              <span>Marketing &amp; Tools</span>
              <span className="nav-group-toggle__badge">{visibleTools.length}</span>
              <Icon name={toolsOpen ? 'chevronDown' : 'chevronRight'} size={11} style={{ marginLeft: 'auto', flexShrink: 0 }} />
            </button>
          )}
          {(toolsOpen || collapsed) && visibleTools.map(n => (
            <div key={n.id} className={`nav-item${route === n.id ? ' active' : ''}${!collapsed ? ' nav-item--indented' : ''}`}
              onClick={() => setRoute(n.id)} title={n.label}
              role="button" tabIndex={0} onKeyDown={e => e.key === 'Enter' && setRoute(n.id)}>
              <Icon name={n.icon} size={16} />
              {!collapsed && <span>{n.label}</span>}
            </div>
          ))}
        </nav>

        {/* ── Admin — pinned above agent profile ── */}
        <div className="sidebar__bottom">
          {NAV_ADMIN.map(n => (
            <div key={n.id} className={`nav-item nav-item--admin${route === n.id ? ' active' : ''}`}
              onClick={() => setRoute(n.id)} title={n.label}
              role="button" tabIndex={0} onKeyDown={e => e.key === 'Enter' && setRoute(n.id)}>
              <Icon name={n.icon} size={16} />
              {!collapsed && <span>{n.label}</span>}
            </div>
          ))}
        </div>

        <div className="sidebar__agent">
          {activeAgent && <Avatar agent={activeAgent} size={32} />}
          {!activeAgent && <div style={{ width: 32, height: 32, borderRadius: 8, background: 'rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="contacts" size={14} style={{ color: 'rgba(255,255,255,0.4)' }} /></div>}
          {!collapsed && (
            <div style={{ flex: 1, overflow: 'hidden' }}>
              <div className="agent-name">{activeAgent?.name || 'No agent selected'}</div>
              <div className="agent-role">{activeAgent?.role || 'Set up your profile'}</div>
            </div>
          )}
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div>
            <div className="topbar__title">{TITLES[route]?.title}</div>
            <div className="topbar__breadcrumb">{TITLES[route]?.crumb}</div>
          </div>
          <div className="topbar__search">
            <Icon name="search" size={14} style={{ color: 'var(--gw-mist)' }} />
            <input placeholder="Search contacts, properties, deals…" defaultValue="" />
          </div>
          {activeAgent && (
            <div className="topbar__agent-badge">
              <Avatar agent={activeAgent} size={30} />
              <div>
                <div className="label">Active Agent</div>
                <div className="name">{activeAgent.name}</div>
              </div>
            </div>
          )}
          {/* Notification bell */}
          <div style={{ position: 'relative' }}>
            <button
              className="btn btn--ghost btn--icon"
              title="Notifications"
              onClick={() => setNotifOpen(o => !o)}
              style={{ position: 'relative' }}
            >
              <Icon name="alert" size={16} />
              {notifications.length > 0 && (
                <span style={{
                  position: 'absolute', top: 2, right: 2,
                  width: 16, height: 16, borderRadius: '50%',
                  background: 'var(--gw-red, #dc2626)', color: '#fff',
                  fontSize: 9, fontWeight: 700,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  pointerEvents: 'none',
                }}>
                  {notifications.length > 9 ? '9+' : notifications.length}
                </span>
              )}
            </button>
            {notifOpen && (
              <div style={{
                position: 'absolute', right: 0, top: 'calc(100% + 8px)', zIndex: 200,
                width: 340, background: '#fff', border: '1px solid var(--gw-border)',
                borderRadius: 'var(--radius)', boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
              }} onClick={e => e.stopPropagation()}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--gw-border)' }}>
                  <span style={{ fontWeight: 700, fontSize: 13 }}>Notifications</span>
                  {notifications.length > 0 && (
                    <button className="btn btn--ghost btn--sm" style={{ fontSize: 11 }} onClick={markAllRead}>
                      Mark all read
                    </button>
                  )}
                </div>
                {notifications.length === 0 ? (
                  <div style={{ padding: '24px 14px', textAlign: 'center', fontSize: 13, color: 'var(--gw-mist)' }}>
                    No new notifications
                  </div>
                ) : (
                  <div style={{ maxHeight: 360, overflowY: 'auto' }}>
                    {notifications.map(n => (
                      <div key={n.id} style={{
                        display: 'flex', gap: 10, padding: '10px 14px',
                        borderBottom: '1px solid var(--gw-border)',
                        background: '#f0fdf4',
                      }}>
                        <Icon name="check" size={14} style={{ color: 'var(--gw-green)', flexShrink: 0, marginTop: 2 }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--gw-ink)' }}>{n.title}</div>
                          <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginTop: 2, lineHeight: 1.5 }}>{n.message}</div>
                          <div style={{ fontSize: 10, color: 'var(--gw-mist)', marginTop: 4 }}>
                            {new Date(n.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                          </div>
                        </div>
                        <button
                          className="btn btn--ghost btn--icon btn--sm"
                          title="Dismiss"
                          onClick={() => markNotifRead(n.id)}
                          style={{ flexShrink: 0, alignSelf: 'flex-start' }}
                        >
                          <Icon name="x" size={11} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          <button className="btn btn--ghost btn--icon" onClick={signOut} title="Sign out" style={{ marginLeft: 4 }}>
            <Icon name="logout" size={16} />
          </button>
        </header>

        {route === 'dashboard'  && <Dashboard {...props} />}
        {route === 'contacts'   && <ContactsPage {...props} />}
        {route === 'properties' && <PropertiesPage {...props} />}
        {route === 'pipeline'   && <PipelinePage {...props} />}
        {route === 'coldcalls'  && <ColdCallsPage  db={db} setDb={setDb} activeAgent={activeAgent} />}
        {route === 'commission' && <CommissionPage {...props} />}
        {route === 'tasks'      && <TasksPage {...props} />}
        {route === 'team'       && <TeamPage {...props} onSwitchAgent={id => setActiveAgentId(id)} />}
        {route === 'templates'  && <TemplatesPage {...props} />}
        {route === 'sequences'  && <SequencesPage {...props} />}
        {route === 'reports'    && <ReportsPage {...props} />}
        {route === 'om'         && <OmPage />}
        {route === 'social'     && <SocialPage />}
        {route === 'leads'      && <LeadsPage {...props} />}
        {route === 'integrations' && <IntegrationsPage />}
        {route === 'settings'     && <SettingsPage {...props} websiteEnabled={websiteEnabled} setWebsiteEnabled={setWebsiteEnabled} />}
      </div>

      {compose && <ComposeModal ctx={compose} db={db} activeAgent={activeAgent} onClose={() => setCompose(null)} />}


      {/* ── Mobile bottom nav ── */}
      <nav className="mobile-nav">
        {['dashboard', 'contacts', 'pipeline', 'tasks'].map(id => {
          const n = NAV.find(x => x.id === id)
          if (!n) return null
          return (
            <button key={n.id} className={`mobile-nav__item${route === n.id ? ' active' : ''}`}
              onClick={() => setRoute(n.id)}>
              <Icon name={n.icon} size={22} />
              <span>{n.label}</span>
            </button>
          )
        })}
        <button className={`mobile-nav__item${mobileMore ? ' active' : ''}`}
          onClick={() => setMobileMore(m => !m)}>
          <Icon name="more" size={22} />
          <span>More</span>
        </button>
      </nav>

      {/* ── Mobile "More" sheet ── */}
      {mobileMore && (
        <div className="mobile-menu-backdrop" onClick={() => setMobileMore(false)}>
          <div className="mobile-menu" onClick={e => e.stopPropagation()}>
            <div className="mobile-menu__handle" />
            <div className="mobile-menu__label">Navigation</div>
            {NAV.filter(n => !['dashboard', 'contacts', 'pipeline', 'tasks'].includes(n.id)).map(n => (
              <div key={n.id} className={`mobile-menu__item${route === n.id ? ' active' : ''}`}
                onClick={() => { setRoute(n.id); setMobileMore(false) }}>
                <Icon name={n.icon} size={20} />
                <span>{n.label}</span>
              </div>
            ))}
            <div className="mobile-menu__divider" />
            <div className="mobile-menu__item danger" onClick={() => { setMobileMore(false); signOut() }}>
              <Icon name="logout" size={20} />
              <span>Sign out</span>
            </div>
          </div>
        </div>
      )}

      <QuickAdd db={db} setDb={setDb} activeAgent={activeAgent} />
      <ToastHost />
      <Analytics />
    </div>
  )
}
