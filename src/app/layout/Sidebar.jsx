import React from 'react'
import { Icon, Avatar, BrandLogo } from '../../components/UI.jsx'
import { TOOLS_IDS } from '../navigation.js'
import NavItem from './NavItem.jsx'

export default function Sidebar({
  nav, route, navTo, isAdmin, activeAgent,
  collapsed, onToggleCollapsed, toolsOpen, onToggleTools,
}) {
  const isActive = (id) => route === id
  return (
    <aside className={`sidebar${collapsed ? ' collapsed' : ''}`}>
      <div className="sidebar__brand">
        <button
          type="button"
          className="sidebar__brand-mark"
          onClick={() => navTo('dashboard')}
          title="Dashboard"
          aria-label="The Wolf CRM — go to dashboard"
        >
          <BrandLogo size={72} />
        </button>
        {!collapsed && (
          <div className="sidebar__brand-text">
            <div className="sidebar__wordmark">Gateway</div>
            <div className="sidebar__sub">Real Estate Advisors</div>
          </div>
        )}
        <button className="sidebar__collapse" onClick={onToggleCollapsed} title={collapsed ? 'Expand' : 'Collapse'}>
          <Icon name={collapsed ? 'chevronRight' : 'chevronLeft'} size={16} />
        </button>
      </div>

      <nav className="sidebar__nav" aria-label="Main navigation">
        {/* ── Core ── An admin's Contacts and Pipeline span the whole firm. */}
        {nav.core.map(n => (
          <NavItem key={n.id} item={n} collapsed={collapsed} onSelect={navTo}
            active={isActive(n.id) || (n.id === 'pipeline' && route.startsWith('deal/'))}>
            {isAdmin && (n.id === 'pipeline' || n.id === 'contacts') && !collapsed && (
              <span style={{ marginLeft: 'auto', fontSize: 9, fontWeight: 700, background: 'rgba(255,255,255,0.15)', color: '#fff', padding: '1px 5px', borderRadius: 6, letterSpacing: '0.05em' }}>ALL</span>
            )}
          </NavItem>
        ))}

        {/* ── Office ── */}
        {!collapsed && <div className="nav-section-label" style={{ marginTop: 8 }}>Office</div>}
        {collapsed && <div className="nav-section-divider" />}
        {nav.office.map(n => (
          <NavItem key={n.id} item={n} collapsed={collapsed} onSelect={navTo} active={isActive(n.id)} />
        ))}

        {/* ── Marketing & Tools (collapsible) ── */}
        {collapsed ? (
          <div className="nav-section-divider" />
        ) : (
          <button
            className={`nav-group-toggle${TOOLS_IDS.includes(route) ? ' has-active' : ''}${toolsOpen ? ' open' : ''}`}
            onClick={onToggleTools}
            aria-expanded={toolsOpen}
            title={toolsOpen ? 'Collapse Marketing & Tools' : 'Expand Marketing & Tools'}
          >
            <span>Marketing &amp; Tools</span>
            <span className="nav-group-toggle__badge">{nav.tools.length}</span>
            <Icon name={toolsOpen ? 'chevronDown' : 'chevronRight'} size={11} style={{ marginLeft: 'auto', flexShrink: 0 }} />
          </button>
        )}
        {(toolsOpen || collapsed) && nav.tools.map(n => (
          <NavItem key={n.id} item={n} collapsed={collapsed} onSelect={navTo} active={isActive(n.id)}
            className={!collapsed ? ' nav-item--indented' : ''}>
            {n.id === 'toolkit' && !collapsed && (
              <Icon name="eye" size={11} style={{ marginLeft: 'auto', flexShrink: 0, opacity: 0.5 }} />
            )}
          </NavItem>
        ))}
      </nav>

      {/* ── Admin — pinned above agent profile ── */}
      <div className="sidebar__bottom">
        {nav.admin.map(n => (
          <NavItem key={n.id} item={n} collapsed={collapsed} onSelect={navTo} active={isActive(n.id)}
            className=" nav-item--admin" />
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
  )
}
