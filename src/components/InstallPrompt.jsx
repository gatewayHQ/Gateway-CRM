import React, { useEffect, useState } from 'react'
import { Icon } from './UI.jsx'
import { currentInstallMode, dismissInstall, onInstallChange, promptInstall } from '../lib/pwa.js'

// iOS's Share glyph (square with an up arrow), so the instruction points at
// the exact button the agent has to find in Safari's toolbar.
function ShareGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      style={{ verticalAlign: '-2px', margin: '0 2px' }}>
      <path d="M8 10H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-2" />
      <polyline points="16 6 12 2 8 6" />
      <line x1="12" y1="2" x2="12" y2="15" />
    </svg>
  )
}

/**
 * "Install Gateway CRM" card. Renders nothing when the app is already
 * installed, was dismissed in the last 30 days, or this browser can't install
 * it — see installMode() in src/lib/pwa.js.
 */
export default function InstallPrompt() {
  const [mode, setMode] = useState(currentInstallMode)

  useEffect(() => onInstallChange(() => setMode(currentInstallMode())), [])

  if (!mode) return null

  const install = async () => {
    const accepted = await promptInstall()
    // Declining the native dialog counts as a dismissal, so the card doesn't
    // immediately reappear the next time Chrome offers the prompt.
    if (!accepted) dismissInstall()
  }

  return (
    <div className="install-prompt" role="dialog" aria-label="Install Gateway CRM">
      <img className="install-prompt__icon" src="/icons/icon-192.png" alt="" width="40" height="40" />
      <div className="install-prompt__body">
        <div className="install-prompt__title">Install Gateway CRM</div>
        {mode === 'ios' ? (
          <div className="install-prompt__text">
            Tap <ShareGlyph /> Share, then <strong>Add to Home Screen</strong>.
          </div>
        ) : (
          <div className="install-prompt__text">Opens in one tap, in its own window.</div>
        )}
      </div>
      {mode === 'prompt' && (
        <button type="button" className="btn btn--primary btn--sm install-prompt__cta" onClick={install}>
          Install
        </button>
      )}
      <button type="button" className="install-prompt__close" onClick={dismissInstall} aria-label="Not now">
        <Icon name="x" size={16} />
      </button>
    </div>
  )
}
