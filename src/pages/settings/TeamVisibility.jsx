import React, { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../lib/supabase.js'
import { Icon, pushToast } from '../../components/UI.jsx'

// ─────────────────────────────────────────────────────────────────────────────
// Team Deal Visibility (admin) — the opt-in override to strict per-deal tagging
// (migration 0024). By default every team is 'off': members see only deals they
// are tagged on. A brokerage-wide default and per-team overrides are configured
// here and resolved by app_team_deal_visibility() as user > team > brokerage.
// ─────────────────────────────────────────────────────────────────────────────
const MODES = [
  { value: 'off', label: 'Strict — tagged deals only (default)' },
  { value: 'all', label: 'See all team deals' },
]

export default function TeamVisibility({ activeAgent }) {
  const [teams, setTeams]       = useState([])
  const [settings, setSettings] = useState([])   // visibility_settings rows
  const [loading, setLoading]   = useState(true)
  const [busy, setBusy]         = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const [t, s] = await Promise.all([
      supabase.from('teams').select('id,name').order('name', { ascending: true }),
      supabase.from('visibility_settings').select('*'),
    ])
    setLoading(false)
    // Degrade silently before migration 0024 (visibility_settings absent).
    if (t.error) { setTeams([]); setSettings([]); return }
    setTeams(t.data || [])
    setSettings(s.data || [])
  }, [])

  useEffect(() => { load() }, [load])

  // Resolve the currently-stored mode for a scope (defaults to 'off').
  const modeFor = (scope, scopeId) => {
    const row = settings.find(r => r.scope === scope && (scopeId ? r.scope_id === scopeId : r.scope_id == null))
    return row?.team_deal_visibility || 'off'
  }

  // Upsert without relying on ON CONFLICT for the null-scope_id (brokerage) row:
  // find the existing row by scope/scope_id and update it, else insert.
  const setMode = async (scope, scopeId, mode) => {
    if (busy) return
    setBusy(true)
    const existing = settings.find(r => r.scope === scope && (scopeId ? r.scope_id === scopeId : r.scope_id == null))
    let error
    if (existing) {
      ;({ error } = await supabase.from('visibility_settings')
        .update({ team_deal_visibility: mode, updated_by: activeAgent?.id || null }).eq('id', existing.id))
    } else {
      ;({ error } = await supabase.from('visibility_settings')
        .insert({ scope, scope_id: scopeId, team_deal_visibility: mode, updated_by: activeAgent?.id || null }))
    }
    setBusy(false)
    if (error) { pushToast(error.message || 'Could not save setting', 'error'); return }
    pushToast('Visibility updated')
    load()
  }

  return (
    <div className="settings-section">
      <div className="settings-section__title">Team Deal Visibility</div>
      <div className="settings-section__sub">
        By default agents see only deals they are tagged on. Turn on “See all team deals” for a team whose
        members should share a pipeline. This never overrides admin access or per-deal tagging elsewhere.
      </div>

      {loading ? (
        <div style={{ fontSize: 13, color: 'var(--gw-mist)' }}>Loading…</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 560 }}>
          {/* Brokerage default */}
          <Row
            title="Brokerage default"
            hint="Applies to any team without its own setting."
            value={modeFor('brokerage', null)}
            onChange={m => setMode('brokerage', null, m)}
            busy={busy} />

          <div style={{ borderTop: '1px solid var(--gw-border)', margin: '4px 0' }} />

          {teams.length === 0 ? (
            <div style={{ fontSize: 12.5, color: 'var(--gw-mist)' }}>No teams configured yet.</div>
          ) : teams.map(t => (
            <Row
              key={t.id}
              title={t.name}
              value={modeFor('team', t.id)}
              onChange={m => setMode('team', t.id, m)}
              busy={busy} />
          ))}
        </div>
      )}
    </div>
  )
}

function Row({ title, hint, value, onChange, busy }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'space-between' }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{title}</div>
        {hint && <div style={{ fontSize: 11.5, color: 'var(--gw-mist)' }}>{hint}</div>}
      </div>
      <select className="form-control" value={value} disabled={busy}
        onChange={e => onChange(e.target.value)} style={{ fontSize: 12.5, padding: '5px 8px', maxWidth: 280 }}>
        {MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
      </select>
    </div>
  )
}
