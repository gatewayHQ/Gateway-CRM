import React, { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'
import { Icon, Badge, Avatar, EmptyState, pushToast } from '../components/UI.jsx'
import { formatDate } from '../lib/helpers.js'

function StatCard({ label, value, sub }) {
  return (
    <div className="card">
      <div className="card__label">{label}</div>
      <div className="card__value">{value}</div>
      {sub && <div className="card__sub">{sub}</div>}
    </div>
  )
}

export default function LeadsPage({ db }) {
  const [tab, setTab] = useState('visitors')
  const [events, setEvents] = useState([])
  const [captures, setCaptures] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [converting, setConverting] = useState(null)

  useEffect(() => {
    load()
  }, [])

  const load = async () => {
    setLoading(true)
    const [ev, cap] = await Promise.all([
      supabase.from('visitor_events').select('*').order('created_at', { ascending: false }),
      supabase.from('lead_captures').select('*').order('created_at', { ascending: false }),
    ])
    if (ev.error || cap.error) {
      setError('Tables not set up yet. Run the SQL schema in Supabase to enable this feature.')
    } else {
      setEvents(ev.data || [])
      setCaptures(cap.data || [])
    }
    setLoading(false)
  }

  const addToContacts = async (capture) => {
    if (capture.converted_contact_id) return
    setConverting(capture.id)
    const { data, error } = await supabase.from('contacts').insert([{
      first_name: capture.first_name,
      last_name: capture.last_name,
      email: capture.email,
      phone: capture.phone || null,
      type: 'buyer',
      status: 'active',
      source: 'website',
      notes: [
        capture.property_address ? `Interested in: ${capture.property_address}` : '',
        capture.message ? `Message: ${capture.message}` : '',
      ].filter(Boolean).join('\n'),
      assigned_agent_id: capture.agent_id || null,
    }]).select().single()
    if (!error && data) {
      await supabase.from('lead_captures').update({ converted_contact_id: data.id }).eq('id', capture.id)
      setCaptures(prev => prev.map(c => c.id === capture.id ? { ...c, converted_contact_id: data.id } : c))
      pushToast(`${capture.first_name} added to Contacts`)
    } else {
      pushToast('Failed to add contact', 'error')
    }
    setConverting(null)
  }

  // Aggregate visitor events by session_key
  const sessions = Object.values(
    events.reduce((acc, e) => {
      if (!acc[e.session_key]) {
        acc[e.session_key] = { session_key: e.session_key, agent_id: e.agent_id, events: [], properties: new Set() }
      }
      acc[e.session_key].events.push(e)
      if (e.property_address) acc[e.session_key].properties.add(e.property_address)
      return acc
    }, {})
  ).sort((a, b) => new Date(b.events[0].created_at) - new Date(a.events[0].created_at))

  const hotSessions = sessions.filter(s => s.events.length >= 3)
  const identifiedLeads = captures.length

  const tabStyle = (t) => ({
    padding: '8px 18px', border: 'none', borderRadius: 'var(--radius)', cursor: 'pointer',
    fontFamily: 'var(--font-body)', fontSize: 13, fontWeight: 600,
    background: tab === t ? 'var(--gw-slate)' : 'transparent',
    color: tab === t ? '#fff' : 'var(--gw-mist)',
    transition: 'all 150ms ease',
  })

  if (loading) return <div className="page-content"><div className="loading"><div className="spinner" /> Loading…</div></div>

  if (error) return (
    <div className="page-content">
      <div className="page-header"><div><div className="page-title">Website Leads</div></div></div>
      <div style={{ background: 'var(--gw-amber-light)', border: '1px solid var(--gw-amber)', borderRadius: 'var(--radius-lg)', padding: 24 }}>
        <div style={{ fontWeight: 600, marginBottom: 8, color: 'var(--gw-amber)' }}>Database Setup Required</div>
        <div style={{ fontSize: 13, marginBottom: 12 }}>{error}</div>
        <div style={{ fontSize: 12, color: 'var(--gw-mist)' }}>Go to Settings → Website Integration to find the SQL and setup instructions.</div>
      </div>
    </div>
  )

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <div className="page-title">Website Leads</div>
          <div className="page-sub">{sessions.length} visitor sessions · {identifiedLeads} captured leads</div>
        </div>
        <button className="btn btn--secondary btn--sm" onClick={load}><Icon name="refresh" size={13} /> Refresh</button>
      </div>

      <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(3,1fr)', marginBottom: 20 }}>
        <StatCard label="Unique Visitors" value={sessions.length} sub="Anonymous sessions" />
        <StatCard label="Hot Prospects" value={hotSessions.length} sub="Viewed 3+ times" />
        <StatCard label="Captured Leads" value={identifiedLeads} sub="Submitted contact form" />
      </div>

      <div style={{ display: 'flex', gap: 4, marginBottom: 16, background: 'var(--gw-bone)', borderRadius: 'var(--radius)', padding: 4, width: 'fit-content' }}>
        <button style={tabStyle('visitors')} onClick={() => setTab('visitors')}>Visitor Sessions ({sessions.length})</button>
        <button style={tabStyle('captures')} onClick={() => setTab('captures')}>Captured Leads ({identifiedLeads})</button>
      </div>

      {tab === 'visitors' && (
        sessions.length === 0
          ? <EmptyState icon="eye" title="No visitors yet" message="Once you add the tracking script to your website, visitor sessions will appear here." />
          : <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <div className="data-table-wrap">
              <table className="data-table">
                <thead><tr>
                  <th>Session</th><th>Property Viewed</th><th>Views</th><th>Agent</th><th>Last Seen</th>
                </tr></thead>
                <tbody>
                  {sessions.map(s => {
                    const agent = db.agents.find(a => a.id === s.agent_id)
                    const isHot = s.events.length >= 3
                    return (
                      <tr key={s.session_key}>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <div style={{ width: 8, height: 8, borderRadius: '50%', background: isHot ? 'var(--gw-red)' : 'var(--gw-border)', flexShrink: 0 }} />
                            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--gw-mist)' }}>{s.session_key.slice(0, 10)}…</span>
                            {isHot && <Badge variant="high">Hot</Badge>}
                          </div>
                        </td>
                        <td>
                          {[...s.properties].map((p, i) => (
                            <div key={i} style={{ fontSize: 12 }}>{p}</div>
                          ))}
                        </td>
                        <td><strong>{s.events.length}</strong></td>
                        <td>{agent ? <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Avatar agent={agent} size={22} /><span style={{ fontSize: 12 }}>{agent.name}</span></div> : <span style={{ color: 'var(--gw-mist)', fontSize: 12 }}>—</span>}</td>
                        <td style={{ fontSize: 12, color: 'var(--gw-mist)' }}>{formatDate(s.events[0].created_at)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              </div>
            </div>
      )}

      {tab === 'captures' && (
        captures.length === 0
          ? <EmptyState icon="mail" title="No leads captured yet" message="When someone fills out the lead form on your website, they'll appear here." />
          : <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <div className="data-table-wrap">
              <table className="data-table">
                <thead><tr>
                  <th>Name</th><th>Email</th><th>Phone</th><th>Property</th><th>Agent</th><th>Date</th><th></th>
                </tr></thead>
                <tbody>
                  {captures.map(c => {
                    const agent = db.agents.find(a => a.id === c.agent_id)
                    return (
                      <tr key={c.id}>
                        <td><strong>{c.first_name} {c.last_name}</strong></td>
                        <td style={{ fontSize: 12 }}>{c.email}</td>
                        <td style={{ fontSize: 12 }}>{c.phone || '—'}</td>
                        <td style={{ fontSize: 12 }}>{c.property_address || '—'}</td>
                        <td>{agent ? <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Avatar agent={agent} size={22} /><span style={{ fontSize: 12 }}>{agent.name}</span></div> : '—'}</td>
                        <td style={{ fontSize: 12, color: 'var(--gw-mist)' }}>{formatDate(c.created_at)}</td>
                        <td>
                          {c.converted_contact_id
                            ? <span style={{ fontSize: 11, color: 'var(--gw-green)', fontWeight: 600 }}>✓ In CRM</span>
                            : <button className="btn btn--primary btn--sm" disabled={converting === c.id} onClick={() => addToContacts(c)}>
                                {converting === c.id ? 'Adding…' : 'Add to CRM'}
                              </button>
                          }
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              </div>
            </div>
      )}
    </div>
  )
}
