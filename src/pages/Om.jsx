import React from 'react'
import { Icon } from '../components/UI.jsx'

export default function OmPage() {
  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <div className="page-title">OM Generator</div>
          <div className="page-sub">Offering Memorandum Builder</div>
        </div>
      </div>
      <div className="empty-state" style={{ marginTop: 40 }}>
        <div className="empty-state__icon">
          <Icon name="om" size={28} />
        </div>
        <div className="empty-state__title">Coming Soon</div>
        <div className="empty-state__msg" style={{ maxWidth: 380 }}>
          The OM Generator will let you build professional offering memorandums from your property listings.
          This feature is under development.
        </div>
        <div style={{ marginTop: 16, display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 16px', background: 'var(--gw-gold-light)', borderRadius: 'var(--radius)', fontSize: 12, fontWeight: 600, color: 'var(--gw-amber)' }}>
          <Icon name="star" size={13} />
          Coming in a future update
        </div>
      </div>
    </div>
  )
}
