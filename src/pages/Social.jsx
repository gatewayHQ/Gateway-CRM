import React from 'react'
import { Icon } from '../components/UI.jsx'

export default function SocialPage() {
  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <div className="page-title">Social Media</div>
          <div className="page-sub">Post Generator &amp; Scheduler</div>
        </div>
      </div>
      <div className="empty-state" style={{ marginTop: 40 }}>
        <div className="empty-state__icon">
          <Icon name="social" size={28} />
        </div>
        <div className="empty-state__title">Coming Soon</div>
        <div className="empty-state__msg" style={{ maxWidth: 380 }}>
          The Social Media Generator will create property listings, market updates, and agent spotlights ready to post on Instagram, Facebook, and LinkedIn.
        </div>
        <div style={{ marginTop: 16, display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 16px', background: 'var(--gw-gold-light)', borderRadius: 'var(--radius)', fontSize: 12, fontWeight: 600, color: 'var(--gw-amber)' }}>
          <Icon name="star" size={13} />
          Coming in a future update
        </div>
      </div>
    </div>
  )
}
