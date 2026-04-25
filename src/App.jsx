import React, { useState, useEffect } from 'react'
import { supabase } from './lib/supabase.js'
import { Icon, Avatar, Modal, Badge, ToastHost, Loading, pushToast } from './components/UI.jsx'
import Dashboard from './pages/Dashboard.jsx'
import ContactsPage from './pages/Contacts.jsx'
import PropertiesPage from './pages/Properties.jsx'
import PipelinePage from './pages/Pipeline.jsx'
import TasksPage from './pages/Tasks.jsx'
import TemplatesPage, { ComposeModal } from './pages/Templates.jsx'
import TeamPage from './pages/Team.jsx'
import SettingsPage from './pages/Settings.jsx'
import LoginPage from './pages/Login.jsx'

const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
  { id: 'contacts', label: 'Contacts', icon: 'contacts' },
  { id: 'properties', label: 'Properties', icon: 'building' },
  { id: 'pipeline', label: 'Pipeline', icon: 'pipeline' },
  { id: 'tasks', label: 'Tasks', icon: 'tasks' },
  { id: 'team', label: 'Team', icon: 'team' },
  { id: 'templates', label: 'Email Templates', icon: 'mail' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
]

const TITLES = {
  dashboard: { title: 'Dashboard', crumb: 'Overview' },
  contacts: { title: 'Contacts', crumb: 'CRM · People' },
  properties: { title: 'Properties', crumb: 'Database · Listings' },
  pipeline: { title: 'Pipeline', crumb: 'Deals · Kanban' },
  tasks: { title: 'Tasks', crumb: 'Follow-ups · Reminders' },
  team: { title: 'Team', crumb: 'Agents · Roster' },
  templates: { title: 'Email Templates', crumb: 'Communications · Library' },
  settings: { title: 'Settings', crumb: 'Workspace' },
}

