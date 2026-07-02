/**
 * Home Valuation Landing — dispatcher.
 *
 * URL: /lp/valuation/:mailingId (demo: /lp/demo/valuation)
 *
 * Fetches the mailing once, then picks a design:
 *   - landing_config.theme === 'dark' → LandingValuationDark (the original
 *     design). Migration 0018 stamped every valuation mailing that existed
 *     before this redesign shipped with theme:'dark', so nothing already
 *     live changes appearance.
 *   - anything else (no theme key) → LandingValuationLight, the new default
 *     for every campaign created from here on.
 */
import React from 'react'
import { StatePanel, Skeleton } from '../components/landing'
import { useMailingLanding } from '../components/landing/data.js'
import LandingValuationDark from './LandingValuationDark.jsx'
import LandingValuationLight from './LandingValuationLight.jsx'
import '../components/landing/landing.css'

export default function LandingValuation({ mailingId, preview }) {
  const { loading, notFound, cfg, agents } = useMailingLanding(mailingId, preview)

  if (loading) return (
    <div className="lx-root" style={{ minHeight: '100vh', padding: 'clamp(18px,5vw,40px)' }}>
      <Skeleton h={44} w={280} style={{ marginBottom: 24 }} />
      <Skeleton h={320} style={{ marginBottom: 16 }} />
      <Skeleton h={180} w="60%" />
    </div>
  )
  if (notFound) return (
    <div className="lx-root" style={{ minHeight: '100vh' }}>
      <StatePanel title="Page not found" message="This valuation page is no longer available. Reach out to Gateway Real Estate Advisors directly and we'll take care of you." />
    </div>
  )

  return cfg.theme === 'dark'
    ? <LandingValuationDark  cfg={cfg} agents={agents} mailingId={mailingId} />
    : <LandingValuationLight cfg={cfg} agents={agents} mailingId={mailingId} preview={preview} />
}
