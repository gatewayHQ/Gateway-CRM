// Mail Campaigns — printed mailings with QR codes that lead to landing pages,
// and the funnel from mailed → scanned → lead.

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Icon, Modal, pushToast, EmptyState, Loading } from '../../components/UI.jsx'
import QrCode from '../../components/QrCode.jsx'
import { groupMailings } from '../../lib/services/mailingGroups.js'
import { streetLine } from '../../lib/address.js'
import { fetchMailingContacts } from '../../lib/services/contactRecords.js'
import { useSectionToggle } from './collapsePrefs.js'
import { api } from '../../lib/services/campaignsApi.js'
import { CollapsibleSection } from './CollapsibleSection.jsx'
import { TEMPLATES } from './campaignConfig.js'
import { FunnelBar, LandingTypeChip, StatusBadge } from './CampaignWidgets.jsx'
import { MailingForm } from './MailingForm.jsx'
import { MailingDetail } from './MailingDetail.jsx'

// ─── Main page ────────────────────────────────────────────────────────────────

// ─── QR code utilities ────────────────────────────────────────────────────────
// Generation moved to src/lib/qr.js (local, no external image service) and the
// <QrCode> component. `shortUrl` / `linkBase` are re-exported from there so the
// branded-domain rule lives in exactly one place.