export default function App() {
  const [session, setSession] = useState(undefined)
  const [db, setDb] = useState({ contacts:[], properties:[], deals:[], tasks:[], agents:[], templates:[] })
  const [loading, setLoading] = useState(true)
  const [route, setRoute] = useState('dashboard')
  const [collapsed, setCollapsed] = useState(false)
  const [activeAgentId, setActiveAgentId] = useState(null)
  const [compose, setCompose] = useState(null)
  const [agentSwitcher, setAgentSwitcher] = useState(false)
  const [globalSearch, setGlobalSearch] = useState('')

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
      const [contacts, properties, deals, tasks, agents, templates] = await Promise.all([
        supabase.from('contacts').select('*').order('created_at', { ascending: false }),
        supabase.from('properties').select('*').order('created_at', { ascending: false }),
        supabase.from('deals').select('*').order('created_at', { ascending: false }),
        supabase.from('tasks').select('*').order('due_date', { ascending: true }),
        supabase.from('agents').select('*').order('created_at', { ascending: true }),
        supabase.from('templates').select('*').order('created_at', { ascending: false }),
      ])
      const agentsData = agents.data || []
      setDb({ contacts: contacts.data||[], properties: properties.data||[], deals: deals.data||[], tasks: tasks.data||[], agents: agentsData, templates: templates.data||[] })
      if (agentsData.length > 0) setActiveAgentId(agentsData[0].id)
      setLoading(false)
    }
    load()
  }, [session])

  const signOut = async () => {
    await supabase.auth.signOut()
    setDb({ contacts:[], properties:[], deals:[], tasks:[], agents:[], templates:[] })
    setLoading(true)
  }

  if (session === undefined) return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100vh' }}>
      <Loading />
    </div>
  )

  if (session === null) return <LoginPage />

  const activeAgent = db.agents.find(a => a.id === activeAgentId) || db.agents[0]
  const props = { db, setDb, activeAgent, go: setRoute, openCompose: setCompose }

  if (loading) return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100vh', flexDirection:'column', gap:16 }}>
      <div style={{ fontFamily:'var(--font-display)', fontSize:32, fontWeight:600, color:'var(--gw-slate)' }}>Gateway</div>
      <Loading />
    </div>
  )

  return (
    <div className="app">
      <aside className={`sidebar${collapsed?' collapsed':''}`}>
        <div className="sidebar__brand">
          <div className="sidebar__brand-mark">G</div>
          {!collapsed && (
            <div className="sidebar__brand-text">
              <div className="sidebar__wordmark">Gateway</div>
              <div className="sidebar__sub">Real Estate Advisors</div>
            </div>
          )}
          <button className="sidebar__collapse" onClick={() => setCollapsed(!collapsed)} title={collapsed?'Expand':'Collapse'}>
            <Icon name={collapsed?'chevronRight':'chevronLeft'} size={16} />
          </button>
        </div>

        <nav className="sidebar__nav">
          {!collapsed && <div className="nav-section-label">Workspace</div>}
          {NAV.slice(0, 5).map(n => (
            <div key={n.id} className={`nav-item${route===n.id?' active':''}`} onClick={() => setRoute(n.id)} title={n.label}>
              <Icon name={n.icon} size={16} />
              {!collapsed && <span>{n.label}</span>}
            </div>
          ))}
          {!collapsed && <div className="nav-section-label">Team & Tools</div>}
          {NAV.slice(5).map(n => (
            <div key={n.id} className={`nav-item${route===n.id?' active':''}`} onClick={() => setRoute(n.id)} title={n.label}>
              <Icon name={n.icon} size={16} />
              {!collapsed && <span>{n.label}</span>}
            </div>
          ))}
        </nav>

        <div className="sidebar__agent" onClick={() => setAgentSwitcher(true)}>
          {activeAgent && <Avatar agent={activeAgent} size={32} />}
          {!collapsed && activeAgent && (
            <div style={{ flex:1, overflow:'hidden' }}>
              <div className="agent-name">{activeAgent.name}</div>
              <div className="agent-role">{activeAgent.role}</div>
            </div>
          )}
          {!collapsed && <Icon name="chevronDown" size={14} style={{ color:'rgba(255,255,255,0.4)', flexShrink:0 }} />}
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div>
            <div className="topbar__title">{TITLES[route]?.title}</div>
            <div className="topbar__breadcrumb">{TITLES[route]?.crumb}</div>
          </div>
          <div className="topbar__search">
            <Icon name="search" size={14} style={{ color:'var(--gw-mist)' }} />
            <input placeholder="Search contacts, properties, deals…" value={globalSearch} onChange={e => setGlobalSearch(e.target.value)} />
          </div>
          {activeAgent && (
            <div className="topbar__agent-badge" onClick={() => setAgentSwitcher(true)}>
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

        {route === 'dashboard' && <Dashboard {...props} />}
        {route === 'contacts' && <ContactsPage {...props} />}
        {route === 'properties' && <PropertiesPage {...props} />}
        {route === 'pipeline' && <PipelinePage {...props} />}
        {route === 'tasks' && <TasksPage {...props} />}
        {route === 'team' && <TeamPage {...props} onSwitchAgent={id => { setActiveAgentId(id) }} />}
        {route === 'templates' && <TemplatesPage {...props} />}
        {route === 'settings' && <SettingsPage {...props} />}
      </div>

      {compose && <ComposeModal ctx={compose} db={db} activeAgent={activeAgent} onClose={() => setCompose(null)} />}

      {agentSwitcher && (
        <Modal open={true} onClose={() => setAgentSwitcher(false)}>
          <div className="modal__head">
            <div>
              <div className="eyebrow-label">Switch Active Agent</div>
              <h3 style={{ margin:0, fontFamily:'var(--font-display)', fontSize:22 }}>Act as a different teammate</h3>
            </div>
            <button className="drawer__close" onClick={() => setAgentSwitcher(false)}><Icon name="x" size={18} /></button>
          </div>
          <div className="modal__body">
            <p style={{ fontSize:13, color:'var(--gw-mist)', marginTop:0, marginBottom:16 }}>Records and activity will be attributed to the selected agent.</p>
            <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
              {db.agents.map(a => (
                <div key={a.id} onClick={() => { setActiveAgentId(a.id); setAgentSwitcher(false); pushToast(`Now active as ${a.name}`) }}
                  style={{ display:'flex', alignItems:'center', gap:12, padding:12, border:'1px solid var(--gw-border)', cursor:'pointer', background: a.id===activeAgentId?'var(--gw-bone)':'#fff', borderRadius:'var(--radius)', transition:'background 150ms' }}>
                  <Avatar agent={a} size={36} />
                  <div style={{ flex:1 }}>
                    <div style={{ fontWeight:600, fontSize:14 }}>{a.name}</div>
                    <div style={{ fontSize:12, color:'var(--gw-mist)' }}>{a.role} · {a.email}</div>
                  </div>
                  {a.id===activeAgentId && <Badge variant="active">Active</Badge>}
                </div>
              ))}
            </div>
          </div>
        </Modal>
      )}

      <ToastHost />
    </div>
  )
}
