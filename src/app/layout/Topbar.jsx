import React from 'react'
import { Icon, Avatar, BrandLogo } from '../../components/UI.jsx'
import { IconButton } from '../../components/ui/index.js'
import GlobalSearch from '../../components/GlobalSearch.jsx'

export default function Topbar({ pageTitle, onHome, search, activeAgent, bell, onSignOut, onHelp }) {
  return (
    <header className="topbar">
      {/* The sidebar — and with it the brand slot — is hidden under 768px,
          so the seal moves into the top-left of the bar on phones. */}
      <button
        type="button"
        className="topbar__brand"
        onClick={onHome}
        title="Dashboard"
        aria-label="The Wolf CRM — go to dashboard"
      >
        <BrandLogo size={40} />
      </button>
      <div>
        <div className="topbar__title">{pageTitle.title}</div>
        <div className="topbar__breadcrumb">{pageTitle.crumb}</div>
      </div>
      <GlobalSearch {...search} />
      {activeAgent && (
        <div className="topbar__agent-badge">
          <Avatar agent={activeAgent} size={30} />
          <div>
            <div className="label">Active Agent</div>
            <div className="name">{activeAgent.name}</div>
          </div>
        </div>
      )}
      {onHelp && <IconButton icon="help" label="Help for this page" onClick={onHelp} className="topbar__help" />}
      {bell}
      <button className="btn btn--ghost btn--icon" onClick={onSignOut} title="Sign out" style={{ marginLeft: 4 }}>
        <Icon name="logout" size={16} />
      </button>
    </header>
  )
}
