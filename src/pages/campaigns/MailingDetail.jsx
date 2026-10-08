// One mailing: its stats, funnel, recipients and settings.

import React, { useEffect, useState } from 'react'
import { Icon, Modal, pushToast, EmptyState, ConfirmDialog } from '../../components/UI.jsx'
import QrCode from '../../components/QrCode.jsx'
import { shortUrl, downloadQr } from '../../lib/qr.js'
import { streetLine } from '../../lib/address.js'
import { normalizeOm, OM_BUCKET } from '../../lib/om.js'
import { supabase } from '../../lib/supabase.js'
import { api } from '../../lib/services/campaignsApi.js'
import { Breakdowns, StatCard, StatusBadge } from './CampaignWidgets.jsx'
import { MailingForm } from './MailingForm.jsx'
import { RecipientImporter } from './RecipientImporter.jsx'

// ─── Mailing detail drawer ────────────────────────────────────────────────────

export function MailingDetail({ mailing, agents, properties, contacts, activeAgent, onClose, onUpdate, onDelete }) {
  const [tab, setTab] = useState('overview') // overview | recipients | scans | leads | om | edit
  const [recipients, setRecipients] = useState([])
  const [scans, setScans] = useState([])
  const [leads, setLeads] = useState([])
  const [subscribers, setSubscribers] = useState([])
  const [omRequests, setOmRequests] = useState([])
  const [analytics, setAnalytics] = useState(null)
  const [loading, setLoading] = useState(true)
  const [importerOpen, setImporterOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [saving, setSaving] = useState(false)

  const isMailingList = mailing.landing_type === 'mailing'
  const attachedOm    = normalizeOm(mailing.landing_config?.om)
  const roomDocs      = Array.isArray(mailing.landing_config?.deal_room?.documents) ? mailing.landing_config.deal_room.documents : []
  const roomUpdates   = Array.isArray(mailing.landing_config?.deal_room?.updates) ? mailing.landing_config.deal_room.updates : []
  // "Has a Deal Room": an OM, or any other document behind the registration.
  const hasOmAttached = !!attachedOm || roomDocs.length > 0
  const ndaAttached   = !!mailing.landing_config?.nda?.path

  // The signed NDA (agreement + signature certificate), from the private bucket.
  const openSignedNda = async (r) => {
    const { data, error } = await supabase.storage.from(OM_BUCKET)
      .createSignedUrl(r.nda_signed_copy_path, 300, { download: `NDA-${(r.name || 'signed').replace(/[^a-z0-9]+/gi, '-')}.pdf` })
    if (error || !data?.signedUrl) { pushToast("Couldn't open the signed NDA: " + (error?.message || 'try again'), 'error'); return }
    window.open(data.signedUrl, '_blank', 'noopener')
  }

  const refresh = async () => {
    setLoading(true)
    const [r, s, l, a, sub, om] = await Promise.all([
      api('recipients', { mailing_id: mailing.id }, 'GET'),
      api('scans',      { mailing_id: mailing.id }, 'GET'),
      api('leads',      { mailing_id: mailing.id }, 'GET'),
      api('analytics',  { mailing_id: mailing.id }, 'GET'),
      isMailingList ? api('subscribers', { mailing_id: mailing.id }, 'GET') : Promise.resolve({ subscribers: [] }),
      // Only when the page actually has an OM attached — no point asking
      // otherwise, and it keeps the drawer's round trips down.
      hasOmAttached ? api('om_requests', { mailing_id: mailing.id }, 'GET') : Promise.resolve({ om_requests: [] }),
    ])
    setRecipients(r.recipients || [])
    setScans(s.scans || [])
    setLeads(l.leads || [])
    setSubscribers(sub.subscribers || [])
    setOmRequests(om.om_requests || [])
    setAnalytics(a)
    setLoading(false)
  }

  useEffect(() => { refresh() /* eslint-disable-next-line */ }, [mailing.id])

  const property = properties.find(p => p.id === mailing.property_id)
  const agent    = agents.find(a => a.id === mailing.agent_id)

  const copyUrl = async () => {
    await navigator.clipboard.writeText(shortUrl(mailing.qr_token))
    pushToast('Tracking URL copied')
  }

  // Generated locally and handed over as a Blob, so the download works offline
  // and always produces a real file (the old version linked out to a third-party
  // image service and silently produced nothing when it was unreachable).
  const downloadQR = async (format = 'png') => {
    try {
      const slug = (mailing.name || 'mailing').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()
      await downloadQr(mailing.qr_token, {
        format,
        size: format === 'png' ? 2000 : 1000,
        filename: `${slug || 'mailing'}-qr.${format}`,
      })
    } catch {
      pushToast('Could not generate the QR code — please try again.', 'error')
    }
  }

  const removeRecipient = async (id) => {
    const res = await api('remove_recipient', { id })
    if (res.error) return pushToast(res.error, 'error')
    refresh()
  }

  const setResponse = async (recipientId, response_type) => {
    const res = await api('update_recipient', { id: recipientId, response_type, responded: !!response_type })
    if (res.error) return pushToast(res.error, 'error')
    setRecipients(rs => rs.map(r => r.id === recipientId ? res.recipient : r))
  }

  const saveEdit = async (form) => {
    setSaving(true)
    const res = await api('update', { id: mailing.id, ...form })
    setSaving(false)
    if (res.error) return pushToast(res.error, 'error')
    onUpdate(res.mailing)
    setTab('overview')
    pushToast('Mailing updated')
  }

  const exportRecipientsCSV = () => {
    const headers = ['Name','Address','City','State','Zip','Scans','Responded','Response Type']
    const rows = recipients.map(r => [
      r.recipient_name || '', r.address_line1 || '', r.city || '', r.state || '', r.zip || '',
      r.scan_count || 0, r.responded ? 'Yes' : 'No', r.response_type || '',
    ])
    const csv = [headers, ...rows].map(row => row.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${mailing.name.replace(/[^a-z0-9]/gi, '_')}-recipients.csv`
    a.click()
  }

  const exportSubscribersCSV = () => {
    const headers = ['Email', 'Name', 'Phone', 'Message', 'Status', 'Consent', 'Subscribed At']
    const rows = subscribers.map(s => [
      s.email || '', s.name || '', s.phone || '', s.message || '', s.status || '',
      s.consent ? 'Yes' : 'No', s.subscribed_at ? new Date(s.subscribed_at).toISOString().slice(0, 10) : '',
    ])
    const csv = [headers, ...rows].map(row => row.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${mailing.name.replace(/[^a-z0-9]/gi, '_')}-subscribers.csv`
    a.click()
  }
  const exportOmRequestsCSV = () => {
    const headers = ['Name', 'Email', 'Phone', 'Mailing Address', 'Role', '1031', 'Visits', 'Downloads', 'First Download', 'Last Download', 'From A Scan', 'NDA Signed', 'NDA Signer', 'NDA Company']
    const rows = omRequests.map(r => [
      r.name || '', r.email || '', r.phone || '', r.mailing_address || '', r.buyer_role || '',
      r.is_1031 === true ? 'Yes' : r.is_1031 === false ? 'No' : '', r.visit_count ?? 1, r.download_count ?? 1,
      r.created_at ? new Date(r.created_at).toISOString().slice(0, 16).replace('T', ' ') : '',
      r.last_download_at ? new Date(r.last_download_at).toISOString().slice(0, 16).replace('T', ' ') : '',
      r.visit_id ? 'Yes' : 'No',
      r.nda_signed_at ? new Date(r.nda_signed_at).toISOString().slice(0, 16).replace('T', ' ') : '',
      r.nda_signer_name || '', r.nda_signer_company || '',
    ])
    const csv = [headers, ...rows].map(row => row.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${mailing.name.replace(/[^a-z0-9]/gi, '_')}-deal-room.csv`
    a.click()
  }

  const activeSubscribers = subscribers.filter(s => s.status === 'subscribed')

  return (
    <Modal open={true} onClose={onClose} width={920}>
      <div className="modal__head" style={{ alignItems:'flex-start' }}>
        <div style={{ flex:1 }}>
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            <h3 style={{ margin:0, fontFamily:'var(--font-display)', fontSize:20 }}>{mailing.name}</h3>
            <StatusBadge status={mailing.status} />
          </div>
          {mailing.description && <div style={{ fontSize:13, color:'var(--gw-mist)', marginTop:4 }}>{mailing.description}</div>}
          <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:6, display:'flex', gap:14, flexWrap:'wrap' }}>
            {agent && <span><Icon name="user" size={11} /> {agent.name}</span>}
            {property && <span><Icon name="building" size={11} /> {streetLine(property)}{property.city ? `, ${property.city}` : ''}</span>}
            {mailing.send_date && <span><Icon name="calendar" size={11} /> {mailing.send_date}</span>}
            <span><Icon name="layers" size={11} /> {mailing.mailing_type}</span>
          </div>
        </div>
        <button className="drawer__close" onClick={onClose}><Icon name="x" size={18} /></button>
      </div>

      <div style={{ display:'flex', gap:4, borderBottom:'1px solid var(--gw-border)', padding:'0 20px' }}>
        {[
          { id:'overview',   label:'Overview'                                                    },
          ...(isMailingList ? [{ id:'subscribers', label:`Subscribers (${activeSubscribers.length})` }] : []),
          { id:'recipients', label:`Recipients (${analytics?.recipients_total ?? recipients.length})` },
          { id:'scans',      label:`Scans (${analytics?.total_scans ?? scans.length})` },
          ...(isMailingList ? [] : [{ id:'leads', label:`Leads (${analytics?.total_leads ?? leads.length})` }]),
          ...(hasOmAttached ? [{ id:'om', label:`Deal Room (${omRequests.length})` }] : []),
          { id:'edit',       label:'Edit' },
        ].map(t => (
          <button key={t.id}
                  onClick={() => setTab(t.id)}
                  style={{ padding:'10px 14px', background:'none', border:'none', cursor:'pointer',
                           fontSize:13, fontWeight:600,
                           color: tab === t.id ? 'var(--gw-azure)' : 'var(--gw-mist)',
                           borderBottom: tab === t.id ? '2px solid var(--gw-azure)' : '2px solid transparent' }}>
            {t.label}
          </button>
        ))}
      </div>

      <div style={{ padding:20, maxHeight:'70vh', overflowY:'auto' }}>
        {loading && tab === 'overview' && <div style={{ color:'var(--gw-mist)' }}>Loading…</div>}

        {tab === 'overview' && !loading && (
          <div style={{ display:'grid', gridTemplateColumns:'320px 1fr', gap:24 }}>
            <div>
              <div style={{ background:'#fff', border:'1px solid var(--gw-border)', borderRadius:12, padding:16, textAlign:'center' }}>
                <QrCode token={mailing.qr_token} size={280} alt={`QR code for ${mailing.name}`}
                        style={{ width:'100%', maxWidth:280, height:'auto', display:'block', margin:'0 auto' }} />
                <div style={{ fontFamily:'monospace', fontSize:13, marginTop:8, padding:'6px 10px',
                              background:'var(--gw-bone)', borderRadius:6, wordBreak:'break-all' }}>
                  {shortUrl(mailing.qr_token)}
                </div>
                <div style={{ display:'flex', gap:6, marginTop:10, justifyContent:'center', flexWrap:'wrap' }}>
                  <button className="btn btn--ghost" style={{ fontSize:12 }} onClick={copyUrl}>
                    <Icon name="copy" size={12} /> Copy URL
                  </button>
                  <button className="btn btn--ghost" style={{ fontSize:12 }} onClick={() => downloadQR('png')}>
                    <Icon name="download" size={12} /> PNG
                  </button>
                  <button className="btn btn--ghost" style={{ fontSize:12 }} onClick={() => downloadQR('svg')}>
                    <Icon name="download" size={12} /> SVG
                  </button>
                </div>
              </div>
              <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:8, textAlign:'center' }}>
                Drop the SVG into Canva or Vistaprint for crisp printing at any size.
              </div>
            </div>

            <div>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:10 }}>
                <StatCard value={analytics?.recipients_total ?? '—'} label="Mailed" />
                <StatCard value={analytics?.total_scans ?? '—'}      label="Scans" color="var(--gw-azure)"
                          sub={analytics?.raw_scans > analytics?.total_scans
                                 ? `${analytics.raw_scans - analytics.total_scans} filtered` : null} />
                <StatCard value={analytics?.unique_scanners ?? '—'}  label="People"
                          sub={analytics?.returning_scanners > 0 ? `${analytics.returning_scanners} came back` : null} />
                <StatCard value={analytics?.total_leads ?? '—'}      label="Leads" color="var(--gw-green)"
                          sub={analytics?.attributed_leads > 0 ? `${analytics.attributed_leads} from a scan` : null} />
              </div>

              {/* Response index, not "scan rate".
                  With one QR code per campaign every mailer carries the SAME
                  code, so there is no way to know WHICH recipients scanned —
                  only how many scans a drop of N pieces produced. The old bar
                  claimed "X% of recipients scanned" and, because the underlying
                  per-recipient columns were never written, always read 0%. */}
              <div style={{ marginTop:18 }}>
                <div style={{ display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom:8 }}>
                  <div style={{ fontSize:12, fontWeight:700, color:'var(--gw-ink)' }}>Response Index</div>
                  <div style={{ fontSize:11, color:'var(--gw-mist)' }}>
                    scans per 100 pieces mailed
                  </div>
                </div>
                <div style={{ background:'var(--gw-bone)', borderRadius:6, height:10, overflow:'hidden' }}>
                  <div style={{ width:`${Math.min(100, Number(analytics?.response_index) || 0)}%`, height:'100%',
                                background:'linear-gradient(90deg, var(--gw-azure), var(--gw-green))' }} />
                </div>
                <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:4 }}>
                  {analytics?.response_index != null
                    ? <><strong style={{ color:'var(--gw-ink)' }}>{analytics.response_index}</strong> scans per 100 pieces
                        {analytics.total_scans > 0 && analytics.unique_scanners > 0 &&
                          ` · ${analytics.unique_scanners} distinct ${analytics.unique_scanners === 1 ? 'person' : 'people'}`}</>
                    : 'Add recipients to see how this drop performed'}
                </div>
              </div>

              {/* Scan → lead conversion */}
              {analytics?.total_scans > 0 && (
                <div style={{ marginTop:14 }}>
                  <div style={{ fontSize:12, fontWeight:700, color:'var(--gw-ink)', marginBottom:6 }}>
                    Scan → Lead Conversion
                  </div>
                  <div style={{ fontSize:11, color:'var(--gw-mist)' }}>
                    <strong style={{ color:'var(--gw-green)', fontSize:14 }}>
                      {Math.round((Number(analytics.conversion_rate) || 0) * 100)}%
                    </strong>
                    {' '}of scans became a lead
                    {analytics.attributed_leads > 0 &&
                      ` · ${analytics.attributed_leads} tied to a specific scan`}
                  </div>
                </div>
              )}

              <Breakdowns analytics={analytics} />

              {analytics?.timeline?.length > 0 && (
                <div style={{ marginTop:18 }}>
                  <div style={{ fontSize:12, fontWeight:700, color:'var(--gw-ink)', marginBottom:8 }}>Scan Activity</div>
                  <div style={{ display:'flex', alignItems:'flex-end', gap:2, height:80 }}>
                    {(() => {
                      const max = Math.max(1, ...analytics.timeline.map(t => t.count))
                      return analytics.timeline.map(t => (
                        <div key={t.date} style={{ flex:1, background:'var(--gw-azure)', borderRadius:'2px 2px 0 0',
                                                   height:`${(t.count / max) * 100}%`, minHeight:2 }}
                             title={`${t.date}: ${t.count} scan${t.count === 1 ? '' : 's'}`} />
                      ))
                    })()}
                  </div>
                  <div style={{ display:'flex', justifyContent:'space-between', fontSize:10, color:'var(--gw-mist)', marginTop:4 }}>
                    <span>{analytics.timeline[0]?.date}</span>
                    <span>{analytics.timeline[analytics.timeline.length - 1]?.date}</span>
                  </div>
                </div>
              )}

              <div style={{ marginTop:18, display:'flex', gap:8 }}>
                <button className="btn btn--ghost" onClick={() => {
                  const path = mailing.landing_type === 'custom' && mailing.landing_custom_url
                    ? mailing.landing_custom_url
                    : `/lp/${['valuation','multifamily','mailing','property'].includes(mailing.landing_type) ? mailing.landing_type : 'property'}/${mailing.id}`
                  window.open(path, '_blank')
                }}>
                  <Icon name="external" size={12} /> Preview Landing Page
                </button>
                <button className="btn btn--ghost" onClick={() => setConfirmDelete(true)} style={{ marginLeft:'auto', color:'var(--gw-red)' }}>
                  <Icon name="trash" size={12} /> Delete
                </button>
              </div>
            </div>
          </div>
        )}

        {tab === 'recipients' && (
          <>
            <div style={{ display:'flex', justifyContent:'space-between', marginBottom:12 }}>
              <div style={{ fontSize:13, color:'var(--gw-mist)' }}>
                {recipients.length} recipient{recipients.length === 1 ? '' : 's'}
              </div>
              <div style={{ display:'flex', gap:8 }}>
                <button className="btn btn--ghost" onClick={exportRecipientsCSV} disabled={recipients.length === 0}>
                  <Icon name="download" size={12} /> Export CSV
                </button>
                <button className="btn btn--primary" onClick={() => setImporterOpen(true)}>
                  <Icon name="plus" size={12} /> Add Recipients
                </button>
              </div>
            </div>
            {recipients.length === 0 ? (
              <EmptyState title="No recipients yet"
                          message="Add contacts from the CRM, upload a CSV/Excel file, or enter them manually."
                          action={<button className="btn btn--primary" onClick={() => setImporterOpen(true)}>Add Recipients</button>} />
            ) : (
              <div style={{ border:'1px solid var(--gw-border)', borderRadius:8, overflow:'hidden' }}>
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                  <thead style={{ background:'var(--gw-bone)' }}>
                    <tr>
                      <th style={{ padding:'8px 12px', textAlign:'left', fontSize:11, textTransform:'uppercase' }}>Name</th>
                      <th style={{ padding:'8px 12px', textAlign:'left', fontSize:11, textTransform:'uppercase' }}>Address</th>
                      <th style={{ padding:'8px 12px', textAlign:'center', fontSize:11, textTransform:'uppercase' }}>Scans</th>
                      <th style={{ padding:'8px 12px', textAlign:'left', fontSize:11, textTransform:'uppercase' }}>Response</th>
                      <th style={{ padding:'8px 12px', width:30 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {recipients.map(r => (
                      <tr key={r.id} style={{ borderTop:'1px solid var(--gw-border)' }}>
                        <td style={{ padding:'8px 12px', fontWeight:600 }}>{r.recipient_name || '—'}</td>
                        <td style={{ padding:'8px 12px', color:'var(--gw-mist)' }}>
                          {[r.address_line1, r.city, r.state, r.zip].filter(Boolean).join(', ') || '—'}
                        </td>
                        <td style={{ padding:'8px 12px', textAlign:'center' }}>
                          {r.scan_count > 0
                            ? <span style={{ color:'var(--gw-azure)', fontWeight:700 }}>{r.scan_count}</span>
                            : <span style={{ color:'var(--gw-mist)' }}>0</span>}
                        </td>
                        <td style={{ padding:'8px 12px' }}>
                          <select value={r.response_type || ''} onChange={e => setResponse(r.id, e.target.value)}
                                  style={{ padding:'3px 6px', fontSize:12, border:'1px solid var(--gw-border)', borderRadius:6 }}>
                            <option value="">No response</option>
                            <option value="lead_captured">Lead captured</option>
                            <option value="called">Called us</option>
                            <option value="emailed">Emailed us</option>
                            <option value="interested">Interested</option>
                            <option value="not_interested">Not interested</option>
                            <option value="converted">Converted</option>
                          </select>
                        </td>
                        <td style={{ padding:'8px 12px' }}>
                          <button className="btn btn--ghost" style={{ padding:4 }} onClick={() => removeRecipient(r.id)} title="Remove">
                            <Icon name="x" size={12} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {tab === 'scans' && (
          <>
            {scans.length === 0 ? (
              <EmptyState title="No scans yet"
                          message="When recipients scan the QR code on your mailer, the events will appear here." />
            ) : (
              <div style={{ border:'1px solid var(--gw-border)', borderRadius:8, overflow:'hidden' }}>
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                  <thead style={{ background:'var(--gw-bone)' }}>
                    <tr>
                      <th style={{ padding:'8px 12px', textAlign:'left', fontSize:11, textTransform:'uppercase' }}>When</th>
                      <th style={{ padding:'8px 12px', textAlign:'left', fontSize:11, textTransform:'uppercase' }}>Location</th>
                      <th style={{ padding:'8px 12px', textAlign:'left', fontSize:11, textTransform:'uppercase' }}>Device</th>
                      <th style={{ padding:'8px 12px', textAlign:'left', fontSize:11, textTransform:'uppercase' }}>Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scans.map(s => (
                      <tr key={s.id} style={{ borderTop:'1px solid var(--gw-border)',
                                              opacity: (s.is_bot || s.is_duplicate) ? 0.55 : 1 }}>
                        <td style={{ padding:'8px 12px', whiteSpace:'nowrap' }}>{new Date(s.scanned_at).toLocaleString()}</td>
                        <td style={{ padding:'8px 12px' }}>
                          {[s.city, s.region, s.country].filter(Boolean).join(', ') || s.country || '—'}
                        </td>
                        <td style={{ padding:'8px 12px', color:'var(--gw-mist)', fontSize:12 }}>
                          {[s.device_type, s.os, s.browser].filter(Boolean).join(' · ')
                            || (s.user_agent || '').slice(0, 60) || '—'}
                        </td>
                        <td style={{ padding:'8px 12px', fontSize:11 }}>
                          {s.is_bot
                            ? <span title={s.bot_reason || 'automated'} style={{ color:'var(--gw-mist)' }}>Bot / preview</span>
                            : s.is_duplicate
                              ? <span title="Same visitor within seconds — stored but not counted" style={{ color:'var(--gw-mist)' }}>Repeat</span>
                              : <span style={{ color:'var(--gw-green)', fontWeight:600 }}>Counted</span>}
                          {s.source === 'replay' && (
                            <span title="Recovered by the landing page after the server could not confirm the write"
                                  style={{ marginLeft:6, color:'var(--gw-azure)' }}>· recovered</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {tab === 'leads' && (
          <>
            {leads.length === 0 ? (
              <EmptyState title="No leads captured yet"
                          message="When someone fills out the form on the landing page, they'll appear here." />
            ) : (
              <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                {leads.map(l => (
                  <div key={l.id} style={{ border:'1px solid var(--gw-border)', borderRadius:8, padding:12 }}>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:8 }}>
                      <div style={{ fontWeight:700, display:'flex', alignItems:'center', gap:7, minWidth:0 }}>
                        <span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                          {l.name || 'Anonymous'}
                        </span>
                        {/* An OM download is a materially warmer lead than a
                            "call me" form fill — say so at a glance. */}
                        {l.om_requested && (
                          <span style={{ fontSize:10, fontWeight:700, letterSpacing:0.4, textTransform:'uppercase',
                                         color:'#b8860b', background:'#fdf3e0', border:'1px solid #f0e0c0',
                                         borderRadius:99, padding:'2px 7px', flexShrink:0 }}>
                            Downloaded OM
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize:11, color:'var(--gw-mist)', flexShrink:0 }}>{new Date(l.created_at).toLocaleString()}</div>
                    </div>
                    <div style={{ fontSize:12, color:'var(--gw-mist)', marginTop:4, display:'flex', gap:14, flexWrap:'wrap' }}>
                      {l.email && <span><Icon name="mail" size={11} /> {l.email}</span>}
                      {l.phone && <span><Icon name="phone" size={11} /> {l.phone}</span>}
                      {l.property_address && <span><Icon name="building" size={11} /> {l.property_address}</span>}
                    </div>
                    {l.message && <div style={{ marginTop:6, fontSize:13, color:'var(--gw-ink)' }}>{l.message}</div>}
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {tab === 'om' && (
          <>
            <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:12, flexWrap:'wrap' }}>
              <div style={{ fontSize:13, color:'var(--gw-mist)' }}>
                <strong style={{ color:'var(--gw-ink)' }}>{omRequests.length}</strong> registered
                {' · '}{(attachedOm ? 1 : 0) + roomDocs.length} document{(attachedOm ? 1 : 0) + roomDocs.length === 1 ? '' : 's'}
                {ndaAttached && (
                  <> · <strong style={{ color:'var(--gw-ink)' }}>{omRequests.filter(r => r.nda_signed_at).length}</strong> signed the NDA</>
                )}
                {omRequests.some(r => (r.visit_count ?? 1) > 1) && (
                  <> · <strong style={{ color:'var(--gw-ink)' }}>{omRequests.filter(r => (r.visit_count ?? 1) > 1).length}</strong> came back</>
                )}
              </div>
              <button className="btn btn--secondary" style={{ fontSize:12, marginLeft:'auto' }}
                      disabled={omRequests.length === 0} onClick={exportOmRequestsCSV}>
                <Icon name="download" size={12} /> Export CSV
              </button>
            </div>
            <DealRoomNotify mailing={mailing} updates={roomUpdates}
                            registered={ndaAttached ? omRequests.filter(r => r.nda_signed_at).length : omRequests.length} />
            {omRequests.length === 0 ? (
              <EmptyState title="Nobody has opened the OM yet"
                          message="The download is gated: whoever wants the offering memorandum gives their name, phone and email first. Everyone who does shows up here — and as a lead." />
            ) : (
              <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                {omRequests.map(r => (
                  <div key={r.id} style={{ border:'1px solid var(--gw-border)', borderRadius:8, padding:'10px 12px' }}>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:8 }}>
                      <div style={{ fontWeight:700, minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                        {r.name || 'Anonymous'}
                      </div>
                      <div style={{ fontSize:11, color:'var(--gw-mist)', flexShrink:0, display:'flex', gap:8, alignItems:'center' }}>
                        {(r.visit_count ?? 1) > 1 && (
                          <span title="Times they've opened the Deal Room" style={{ color:'#b8860b', fontWeight:700 }}>
                            {r.visit_count} visits
                          </span>
                        )}
                        {r.download_count > 1 && (
                          <span title="Times they've re-opened the download">×{r.download_count}</span>
                        )}
                        {new Date(r.last_download_at || r.created_at).toLocaleString()}
                      </div>
                    </div>
                    <div style={{ fontSize:12, color:'var(--gw-mist)', marginTop:4, display:'flex', gap:14, flexWrap:'wrap' }}>
                      {r.email && <a href={`mailto:${r.email}`} style={{ color:'inherit' }}><Icon name="mail" size={11} /> {r.email}</a>}
                      {r.phone && <a href={`tel:${r.phone}`} style={{ color:'inherit' }}><Icon name="phone" size={11} /> {r.phone}</a>}
                      {r.visit_id && <span title="Came from a tracked QR scan"><Icon name="link" size={11} /> from a scan</span>}
                      {r.mailing_address && <span><Icon name="building" size={11} /> {r.mailing_address}</span>}
                      {r.buyer_role && <span style={{ textTransform:'capitalize' }}>{r.buyer_role}</span>}
                      {r.is_1031 === true && <span style={{ fontWeight:700, color:'var(--gw-ink)' }}>1031</span>}
                    </div>
                    {(ndaAttached || r.nda_signed_at) && (
                      <div style={{ fontSize:12, marginTop:6, display:'flex', gap:10, alignItems:'center', flexWrap:'wrap' }}>
                        {r.nda_signed_at ? (
                          <>
                            <span style={{ fontWeight:700, color:'#047857' }}>
                              <Icon name="check" size={11} /> NDA signed {new Date(r.nda_signed_at).toLocaleString()}
                            </span>
                            <span style={{ color:'var(--gw-mist)' }}>
                              as {r.nda_signer_name}{r.nda_signer_company ? ` · ${r.nda_signer_company}` : ''}
                            </span>
                            {r.nda_signed_copy_path && (
                              <button type="button" className="btn btn--ghost" style={{ fontSize:11.5, padding:'2px 8px' }}
                                      onClick={() => openSignedNda(r)}>
                                <Icon name="download" size={11} /> Signed NDA
                              </button>
                            )}
                          </>
                        ) : (
                          <span style={{ fontWeight:700, color:'#b45309' }}>NDA not signed — Deal Room locked</span>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {tab === 'subscribers' && (
          <>
            <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:12, flexWrap:'wrap' }}>
              <div style={{ fontSize:13, color:'var(--gw-mist)' }}>
                <strong style={{ color:'var(--gw-ink)' }}>{activeSubscribers.length}</strong> active
                {subscribers.length - activeSubscribers.length > 0 &&
                  <> · {subscribers.length - activeSubscribers.length} unsubscribed</>}
              </div>
              <button className="btn btn--ghost" style={{ fontSize:12, marginLeft:'auto' }}
                      onClick={() => { navigator.clipboard.writeText(shortUrl(mailing.qr_token)); pushToast('Signup link copied') }}>
                <Icon name="link" size={12} /> Copy signup link
              </button>
              <button className="btn btn--secondary" style={{ fontSize:12 }} disabled={subscribers.length === 0}
                      onClick={exportSubscribersCSV}>
                <Icon name="download" size={12} /> Export CSV
              </button>
            </div>
            {subscribers.length === 0 ? (
              <EmptyState title="No subscribers yet"
                          message="Share the QR code or signup link. Every email captured on the landing page lands here — deduped automatically." />
            ) : (
              <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                {subscribers.map(s => (
                  <div key={s.id} style={{ border:'1px solid var(--gw-border)', borderRadius:8, padding:'10px 12px',
                                           display:'flex', alignItems:'flex-start', gap:12,
                                           opacity: s.status === 'unsubscribed' ? 0.55 : 1 }}>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontWeight:700, fontSize:13 }}>
                        {s.email}
                        {s.status === 'unsubscribed' && (
                          <span style={{ marginLeft:8, fontSize:10, fontWeight:700, color:'#9d174d',
                                         background:'#fce7f3', padding:'1px 7px', borderRadius:8 }}>Unsubscribed</span>
                        )}
                      </div>
                      <div style={{ fontSize:11.5, color:'var(--gw-mist)', marginTop:2, display:'flex', gap:12, flexWrap:'wrap' }}>
                        {s.name && <span>{s.name}</span>}
                        {s.phone && <span><Icon name="phone" size={10} /> {s.phone}</span>}
                        <span>{new Date(s.subscribed_at || s.created_at).toLocaleDateString()}</span>
                      </div>
                      {s.message && (
                        <div style={{ fontSize:12.5, color:'var(--gw-ink)', marginTop:6, padding:'7px 9px',
                                      background:'var(--gw-bone)', borderRadius:6, lineHeight:1.45 }}>
                          “{s.message}”
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {tab === 'edit' && (
          <MailingForm initial={mailing} agents={agents} properties={properties} activeAgent={activeAgent}
                       saving={saving} onSave={saveEdit} onCancel={() => setTab('overview')} />
        )}
      </div>

      {importerOpen && (
        <Modal open={true} onClose={() => setImporterOpen(false)} width={640}>
          <div className="modal__head">
            <h3 style={{ margin:0, fontFamily:'var(--font-display)', fontSize:18 }}>Add Recipients</h3>
            <button className="drawer__close" onClick={() => setImporterOpen(false)}><Icon name="x" size={18} /></button>
          </div>
          <div style={{ padding:20 }}>
            <RecipientImporter
              mailingId={mailing.id}
              contacts={contacts}
              onDone={() => { setImporterOpen(false); refresh() }}
              onCancel={() => setImporterOpen(false)}
            />
          </div>
        </Modal>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="Delete mailing?"
          message={`This will permanently delete "${mailing.name}" along with all ${recipients.length} recipients, ${scans.length} scans, and ${leads.length} captured leads. This cannot be undone.`}
          confirmText="Delete"
          danger
          onConfirm={async () => {
            const res = await api('delete', { id: mailing.id })
            if (res.error) return pushToast(res.error, 'error')
            pushToast('Mailing deleted')
            onDelete(mailing.id)
            onClose()
          }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </Modal>
  )
}

// ─── "New in the Deal Room" email ─────────────────────────────────────────────
/**
 * Emails everyone registered for this Deal Room from the agent's own Outlook,
 * each with their own signed link (api/campaigns.js action=deal_room_notify).
 * Pick a saved update or write a note; a person gets each update once however
 * often Send is pressed, so a long list can be finished by pressing it again.
 */
function DealRoomNotify({ mailing, updates, registered }) {
  const [open, setOpen] = useState(false)
  const [updateId, setUpdateId] = useState(updates[0]?.id || '')
  const [note, setNote] = useState('')
  const [sending, setSending] = useState(false)

  const send = async () => {
    setSending(true)
    try {
      const r = await api('deal_room_notify', { mailing_id: mailing.id, update_id: updateId || null, note })
      if (r.error) throw new Error(r.error)
      const parts = [`Sent to ${r.sent}`]
      if (r.skipped) parts.push(`${r.skipped} skipped (already sent or opted out)`)
      if (r.failed) parts.push(`${r.failed} failed`)
      if (r.remaining) parts.push(`${r.remaining} left — press Send again`)
      pushToast(parts.join(' · '), r.failed ? 'error' : 'success')
      if (!r.remaining && !r.failed) setOpen(false)
    } catch (err) {
      pushToast(err.message, 'error')
    } finally {
      setSending(false)
    }
  }

  if (!registered) return null
  if (!open) {
    return (
      <button className="btn btn--primary" style={{ fontSize:12, marginBottom:12 }} onClick={() => setOpen(true)}>
        <Icon name="mail" size={12} /> Email everyone registered ({registered})
      </button>
    )
  }
  return (
    <div style={{ border:'1px solid #f0e0c0', background:'#fffdf8', borderRadius:10, padding:12, marginBottom:12, display:'grid', gap:8 }}>
      <div style={{ fontSize:13, fontWeight:700 }}>New in the Deal Room</div>
      <div style={{ fontSize:11.5, color:'var(--gw-mist)', lineHeight:1.45 }}>
        Goes from your Outlook to the {registered} people who registered. Each email carries their own link, so a click
        opens the Deal Room signed in and shows up here as a return visit.
      </div>
      <select className="input" value={updateId} onChange={e => setUpdateId(e.target.value)}>
        <option value="">No update — just my note</option>
        {updates.filter(u => u.title).map(u => (
          <option key={u.id} value={u.id}>{u.date ? `${u.date} — ` : ''}{u.title}</option>
        ))}
      </select>
      <textarea className="input" rows={3} value={note} onChange={e => setNote(e.target.value)}
                placeholder="We just uploaded the September financials. Occupancy improved to 91%. Call for Offers is October 8th — let me know if you have questions." />
      {!updates.length && (
        <div style={{ fontSize:11.5, color:'var(--gw-mist)' }}>Tip: add dated updates under Edit → Deal Room so they also show on the page.</div>
      )}
      <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
        <button className="btn btn--ghost" style={{ fontSize:12 }} onClick={() => setOpen(false)}>Cancel</button>
        <button className="btn btn--primary" style={{ fontSize:12 }} disabled={sending || (!updateId && !note.trim())} onClick={send}>
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  )
}
