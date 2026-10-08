import React, { useState } from 'react'
import { Icon } from '../../components/UI.jsx'
import { mobileTabsFor, mobileMoreGroups, navRouteFor } from '../navigation.js'

/** The phone's bottom tab bar and its "More" sheet. */
export default function MobileNav({ nav, route, navTo, onSignOut }) {
  const [moreOpen, setMoreOpen] = useState(false)
  // The bottom-nav tab a page belongs to — a deal is part of Pipeline.
  const navRoute = navRouteFor(route)
  const pick = (id) => { navTo(id); setMoreOpen(false) }

  return (
    <>
      <nav className="mobile-nav">
        {mobileTabsFor(nav).map(n => (
          <button key={n.id} className={`mobile-nav__item${navRoute === n.id && !moreOpen ? ' active' : ''}`}
            aria-current={navRoute === n.id ? 'page' : undefined}
            onClick={() => { setMoreOpen(false); navTo(n.id) }}>
            <Icon name={n.icon} size={22} />
            <span>{n.label}</span>
          </button>
        ))}
        <button className={`mobile-nav__item${moreOpen ? ' active' : ''}`}
          onClick={() => setMoreOpen(m => !m)}>
          <Icon name="more" size={22} />
          <span>More</span>
        </button>
      </nav>

      {moreOpen && (
        <div className="mobile-menu-backdrop" onClick={() => setMoreOpen(false)}>
          <div className="mobile-menu" onClick={e => e.stopPropagation()}>
            <div className="mobile-menu__handle" />
            {/* Grouped like the sidebar, so a long list still reads at a glance. */}
            {mobileMoreGroups(nav).map(([label, rows]) => (
              <React.Fragment key={label}>
                <div className="mobile-menu__label">{label}</div>
                {rows.map(n => (
                  <div key={n.id} className={`mobile-menu__item${route === n.id ? ' active' : ''}`}
                    role="button" tabIndex={0}
                    onClick={() => pick(n.id)}
                    onKeyDown={e => { if (e.key === 'Enter') pick(n.id) }}>
                    <Icon name={n.icon} size={20} />
                    <span>{n.label}</span>
                  </div>
                ))}
              </React.Fragment>
            ))}
            <div className="mobile-menu__divider" />
            <div className="mobile-menu__item danger" onClick={() => { setMoreOpen(false); onSignOut() }}>
              <Icon name="logout" size={20} />
              <span>Sign out</span>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
