/**
 * Landing kit — shared data plumbing for campaign landing pages.
 *
 * Every /lp/* page needs the same three things: the mailing row (for
 * landing_config), the resolved advisor list (primary agent + co-agents with
 * per-mailing overrides), and a way to submit a captured lead. Pages also all
 * support a `preview` prop ({ config, agents }) that skips the network so the
 * /lp/demo/* routes and builder previews render without DB rows.
 */
import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase.js'

/** Load mailing + advisors. Returns { loading, notFound, mailing, cfg, agents }. */
export function useMailingLanding(mailingId, preview) {
  const [state, setState] = useState(() => preview
    ? { loading: false, notFound: false, mailing: null, cfg: preview.config || {}, agents: preview.agents || [] }
    : { loading: true, notFound: false, mailing: null, cfg: {}, agents: [] })

  useEffect(() => {
    if (preview) return
    let alive = true
    ;(async () => {
      const { data: m } = await supabase
        .from('mailings')
        .select('id, name, agent_id, landing_config')
        .eq('id', mailingId).maybeSingle()
      if (!alive) return
      if (!m) { setState(s => ({ ...s, loading: false, notFound: true })); return }

      // Advisor list: primary agent first, then co-agents from
      // landing_config.agent_ids; per-mailing agent_overrides win over profile.
      const cfg = m.landing_config || {}
      const ids = [...new Set(
        [m.agent_id, ...(Array.isArray(cfg.agent_ids) ? cfg.agent_ids : [])].filter(Boolean)
      )]
      let agents = []
      if (ids.length) {
        let { data: rows, error: agErr } = await supabase.from('agents')
          .select('id, name, phone, email, photo_url, color, role, bio')
          .in('id', ids)
        if (agErr) {
          // pre-0004 installs don't have the bio column
          ;({ data: rows } = await supabase.from('agents')
            .select('id, name, phone, email, photo_url, color, role')
            .in('id', ids))
        }
        const overrides = cfg.agent_overrides || {}
        agents = ids
          .map(id => (rows || []).find(r => r.id === id))
          .filter(Boolean)
          .map(r => ({ ...r, ...(overrides[r.id] || {}) }))
      }
      if (alive) setState({ loading: false, notFound: false, mailing: m, cfg, agents })
    })()
    return () => { alive = false }
  }, [mailingId, preview])

  return state
}

/**
 * Submit a captured lead to /api/campaigns. Throws on failure so the kit's
 * form components can render their error state. Preview mode fakes latency.
 */
export async function submitCampaignLead(mailingId, sourceLanding, form, { preview } = {}) {
  if (preview) { await new Promise(r => setTimeout(r, 700)); return }
  const res = await fetch('/api/campaigns', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'capture_lead', mailing_id: mailingId, source_landing: sourceLanding, ...form }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.error) throw new Error(data.error || 'Could not submit — please try again')
}
