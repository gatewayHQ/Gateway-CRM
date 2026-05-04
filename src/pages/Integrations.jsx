import React, { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase.js'
import { Icon, pushToast } from '../components/UI.jsx'
import { WEBHOOK_EVENTS } from '../lib/webhooks.js'

// ─── Geocode helpers (shared with Properties radius tool) ────────────────────

async function geocodeAddress(address) {
  const q = encodeURIComponent(address)
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${q}`,
      { headers: { 'User-Agent': 'GatewayCRM/1.0 (internal brokerage tool)' } }
    )
    const data = await r.json()
    return data[0] ? { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) } : null
  } catch {
    return null
  }
}

// ─── Mailchimp tab ────────────────────────────────────────────────────────────

function MailchimpSection() {
  const [apiKey, setApiKey]     = useState('')
  const [listId, setListId]     = useState('')
  const [lists, setLists]       = useState([])
  const [showKey, setShowKey]   = useState(false)
  const [status, setStatus]     = useState('idle')   // idle | testing | connected | error
  const [errMsg, setErrMsg]     = useState('')
  const [saved, setSaved]       = useState(false)
  const [geocoding, setGeocoding] = useState(false)
  const [geoProgress, setGeoProgress] = useState(null) // { done, total }

  // Load saved config on mount
  useEffect(() => {
    supabase.from('integrations').select('config').eq('type', 'mailchimp').single()
      .then(({ data }) => {
        if (data?.config?.api_key) {
          setApiKey(data.config.api_key)
          setListId(data.config.list_id || '')
          setStatus('connected')
        }
      })
  }, [])

  const testConnect = async () => {
    if (!apiKey.trim()) { pushToast('Enter your Mailchimp API key', 'error'); return }
    setStatus('testing'); setErrMsg('')
    try {
      const res = await fetch('/api/mailchimp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'getLists', apiKey: apiKey.trim() }),
      })
      const data = await res.json()
      if (!res.ok) { setStatus('error'); setErrMsg(data.error || 'Invalid API key'); return }
      setLists(data.lists || [])
      if (!listId && data.lists?.length) setListId(data.lists[0].id)
      setStatus('connected')
      pushToast(`Connected — ${data.lists?.length} audience${data.lists?.length !== 1 ? 's' : ''} found`)
    } catch (err) {
      setStatus('error'); setErrMsg(err.message)
    }
  }

  const save = async () => {
    const { error } = await supabase.from('integrations').upsert(
      { type: 'mailchimp', config: { api_key: apiKey.trim(), list_id: listId }, active: true, updated_at: new Date().toISOString() },
      { onConflict: 'type' }
    )
    if (error) { pushToast(error.message, 'error'); return }
    setSaved(true); pushToast('Mailchimp settings saved')
    setTimeout(() => setSaved(false), 3000)
  }

  // Batch geocode all properties that are missing lat/lng
  const geocodeAll = async () => {
    const { data: props } = await supabase.from('properties')
      .select('id, address, city, state, zip')
      .or('lat.is.null,lng.is.null')
    if (!props?.length) { pushToast('All properties are already geocoded ✓'); return }

    setGeocoding(true)
    setGeoProgress({ done: 0, total: props.length })
    let done = 0

    for (const p of props) {
      const addr = [p.address, p.city, p.state, p.zip].filter(Boolean).join(', ')
      const coords = await geocodeAddress(addr)
      if (coords) {
        await supabase.from('properties').update({ lat: coords.lat, lng: coords.lng }).eq('id', p.id)
      }
      done++
      setGeoProgress({ done, total: props.length })
      // Nominatim rate limit: 1 request/sec
      if (done < props.length) await new Promise(r => setTimeout(r, 1100))
    }

    setGeocoding(false)
    setGeoProgress(null)
    pushToast(`Geocoded ${done} properties ✓`)
  }

  const dotColor = { idle: 'var(--gw-mist)', testing: 'var(--gw-azure)', connected: 'var(--gw-green)', error: 'var(--gw-red)' }
  const dotLabel = { idle: 'Not connected', testing: 'Testing…', connected: 'Connected', error: 'Connection error' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* API key card */}
      <div className="card" style={{ padding: 24, maxWidth: 560 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
              <img src="https://cdn.jsdelivr.net/gh/simple-icons/simple-icons/icons/mailchimp.svg" alt="" style={{ width: 18, opacity: 0.8 }} />
              Mailchimp
            </div>
            <div style={{ fontSize: 12, color: 'var(--gw-mist)', marginTop: 2 }}>
              Sync contacts to email audiences for radius mailings
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: dotColor[status] }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: dotColor[status] }} />
            {dotLabel[status]}
          </div>
        </div>

        <div className="form-group">
          <label className="form-label">API Key</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1, position: 'relative' }}>
              <input
                className="form-control"
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={e => { setApiKey(e.target.value); if (status !== 'idle') setStatus('idle') }}
                placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx-us6"
                style={{ paddingRight: 36, fontFamily: showKey ? 'var(--font-mono)' : undefined, fontSize: showKey ? 11 : undefined }}
              />
              <button
                onClick={() => setShowKey(s => !s)}
                style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--gw-mist)', padding: 2 }}
                title={showKey ? 'Hide key' : 'Show key'}
              >
                <Icon name={showKey ? 'eye' : 'eye'} size={14} />
              </button>
            </div>
            <button
              className={`btn btn--${status === 'connected' ? 'secondary' : 'primary'}`}
              onClick={testConnect}
              disabled={status === 'testing'}
            >
              {status === 'testing' ? 'Testing…' : status === 'connected' ? 'Re-test' : 'Connect'}
            </button>
          </div>
          {errMsg && <div style={{ fontSize: 12, color: 'var(--gw-red)', marginTop: 4 }}>{errMsg}</div>}
          <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginTop: 4 }}>
            Mailchimp → Account → Extras → API Keys → Create A Key
          </div>
        </div>

        {status === 'connected' && lists.length > 0 && (
          <div className="form-group">
            <label className="form-label">Default Audience</label>
            <select className="form-control" value={listId} onChange={e => setListId(e.target.value)}>
              {lists.map(l => (
                <option key={l.id} value={l.id}>
                  {l.name}{l.stats?.member_count ? ` (${l.stats.member_count.toLocaleString()} contacts)` : ''}
                </option>
              ))}
            </select>
            <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginTop: 4 }}>
              Default audience used when syncing radius mailings from the Properties page
            </div>
          </div>
        )}

        {status === 'connected' && (
          <button className="btn btn--primary" onClick={save} style={{ minWidth: 120 }}>
            {saved ? '✓ Saved' : 'Save Settings'}
          </button>
        )}
      </div>

      {/* Geocoding card */}
      <div className="card" style={{ padding: 24, maxWidth: 560 }}>
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 4 }}>Property Geocoding</div>
          <div style={{ fontSize: 12, color: 'var(--gw-mist)', lineHeight: 1.5 }}>
            Radius mailing uses GPS coordinates to find nearby properties. Run this once to geocode
            all existing properties. New properties geocode automatically when saved.
          </div>
        </div>

        {geoProgress ? (
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
              <span>Geocoding properties…</span>
              <span>{geoProgress.done} / {geoProgress.total}</span>
            </div>
            <div style={{ height: 6, background: 'var(--gw-border)', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{
                height: '100%', borderRadius: 3, background: 'var(--gw-azure)',
                width: `${Math.round(geoProgress.done / geoProgress.total * 100)}%`,
                transition: 'width 400ms ease',
              }} />
            </div>
            <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginTop: 6 }}>
              ~1 second per property (OpenStreetMap rate limit)
            </div>
          </div>
        ) : (
          <button className="btn btn--secondary" onClick={geocodeAll} disabled={geocoding}>
            <Icon name="building" size={13} /> Geocode All Properties
          </button>
        )}
      </div>
    </div>
  )
}

// ─── Webhook row ──────────────────────────────────────────────────────────────

function WebhookRow({ webhook, onToggle, onDelete, onTest }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '14px 0', borderBottom: '1px solid var(--gw-border)' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>{webhook.name}</div>
        <div style={{ fontSize: 11, color: 'var(--gw-azure)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 380, marginBottom: 8 }}>
          {webhook.url}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {(webhook.events || []).map(evId => {
            const ev = WEBHOOK_EVENTS.find(e => e.id === evId)
            return (
              <span key={evId} style={{ fontSize: 10, fontWeight: 600, background: 'var(--gw-sky)', color: 'var(--gw-azure)', padding: '2px 8px', borderRadius: 10 }}>
                {ev?.label || evId}
              </span>
            )
          })}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, marginTop: 2 }}>
        <button className="btn btn--secondary btn--sm" style={{ fontSize: 11 }} onClick={() => onTest(webhook)}>
          Test
        </button>
        <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', fontSize: 12, userSelect: 'none' }}>
          <input type="checkbox" checked={webhook.active} onChange={() => onToggle(webhook)} />
          Active
        </label>
        <button className="btn btn--ghost btn--icon btn--sm" onClick={() => onDelete(webhook.id)} style={{ color: 'var(--gw-red)' }}>
          <Icon name="trash" size={13} />
        </button>
      </div>
    </div>
  )
}

// ─── Add webhook form ─────────────────────────────────────────────────────────

function AddWebhookForm({ onAdd, onCancel }) {
  const [name, setName]     = useState('')
  const [url, setUrl]       = useState('')
  const [events, setEvents] = useState([])
  const [saving, setSaving] = useState(false)

  const toggle = id => setEvents(p => p.includes(id) ? p.filter(e => e !== id) : [...p, id])

  const save = async () => {
    if (!name.trim())                        { pushToast('Enter a webhook name', 'error'); return }
    if (!url.trim() || !url.startsWith('http')) { pushToast('Enter a valid URL starting with http', 'error'); return }
    if (!events.length)                      { pushToast('Select at least one trigger event', 'error'); return }
    setSaving(true)
    const { data, error } = await supabase
      .from('webhook_configs')
      .insert([{ name: name.trim(), url: url.trim(), events, active: true }])
      .select()
      .single()
    setSaving(false)
    if (error) { pushToast(error.message, 'error'); return }
    onAdd(data)
    pushToast('Webhook added')
  }

  return (
    <div style={{ background: 'var(--gw-bone)', border: '1px solid var(--gw-border)', borderRadius: 'var(--radius)', padding: 20, marginBottom: 16 }}>
      <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 16 }}>Add Webhook</div>

      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Name</label>
          <input className="form-control" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Zapier — New Contact" />
        </div>
      </div>

      <div className="form-group">
        <label className="form-label">Webhook URL</label>
        <input className="form-control" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://hooks.zapier.com/hooks/catch/..." style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }} />
      </div>

      <div className="form-group">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <label className="form-label" style={{ margin: 0 }}>Trigger Events</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn--ghost btn--sm" style={{ fontSize: 11 }} onClick={() => setEvents(WEBHOOK_EVENTS.map(e => e.id))}>Select all</button>
            <button className="btn btn--ghost btn--sm" style={{ fontSize: 11 }} onClick={() => setEvents([])}>Clear</button>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {WEBHOOK_EVENTS.map(ev => (
            <label key={ev.id} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, cursor: 'pointer', userSelect: 'none' }}>
              <input type="checkbox" checked={events.includes(ev.id)} onChange={() => toggle(ev.id)} />
              {ev.label}
            </label>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <button className="btn btn--primary" onClick={save} disabled={saving}>{saving ? 'Adding…' : 'Add Webhook'}</button>
        <button className="btn btn--secondary" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

// ─── Webhooks tab ─────────────────────────────────────────────────────────────

function WebhooksSection() {
  const [webhooks, setWebhooks] = useState([])
  const [loading, setLoading]   = useState(true)
  const [adding, setAdding]     = useState(false)

  useEffect(() => {
    supabase.from('webhook_configs').select('*').order('created_at', { ascending: true })
      .then(({ data }) => { setWebhooks(data || []); setLoading(false) })
  }, [])

  const toggle = useCallback(async (wh) => {
    await supabase.from('webhook_configs').update({ active: !wh.active }).eq('id', wh.id)
    setWebhooks(p => p.map(w => w.id === wh.id ? { ...w, active: !wh.active } : w))
  }, [])

  const del = useCallback(async (id) => {
    await supabase.from('webhook_configs').delete().eq('id', id)
    setWebhooks(p => p.filter(w => w.id !== id))
    pushToast('Webhook deleted', 'info')
  }, [])

  const test = useCallback(async (wh) => {
    try {
      await fetch(wh.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'test',
          timestamp: new Date().toISOString(),
          source: 'gateway-crm',
          data: { message: 'Test webhook from Gateway CRM ✓' },
        }),
      })
      pushToast(`Test sent to "${wh.name}"`)
    } catch {
      pushToast(`Could not reach "${wh.name}"`, 'error')
    }
  }, [])

  const add = useCallback((wh) => { setWebhooks(p => [...p, wh]); setAdding(false) }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Webhooks card */}
      <div className="card" style={{ padding: 24, maxWidth: 680 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 16 }}>Outbound Webhooks</div>
            <div style={{ fontSize: 12, color: 'var(--gw-mist)', marginTop: 2 }}>
              Fire real-time events to Zapier, Make, or any HTTP endpoint when CRM actions happen
            </div>
          </div>
          <button className="btn btn--primary btn--sm" onClick={() => setAdding(a => !a)}>
            <Icon name="plus" size={13} /> Add Webhook
          </button>
        </div>

        {adding && <div style={{ marginTop: 16 }}><AddWebhookForm onAdd={add} onCancel={() => setAdding(false)} /></div>}

        {loading ? (
          <div style={{ padding: '24px 0', color: 'var(--gw-mist)', fontSize: 13, textAlign: 'center' }}>Loading…</div>
        ) : webhooks.length === 0 && !adding ? (
          <div style={{ padding: '28px 0', textAlign: 'center', color: 'var(--gw-mist)', fontSize: 13 }}>
            No webhooks yet. Add one to connect Zapier, Make.com, or any automation tool.
          </div>
        ) : (
          webhooks.map(wh => (
            <WebhookRow key={wh.id} webhook={wh} onToggle={toggle} onDelete={del} onTest={test} />
          ))
        )}
      </div>

      {/* Payload reference card */}
      <div className="card" style={{ padding: 24, maxWidth: 680 }}>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10 }}>Payload Format</div>
        <div style={{ fontSize: 12, color: 'var(--gw-mist)', marginBottom: 10 }}>
          Every webhook fires a POST with <code style={{ background: 'var(--gw-bone)', padding: '1px 5px', borderRadius: 3, fontFamily: 'var(--font-mono)' }}>Content-Type: application/json</code>
        </div>
        <pre style={{ background: 'var(--gw-bone)', padding: 14, borderRadius: 'var(--radius)', fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.6, margin: 0, overflowX: 'auto' }}>{`{
  "event":     "deal.stage_changed",
  "timestamp": "2025-06-01T14:30:00.000Z",
  "source":    "gateway-crm",
  "data": {
    "id":    "uuid",
    "title": "123 Main St Purchase",
    "stage": "under-contract",
    ...
  }
}`}</pre>

        <div style={{ marginTop: 16 }}>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Zapier Quick Start</div>
          <ol style={{ fontSize: 12, color: 'var(--gw-mist)', paddingLeft: 18, lineHeight: 1.8, margin: 0 }}>
            <li>Create a new Zap → Trigger: <strong>Webhooks by Zapier</strong> → Catch Hook</li>
            <li>Copy the webhook URL from Zapier and paste it above</li>
            <li>Select the events you want to trigger the Zap</li>
            <li>Click <strong>Test</strong> to send a sample payload to Zapier</li>
            <li>Build your Zap action (Mailchimp, Slack, Google Sheets, etc.)</li>
          </ol>
        </div>
      </div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function IntegrationsPage() {
  const [tab, setTab] = useState('mailchimp')

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <div className="page-title">Integrations</div>
          <div className="page-sub">Connect Mailchimp, Zapier, and external automation tools</div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 24, flexWrap: 'wrap' }}>
        {[
          ['mailchimp', 'Mailchimp'],
          ['webhooks',  'Zapier / Webhooks'],
        ].map(([id, label]) => (
          <button key={id} className={`btn btn--${tab === id ? 'primary' : 'secondary'}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'mailchimp' && <MailchimpSection />}
      {tab === 'webhooks'  && <WebhooksSection />}
    </div>
  )
}
