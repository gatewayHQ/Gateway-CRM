import React, { useState, useEffect } from 'react'
import { upsertContactRecord } from '../lib/services/contactRecords.js'
import { fetchVisitorEvents, fetchLeadCaptures, fetchRecentLeadInquiries, linkLeadCaptureToContact } from '../lib/services/leads.js'
import { Icon, Badge, Avatar, EmptyState, pushToast } from '../components/UI.jsx'
import { formatDate } from '../lib/helpers.js'
import { searchSummary } from '../lib/dripTokens.js'
import RoundRobinPanel from './leads/RoundRobinPanel.jsx'

const DRIP_LABEL = { enrolled: 'Drip started', skipped: 'No auto-start drip', pending: 'Pending' }

/** The criteria the website posted, as one readable line. */
function criteriaLine(c = {}) {
  return searchSummary({
    bedsMin: c.beds_min, bathsMin: c.baths_min, priceMin: c.price_min, priceMax: c.price_max, area: c.area,
  })
}

function StatCard({ label, value, sub }) {
  return (
    <div className="card">
      <div className="card__label">{label}</div>
      <div className="card__value">{value}</div>
      {sub && <div className="card__sub">{sub}</div>}
    </div>
  )
}

export default function LeadsPage({ db, isAdmin }) {
  const [tab, setTab] = useState('inquiries')
  const [inquiries, setInquiries] = useState(null)   // null = leads table missing
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
    // The round-robin inquiries (migration 0037). Loaded on their own so a
    // database without the legacy capture tables still shows them.
    const [ev, cap, inq] = await Promise.all([
      fetchVisitorEvents(),
      fetchLeadCaptures(),
      fetchRecentLeadInquiries(),
    ])
    setInquiries(inq.error ? null : (inq.data || []))
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
    // Route through upsertContact so converting a capture for someone already
    // in the database updates them instead of creating a second row.
    const { contact: data, created, error } = await upsertContactRecord({
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
    }, db?.contacts || [])
    if (!error && data) {
      await linkLeadCaptureToContact(capture.id, data.id)
      setCaptures(prev => prev.map(c => c.id === capture.id ? { ...c, converted_contact_id: data.id } : c))
      pushToast(created ? `${capture.first_name} added to Contacts` : `${capture.first_name} already existed — capture linked to their record`)
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

  if (error && !inquiries) return (
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
          <div className="page-sub">{inquiries?.length || 0} inquiries · {sessions.length} visitor sessions · {identifiedLeads} landing-page captures</div>
        </div>
        <button className="btn btn--secondary btn--sm" onClick={load}><Icon name="refresh" size={13} /> Refresh</button>
      </div>

      <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(3,1fr)', marginBottom: 20 }}>
        <StatCard label="Unique Visitors" value={sessions.length} sub="Anonymous sessions" />
        <StatCard label="Hot Prospects" value={hotSessions.length} sub="Viewed 3+ times" />
        <StatCard label="Captured Leads" value={identifiedLeads} sub="Submitted contact form" />
      </div>

      <div style={{ display: 'flex', gap: 4, marginBottom: 16, background: 'var(--gw-bone)', borderRadius: 'var(--radius)', padding: 4, width: 'fit-content' }}>
        <button style={tabStyle('inquiries')} onClick={() => setTab('inquiries')}>Inquiries ({inquiries?.length || 0})</button>
        <button style={tabStyle('rotation')} onClick={() => setTab('rotation')}>Round Robin</button>
        <button style={tabStyle('visitors')} onClick={() => setTab('visitors')}>Visitor Sessions ({sessions.length})</button>
        <button style={tabStyle('captures')} onClick={() => setTab('captures')}>Captured Leads ({identifiedLeads})</button>
      </div>

      {tab === 'rotation' && <RoundRobinPanel agents={db.agents || []} isAdmin={isAdmin} />}

      {tab === 'inquiries' && (
        !inquiries || inquiries.length === 0
          ? <EmptyState icon="leads" title="No website inquiries yet"
              message="When someone asks about a home on the website, they are assigned to the next agent in the round robin and show up here — with what they searched for and the drip that started." />
          : <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <div className="data-table-wrap">
              <table className="data-table">
                <thead><tr>
                  <th>Lead</th><th>Looking for</th><th>Viewed</th><th>Assigned to</th><th>Drip</th><th>Received</th>
                </tr></thead>
                <tbody>
                  {inquiries.map(l => {
                    const agent = db.agents.find(a => a.id === l.assigned_agent_id)
                    const viewed = [...(l.lead_property_views || [])].sort((a, b) => a.position - b.position)
                    const wants = criteriaLine(l.search_criteria || {})
                    return (
                      <tr key={l.id}>
                        <td>
                          <strong>{l.name}</strong>
                          <div style={{ fontSize: 11, color: 'var(--gw-mist)' }}>{[l.email, l.phone].filter(Boolean).join(' · ')}</div>
                        </td>
                        <td style={{ fontSize: 12 }}>
                          {wants || <span style={{ color: 'var(--gw-mist)' }}>—</span>}
                          <div style={{ fontSize: 11, color: 'var(--gw-mist)' }}>{l.lane || l.interest_type}</div>
                        </td>
                        <td style={{ fontSize: 12, maxWidth: 240 }}>
                          {viewed.length ? viewed.slice(0, 2).map((v, i) => <div key={i}>{v.title || v.url}</div>) : '—'}
                          {viewed.length > 2 && <div style={{ fontSize: 11, color: 'var(--gw-mist)' }}>+{viewed.length - 2} more</div>}
                        </td>
                        <td>{agent
                          ? <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Avatar agent={agent} size={22} /><span style={{ fontSize: 12 }}>{agent.name}</span></div>
                          : <Badge variant="high">Unassigned</Badge>}</td>
                        <td style={{ fontSize: 12, color: l.drip_status === 'enrolled' ? 'var(--gw-green)' : 'var(--gw-mist)', fontWeight: l.drip_status === 'enrolled' ? 600 : 400 }}>
                          {DRIP_LABEL[l.drip_status] || l.drip_status}
                        </td>
                        <td style={{ fontSize: 12, color: 'var(--gw-mist)' }}>{formatDate(l.created_at)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              </div>
            </div>
      )}

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
