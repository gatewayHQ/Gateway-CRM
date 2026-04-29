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

const BASE_NAV = [
  { id: 'dashboard',  label: 'Dashboard',      icon: 'dashboard' },
  { id: 'contacts',   label: 'Contacts',        icon: 'contacts' },
  { id: 'properties', label: 'Properties',      icon: 'building' },
  { id: 'pipeline',   label: 'Pipeline',        icon: 'pipeline' },
  { id: 'coldcalls',  label: 'Cold Call Lists', icon: 'phone' },
  { id: 'commission', label: 'Commission',      icon: 'commission' },
  { id: 'tasks',      label: 'Tasks',           icon: 'tasks' },
  { id: 'team',       label: 'Team',            icon: 'team' },
  { id: 'templates',  label: 'Email Templates', icon: 'mail' },
  { id: 'sequences',  label: 'Drip Sequences',  icon: 'sequences' },
  { id: 'reports',    label: 'Reports',         icon: 'reports' },
  { id: 'om',         label: 'OM Generator',    icon: 'om' },
  { id: 'social',     label: 'Social Media',    icon: 'social' },
  { id: 'leads',      label: 'Website Leads',   icon: 'leads' },
  { id: 'settings',   label: 'Settings',        icon: 'settings' },
]

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
  settings:   { title: 'Settings',         crumb: 'Workspace' },
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
  const [globalSearch, setGlobalSearch] = useState('')
  const [mobileMore, setMobileMore] = useState(false)
  const [needsOnboarding, setNeedsOnboarding] = useState(false)
  const [websiteEnabled, setWebsiteEnabled] = useState(
    () => localStorage.getItem('gw_website_enabled') === 'true'
  )

  const NAV = websiteEnabled ? BASE_NAV : BASE_NAV.filter(n => n.id !== 'leads')

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

      const loggedInEmail = session?.user?.email?.toLowerCase()
      const matched = agentsData.find(a => a.email?.toLowerCase() === loggedInEmail)
      if (matched) {
        setActiveAgentId(matched.id)
      } else {
        setNeedsOnboarding(true)
      }
      setLoading(false)
    }
    load()
  }, [session])

  const signOut = async () => {
    await supabase.auth.signOut()
    setDb({ contacts: [], properties: [], deals: [], tasks: [], agents: [], templates: [], commissions: [], commissionsReady: true, activities: [], activitiesReady: true })
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
    <div className="app">
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

        <nav className="sidebar__nav">
          {!collapsed && <div className="nav-section-label">Workspace</div>}
          {NAV.slice(0, 6).map(n => (
            <div key={n.id} className={`nav-item${route === n.id ? ' active' : ''}`} onClick={() => setRoute(n.id)} title={n.label}>
              <Icon name={n.icon} size={16} />
              {!collapsed && <span>{n.label}</span>}
            </div>
          ))}
          {!collapsed && <div className="nav-section-label">Team &amp; Tools</div>}
          {NAV.slice(6).map(n => (
            <div key={n.id} className={`nav-item${route === n.id ? ' active' : ''}`} onClick={() => setRoute(n.id)} title={n.label}>
              <Icon name={n.icon} size={16} />
              {!collapsed && <span>{n.label}</span>}
            </div>
          ))}
        </nav>

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
            <input placeholder="Search contacts, properties, deals…" value={globalSearch} onChange={e => setGlobalSearch(e.target.value)} />
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
          <button className="btn btn--ghost btn--icon" onClick={signOut} title="Sign out" style={{ marginLeft: 4 }}>
            <Icon name="logout" size={16} />
          </button>
        </header>

        {route === 'dashboard'  && <Dashboard {...props} />}
        {route === 'contacts'   && <ContactsPage {...props} />}
        {route === 'properties' && <PropertiesPage {...props} />}
        {route === 'pipeline'   && <PipelinePage {...props} />}
        {route === 'coldcalls'  && <ColdCallsPage  db={db} activeAgent={activeAgent} />}
        {route === 'commission' && <CommissionPage {...props} />}
        {route === 'tasks'      && <TasksPage {...props} />}
        {route === 'team'       && <TeamPage {...props} onSwitchAgent={id => setActiveAgentId(id)} />}
        {route === 'templates'  && <TemplatesPage {...props} />}
        {route === 'sequences'  && <SequencesPage {...props} />}
        {route === 'reports'    && <ReportsPage {...props} />}
        {route === 'om'         && <OmPage />}
        {route === 'social'     && <SocialPage />}
        {route === 'leads'      && <LeadsPage {...props} />}
        {route === 'settings'   && <SettingsPage {...props} websiteEnabled={websiteEnabled} setWebsiteEnabled={setWebsiteEnabled} />}
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
    </div>
  )
}