export default function CampaignsPage({ db, isAdmin, activeAgent }) {
  const agents     = db?.agents     || []
  const properties = db?.properties || []

  const [mailings, setMailings]     = useState([])
  const [contacts, setContacts]     = useState([])
  const [loading,  setLoading]      = useState(true)
  const [selected, setSelected]     = useState(null)
  const [creating,    setCreating]    = useState(false)
  const [templateSel, setTemplateSel] = useState(null) // pre-fill template (null = blank form)
  const [saving,      setSaving]      = useState(false)
  const [dashboard, setDashboard]   = useState(null)
  const [setupNeeded, setSetupNeeded] = useState(false)
  const [setupError,  setSetupError]  = useState('')

  // Which status groups are open inside the list. Absent = the group's own default.
  const [mailGroupOpen, setMailGroupOpen] = useState({})
  // Collapsible page sections + the anchor the "All campaigns" jump scrolls to
  const [quickOpen, setQuickOpen]   = useSectionToggle('quickStart', true)
  const [listOpen,  setListOpen]    = useSectionToggle('list', true)
  const listRef                     = useRef(null)

  // Filters
  const [search, setSearch]         = useState('')
  const [statusFilter, setStatus]   = useState('all')
  const [agentFilter, setAgentF]    = useState('all')
  const [sort, setSort]             = useState('newest')

  const loadAll = async () => {
    setLoading(true)
    // Scope the list: admins see every campaign; agents see only their own +
    // any they collaborate on (passed to the API, enforced there).
    const listParams = isAdmin ? { all: '1' } : { agent_id: activeAgent?.id || '' }
    const [mRes, dRes, cRes] = await Promise.all([
      api('list', listParams, 'GET'),
      // Same scope as the list. Previously the dashboard tiles aggregated the
      // whole brokerage for everyone, so an agent's "Scans (30d)" disagreed with
      // the campaigns listed directly beneath it.
      api('dashboard', listParams, 'GET'),
      fetchMailingContacts(),
    ])
    if (mRes.error && /does not exist|relation|invalid path|server misconfigured/i.test(mRes.error)) {
      setSetupNeeded(true)
      setSetupError(mRes.error)
      setLoading(false)
      return
    }
    setMailings(mRes.mailings || [])
    setDashboard(dRes?.error ? null : dRes)
    setContacts(cRes.data || [])
    setLoading(false)
  }

  // Re-scope when identity resolves (activeAgent may be null on first paint).
  useEffect(() => { loadAll() }, [isAdmin, activeAgent?.id])

  const createMailing = async (form) => {
    setSaving(true)
    const res = await api('create', form)
    setSaving(false)
    if (res.error) return pushToast(res.error, 'error')
    setMailings(m => [res.mailing, ...m])
    setCreating(false)
    setSelected(res.mailing)
    pushToast('Mailing created — add recipients next')
  }

  const updateMailing = (updated) => {
    setMailings(m => m.map(x => x.id === updated.id ? updated : x))
    if (selected?.id === updated.id) setSelected(updated)
  }

  const handleDelete = (id) => {
    setMailings(m => m.filter(x => x.id !== id))
    setSelected(null)
  }

  // Fold the quick-start cards away and slide the campaign list up into view.
  const jumpToList = () => {
    setQuickOpen(false)
    setListOpen(true)
    // Wait out the collapse (260ms) so we scroll to where the list actually
    // lands, not to where it was before the quick-start cards folded away.
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    setTimeout(() => {
      listRef.current?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' })
    }, reduced ? 0 : 300)
  }

  const filtered = useMemo(() => {
    let out = mailings
    if (statusFilter !== 'all') out = out.filter(m => m.status === statusFilter)
    if (agentFilter !== 'all')  out = out.filter(m => m.agent_id === agentFilter)
    if (search.trim()) {
      const q = search.toLowerCase()
      out = out.filter(m => m.name.toLowerCase().includes(q) || (m.description || '').toLowerCase().includes(q))
    }
    if (sort === 'newest')      out = [...out].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    else if (sort === 'oldest') out = [...out].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    else if (sort === 'scans')  out = [...out].sort((a, b) => (b.scan_count || 0) - (a.scan_count || 0))
    else if (sort === 'leads')  out = [...out].sort((a, b) => (b.lead_count || 0) - (a.lead_count || 0))
    else if (sort === 'recipients') out = [...out].sort((a, b) => (b.recipient_count || 0) - (a.recipient_count || 0))
    return out
  }, [mailings, statusFilter, agentFilter, search, sort])

  if (setupNeeded) {
    const isEnvError = /invalid path|server misconfigured/i.test(setupError)
    return (
      <div className="page-content">
        <div style={{ maxWidth:780 }}>
          <h2 style={{ fontFamily:'var(--font-display)', margin:0 }}>Campaign Tracking — Setup Required</h2>
          {isEnvError ? (
            <>
              <p style={{ color:'var(--gw-mist)', marginTop:8 }}>
                The campaigns API can't reach the database. This is usually a missing environment variable in Vercel.
              </p>
              <p style={{ marginTop:8, fontSize:13 }}>
                Go to <strong>Vercel → Project → Settings → Environment Variables</strong> and confirm these are set:
              </p>
              <ul style={{ fontSize:13, marginTop:8, lineHeight:1.8 }}>
                <li><code>SUPABASE_URL</code> — your Supabase project URL (e.g. <code>https://xxxx.supabase.co</code>)</li>
                <li><code>SUPABASE_SERVICE_KEY</code> — the <em>service_role</em> secret key from Supabase → Settings → API</li>
              </ul>
              {setupError && <pre style={{ marginTop:8, fontSize:11, background:'var(--gw-bone)', padding:'8px 12px', borderRadius:6, color:'var(--gw-red)', whiteSpace:'pre-wrap' }}>{setupError}</pre>}
            </>
          ) : (
            <p style={{ color:'var(--gw-mist)', marginTop:8 }}>
              The mailings tables haven't been created yet. Run the migration once in your Supabase SQL editor — it's in <code>src/lib/schema.sql</code> under the <strong>MAILINGS (v2)</strong> section.
            </p>
          )}
          <button className="btn btn--primary" onClick={loadAll} style={{ marginTop:16 }}>
            {isEnvError ? 'Retry' : "I've run the migration — Reload"}
          </button>
        </div>
      </div>
    )
  }

  if (loading) return <div className="page-content"><Loading /></div>

  // `.page-content` is the scroll container — the shell (.main) clips its
  // children, so a page root without it can't scroll past the first screen.
  return (
    <div className="page-content">
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:20 }}>
        <div>
          <h1 style={{ margin:0, fontFamily:'var(--font-display)', fontSize:28 }}>Mail Campaigns</h1>
          <div style={{ color:'var(--gw-mist)', fontSize:13, marginTop:4 }}>
            Track postcards, flyers, and direct mail with per-piece QR codes
          </div>
        </div>
        <div style={{ display:'flex', gap:8 }}>
          <button className="btn" onClick={jumpToList}
                  title="Collapse the quick-start cards and slide the full campaign list into view">
            All Campaigns <Icon name="chevronDown" size={14} />
          </button>
          <button className="btn btn--primary" onClick={() => setCreating(true)}>
            <Icon name="plus" size={14} /> New Mailing
          </button>
        </div>
      </div>

      {/* FIVE TILES BECOME ONE LINE. The tiles took a third of the screen above
          the fold to say five numbers, which pushed the mailings themselves
          below it. Leads lead, because they are the only figure here that is
          money and the one the next mailing gets decided on. */}
      {dashboard && (
        <div style={{ display:'flex', gap:18, flexWrap:'wrap', alignItems:'baseline', marginBottom:16,
                      fontSize:12, color:'var(--gw-mist)' }}>
          <span><strong style={{ fontSize:17, color:'#7c3aed' }}>{dashboard.total_leads_30d}</strong> leads · 30d</span>
          <span><strong style={{ fontSize:17, color:'var(--gw-green)' }}>{dashboard.total_scans_30d}</strong> scans · 30d</span>
          <span><strong style={{ fontSize:17, color:'var(--gw-ink)' }}>{(dashboard.total_recipients || 0).toLocaleString()}</strong> pieces mailed</span>
          <span><strong style={{ fontSize:17, color:'var(--gw-azure)' }}>{dashboard.active_mailings}</strong> out in the mail</span>
          <span style={{ marginLeft:'auto' }}>{dashboard.total_mailings} mailings in all</span>
        </div>
      )}

      {/* Quick-start templates — collapsible so the list can move up the page */}
      <CollapsibleSection id="quickStart" title="Quick start" open={quickOpen} onToggle={setQuickOpen}
                          hint={quickOpen ? null : `${TEMPLATES.length + 1} templates`}
                          style={{ marginBottom:20 }}>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(220px, 1fr))', gap:10,
                      paddingBottom:2 }}>
          {TEMPLATES.map(t => (
            <button key={t.id} type="button"
                    onClick={() => { setTemplateSel(t); setCreating(true) }}
                    style={{ textAlign:'left', padding:'14px 16px', background:'#fff',
                             border:'1px solid var(--gw-border)', borderRadius:10, cursor:'pointer',
                             transition:'all 150ms', position:'relative', overflow:'hidden' }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = t.accent; e.currentTarget.style.transform = 'translateY(-1px)' }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--gw-border)'; e.currentTarget.style.transform = 'translateY(0)' }}>
              <div style={{ position:'absolute', top:0, left:0, right:0, height:3, background:t.accent }} />
              <div style={{ display:'flex', alignItems:'center', gap:8, marginTop:2 }}>
                <div style={{ width:28, height:28, borderRadius:6, background:`${t.accent}22`, color:t.accent,
                              display:'flex', alignItems:'center', justifyContent:'center' }}>
                  <Icon name={t.icon} size={14} />
                </div>
                <div style={{ fontWeight:700, fontSize:13.5 }}>{t.label}</div>
              </div>
              <div style={{ fontSize:11.5, color:'var(--gw-mist)', marginTop:6, lineHeight:1.4 }}>
                {t.description}
              </div>
            </button>
          ))}
          <button type="button" onClick={() => { setTemplateSel(null); setCreating(true) }}
                  style={{ textAlign:'left', padding:'14px 16px', background:'transparent',
                           border:'1.5px dashed var(--gw-border)', borderRadius:10, cursor:'pointer',
                           transition:'all 150ms', display:'flex', alignItems:'center', gap:8 }}
                  onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--gw-azure)'}
                  onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--gw-border)'}>
            <div style={{ width:28, height:28, borderRadius:6, background:'var(--gw-bone)',
                          display:'flex', alignItems:'center', justifyContent:'center', color:'var(--gw-mist)' }}>
              <Icon name="plus" size={14} />
            </div>
            <div>
              <div style={{ fontWeight:700, fontSize:13.5 }}>Blank Mailing</div>
              <div style={{ fontSize:11.5, color:'var(--gw-mist)' }}>Start from scratch</div>
            </div>
          </button>
        </div>
      </CollapsibleSection>

      {/* All campaigns — header slides the filters + full list open and closed */}
      <div ref={listRef} style={{ scrollMarginTop:16 }}>
        <CollapsibleSection id="list" title="All campaigns" count={filtered.length}
                            open={listOpen} onToggle={setListOpen}
                            hint={filtered.length !== mailings.length
                                    ? `${filtered.length} of ${mailings.length} shown`
                                    : (listOpen ? null : 'Click to expand')}>
          <div style={{ display:'flex', gap:8, marginBottom:14, flexWrap:'wrap' }}>
            <input className="input" placeholder="Search mailings…" value={search}
                   onChange={e => setSearch(e.target.value)} style={{ flex:1, minWidth:200 }} />
            <select className="input" value={statusFilter} onChange={e => setStatus(e.target.value)} style={{ width:160 }}>
              <option value="all">All statuses</option>
              <option value="draft">Draft</option>
              <option value="active">Active</option>
              <option value="sent">Sent</option>
              <option value="archived">Archived</option>
            </select>
            {isAdmin && (
              <select className="input" value={agentFilter} onChange={e => setAgentF(e.target.value)} style={{ width:180 }}>
                <option value="all">All agents</option>
                {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            )}
            <select className="input" value={sort} onChange={e => setSort(e.target.value)} style={{ width:170 }}>
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="scans">Most scans</option>
              <option value="leads">Most leads</option>
              <option value="recipients">Most recipients</option>
            </select>
          </div>

          {filtered.length === 0 ? (
            <EmptyState title={mailings.length === 0 ? 'No mailings yet' : 'No mailings match these filters'}
                        message={mailings.length === 0 ? 'Create your first mailing to get a unique trackable QR code.' : 'Try clearing the filters.'}
                        action={mailings.length === 0 && <button className="btn btn--primary" onClick={() => setCreating(true)}>Create First Mailing</button>} />
          ) : (
            /* GROUPED BY WHERE EACH MAILING IS — out in the mail, drafts,
               archived — so the pieces that can still pull a scan are not
               interleaved with ones that were never sent. The sort control
               above still decides the order inside each group. */
            groupMailings(filtered).map(group => (
            <div key={group.id} style={{ marginBottom:16 }}>
              <button
                type="button"
                onClick={() => setMailGroupOpen(g => ({ ...g, [group.id]: !(g[group.id] ?? group.open) }))}
                aria-expanded={mailGroupOpen[group.id] ?? group.open}
                style={{ display:'flex', alignItems:'center', gap:8, width:'100%', textAlign:'left',
                         background:'transparent', border:0, borderBottom:'1px solid var(--gw-border)',
                         padding:'4px 2px 6px', marginBottom:8, cursor:'pointer', fontFamily:'var(--font-body)' }}
              >
                <span style={{ width:7, height:7, borderRadius:'50%', flexShrink:0,
                               background: group.tone === 'azure' ? 'var(--gw-azure)' : 'var(--gw-border)' }} />
                <span style={{ fontSize:11, fontWeight:700, letterSpacing:'0.06em', textTransform:'uppercase', color:'var(--gw-ink)' }}>
                  {group.label}
                </span>
                <span style={{ fontSize:11, color:'var(--gw-mist)' }}>{group.mailings.length}</span>
                <span style={{ marginLeft:'auto', fontSize:10, color:'var(--gw-mist)' }}>
                  {(mailGroupOpen[group.id] ?? group.open) ? '\u25be' : '\u25b8'}
                </span>
              </button>
              {(mailGroupOpen[group.id] ?? group.open) && group.hint && (
                <div style={{ fontSize:11, color:'var(--gw-mist)', marginBottom:8 }}>{group.hint}</div>
              )}
              {(mailGroupOpen[group.id] ?? group.open) && (
              <div style={{ display:'grid', gap:10 }}>
              {group.mailings.map(m => {
                const agent    = agents.find(a => a.id === m.agent_id)
                const property = properties.find(p => p.id === m.property_id)
                const mailed   = m.recipient_count || 0
                const scans    = m.scan_count || 0
                const leads    = m.lead_count || 0
                const scanRate = mailed > 0 ? Math.min(100, (scans / mailed) * 100) : 0
                const leadRate = mailed > 0 ? Math.min(100, (leads / mailed) * 100) : 0
                return (
                  <div key={m.id} onClick={() => setSelected(m)}
                       style={{ background:'#fff', border:'1px solid var(--gw-border)', borderRadius:'var(--radius)',
                                padding:'14px 18px', cursor:'pointer', display:'grid',
                                gridTemplateColumns:'1fr 220px 80px 80px 80px 56px', gap:14, alignItems:'center',
                                transition:'all 150ms' }}
                       onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--gw-azure)'}
                       onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--gw-border)'}>
                    <div style={{ minWidth:0 }}>
                      <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                        <div style={{ fontWeight:700, fontSize:15, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{m.name}</div>
                        <StatusBadge status={m.status} />
                        <LandingTypeChip type={m.landing_type} />
                      </div>
                      <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:4, display:'flex', gap:10, flexWrap:'wrap' }}>
                        {agent && <span>{agent.name}</span>}
                        {property && <span>· {streetLine(property)}</span>}
                        {m.send_date && <span>· {m.send_date}</span>}
                        <span>· {m.mailing_type}</span>
                      </div>
                    </div>

                    {/* Conversion funnel mini-viz */}
                    <div title={`${mailed} mailed → ${scans} scans → ${leads} leads`}>
                      <FunnelBar scanRate={scanRate} leadRate={leadRate} />
                    </div>

                    <div style={{ textAlign:'center' }}>
                      <div style={{ fontSize:17, fontWeight:700 }}>{mailed.toLocaleString()}</div>
                      <div style={{ fontSize:10, color:'var(--gw-mist)', textTransform:'uppercase' }}>Mailed</div>
                    </div>
                    <div style={{ textAlign:'center' }}>
                      <div style={{ fontSize:17, fontWeight:700, color:'var(--gw-azure)' }}>{scans}</div>
                      <div style={{ fontSize:10, color:'var(--gw-mist)', textTransform:'uppercase' }}>Scans</div>
                    </div>
                    <div style={{ textAlign:'center' }}>
                      <div style={{ fontSize:17, fontWeight:700, color:'var(--gw-green)' }}>{leads}</div>
                      <div style={{ fontSize:10, color:'var(--gw-mist)', textTransform:'uppercase' }}>Leads</div>
                    </div>
                    <div style={{ display:'flex', alignItems:'center', justifyContent:'flex-end' }}>
                      <QrCode token={m.qr_token} size={38} alt=""
                              style={{ width:38, height:38, border:'1px solid var(--gw-border)', borderRadius:4 }} />
                    </div>
                  </div>
                )
              })}
              </div>
              )}
            </div>
            ))
          )}
        </CollapsibleSection>
      </div>

      {creating && (
        <Modal open={true} onClose={() => { setCreating(false); setTemplateSel(null) }} width={680}>
          <div className="modal__head">
            <div>
              <h3 style={{ margin:0, fontFamily:'var(--font-display)', fontSize:18 }}>
                {templateSel ? `${templateSel.label} Mailing` : 'New Mailing'}
              </h3>
              {templateSel && (
                <div style={{ fontSize:11.5, color:'var(--gw-mist)', marginTop:3 }}>
                  Pre-filled from the <strong>{templateSel.label}</strong> template — edit anything before saving.
                </div>
              )}
            </div>
            <button className="drawer__close" onClick={() => { setCreating(false); setTemplateSel(null) }}>
              <Icon name="x" size={18} />
            </button>
          </div>
          <div style={{ padding:20, maxHeight:'calc(100vh - 180px)', overflowY:'auto' }}>
            <MailingForm
              key={templateSel?.id || 'blank'}
              initialTemplate={templateSel}
              agents={agents}
              properties={properties}
              activeAgent={activeAgent}
              saving={saving}
              onSave={createMailing}
              onCancel={() => { setCreating(false); setTemplateSel(null) }}
            />
          </div>
        </Modal>
      )}

      {selected && (
        <MailingDetail
          mailing={selected}
          agents={agents}
          properties={properties}
          contacts={contacts}
          activeAgent={activeAgent}
          onClose={() => setSelected(null)}
          onUpdate={updateMailing}
          onDelete={handleDelete}
        />
      )}
    </div>
  )
}
