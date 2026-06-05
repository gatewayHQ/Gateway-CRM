import React from 'react'
import { Icon } from '../components/UI.jsx'

const TOOLKIT_URL = 'https://gatewayhq.github.io/'

export default function ToolkitPage({ activeAgent }) {
  const src = activeAgent?.email
    ? `${TOOLKIT_URL}?agent_email=${encodeURIComponent(activeAgent.email)}&agent_id=${encodeURIComponent(activeAgent.id || '')}`
    : TOOLKIT_URL

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#fff' }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 20px',
                    borderBottom: '1px solid var(--gw-border)', background: 'var(--gw-bone)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Icon name="sparkles" size={16} style={{ color: 'var(--gw-azure)' }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--gw-ink)' }}>Gateway Toolkit</div>
            <div style={{ fontSize: 11, color: 'var(--gw-mist)' }}>OM Generator · Social Media · Marketing Tools</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {activeAgent && (
            <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginRight: 8 }}>
              Logged in as <strong>{activeAgent.name}</strong>
            </div>
          )}
          <a
            href={src}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn--secondary btn--sm"
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <Icon name="eye" size={12} />
            Open in new tab
          </a>
        </div>
      </div>

      {/* Iframe */}
      <iframe
        src={src}
        title="Gateway Toolkit"
        style={{ flex: 1, border: 'none', width: '100%', display: 'block' }}
        sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-top-navigation-by-user-activation"
        loading="lazy"
      />
    </div>
  )
}
