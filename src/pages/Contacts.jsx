import React, { useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { formatDate, formatPhone, calcHeatScore } from '../lib/helpers.js'
import { Icon, Badge, Avatar, HeatBadge, Drawer, EmptyState, ConfirmDialog, SearchDropdown, pushToast } from '../components/UI.jsx'

const ACTIVITY_TYPES = ['note','call','email','meeting','showing']
const ACTIVITY_ICONS = { note:'note', call:'phone', email:'mail', meeting:'calendar', showing:'building' }
const ACTIVITY_COLORS = {
  note:    { bg:'var(--gw-bone)',       border:'var(--gw-border)',  icon:'var(--gw-mist)' },
  call:    { bg:'#e8f4fd',             border:'var(--gw-azure)',   icon:'var(--gw-azure)' },
  email:   { bg:'var(--gw-sky)',        border:'var(--gw-azure)',   icon:'var(--gw-azure)' },
  meeting: { bg:'#f0ebff',             border:'var(--gw-purple)',  icon:'var(--gw-purple)' },
  showing: { bg:'var(--gw-green-light)', border:'var(--gw-green)', icon:'var(--gw-green)' },
}

function ActivityTab({ contact, deals, tasks, activities, activeAgent, onActivityAdded }) {
  const [type, setType]       = useState('note')
  const [body, setBody]       = useState('')
  const [saving, setSaving]   = useState(false)

  const contactDeals      = (deals      || []).filter(d => d.contact_id === contact?.id)
  const contactTasks      = (tasks      || []).filter(t => t.contact_id === contact?.id)
  const contactActivities = (activities || []).filter(a => a.contact_id === contact?.id)

  const entries = [
    ...contactActivities.map(a => ({ kind: 'activity', date: a.created_at, data: a })),
    ...contactDeals.map(d      => ({ kind: 'deal',     date: d.created_at, data: d })),
    ...contactTasks.map(t      => ({ kind: 'task',     date: t.due_date || t.created_at, data: t })),
    ...(contact?.created_at    ? [{ kind: 'created',   date: contact.created_at, data: contact }] : []),
  ].sort((a, b) => new Date(b.date) - new Date(a.date))

  const logActivity = async () => {
    if (!body.trim()) return
    setSaving(true)
    const { data, error } = await supabase.from('activities').insert([{
      contact_id: contact.id,
      agent_id:   activeAgent?.id || null,
      type,
      body: body.trim(),
    }]).select().single()
    setSaving(false)
    if (error) { pushToast(error.message, 'error'); return }
    pushToast(`${type.charAt(0).toUpperCase() + type.slice(1)} logged`)
    setBody('')
    onActivityAdded(data)
  }

  const STAGE_COLORS = { lead:'var(--gw-mist)', qualified:'var(--gw-azure)', showing:'var(--gw-azure)', offer:'var(--gw-amber)', 'under-contract':'var(--gw-purple)', closed:'var(--gw-green)', lost:'var(--gw-red)' }
  const fmt = (d) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Log form */}
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--gw-border)', background: 'var(--gw-bone)', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
          {ACTIVITY_TYPES.map(t => (
            <button key={t} onClick={() => setType(t)}
              style={{ padding: '3px 10px', borderRadius: 14, border: `1px solid ${type === t ? 'var(--gw-azure)' : 'var(--gw-border)'}`, background: type === t ? 'var(--gw-azure)' : '#fff', color: type === t ? '#fff' : 'var(--gw-ink)', cursor: 'pointer', fontSize: 11, fontWeight: 600, fontFamily: 'var(--font-body)', transition: 'all 120ms' }}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="form-control" style={{ flex: 1, fontSize: 13 }}
            placeholder={`Log a ${type}…`}
            value={body} onChange={e => setBody(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !e.shiftKey && logActivity()}
            disabled={saving} />
          <button className="btn btn--primary btn--sm" onClick={logActivity} disabled={saving || !body.trim()} style={{ whiteSpace: 'nowrap' }}>
            {saving ? '…' : 'Log'}
          </button>
        </div>
      </div>

      {/* Timeline */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
        {entries.length === 0 ? (
          <div style={{ padding: '40px 24px', textAlign: 'center' }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>📋</div>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>No activity yet</div>
            <div style={{ fontSize: 13, color: 'var(--gw-mist)' }}>Log a call, note, or email above to get started.</div>
          </div>
        ) : (
          entries.map((entry, i) => {
            const isLast = i === entries.length - 1

            if (entry.kind === 'activity') {
              const a = entry.data
              const c = ACTIVITY_COLORS[a.type] || ACTIVITY_COLORS.note
              return (
                <div key={`act-${a.id}`} style={{ display: 'flex', gap: 12, padding: '10px 16px', position: 'relative' }}>
                  {!isLast && <div style={{ position: 'absolute', left: 27, top: 34, bottom: 0, width: 2, background: 'var(--gw-border)' }} />}
                  <div style={{ width: 22, height: 22, borderRadius: '50%', background: c.bg, border: `2px solid ${c.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 }}>
                    <Icon name={ACTIVITY_ICONS[a.type] || 'note'} size={10} style={{ color: c.icon }} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, textTransform: 'capitalize', color: 'var(--gw-mist)', marginBottom: 2 }}>{a.type}</div>
                    <div style={{ fontSize: 13, lineHeight: 1.5 }}>{a.body}</div>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--gw-mist)', whiteSpace: 'nowrap', marginTop: 2 }}>{fmt(a.created_at)}</div>
                </div>
              )
            }

            if (entry.kind === 'deal') {
              const d = entry.data
              return (
                <div key={`deal-${d.id}`} style={{ display: 'flex', gap: 12, padding: '10px 16px', position: 'relative' }}>
                  {!isLast && <div style={{ position: 'absolute', left: 27, top: 34, bottom: 0, width: 2, background: 'var(--gw-border)' }} />}
                  <div style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--gw-sky)', border: '2px solid var(--gw-azure)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 }}>
                    <Icon name="pipeline" size={10} style={{ color: 'var(--gw-azure)' }} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{d.title}</div>
                    <div style={{ fontSize: 11, marginTop: 2, display: 'flex', gap: 8 }}>
                      <span style={{ color: STAGE_COLORS[d.stage] || 'var(--gw-mist)', fontWeight: 600, textTransform: 'capitalize' }}>{d.stage.replace('-', ' ')}</span>
                      {d.value > 0 && <span style={{ color: 'var(--gw-mist)' }}>{new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(d.value)}</span>}
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--gw-mist)', whiteSpace: 'nowrap', marginTop: 2 }}>{fmt(entry.date)}</div>
                </div>
              )
            }

            if (entry.kind === 'task') {
              const t = entry.data
              const overdue  = !t.completed && t.due_date && new Date(t.due_date) < new Date()
              const typeIcon = t.type === 'call' ? 'phone' : t.type === 'email' ? 'mail' : t.type === 'showing' ? 'building' : 'tasks'
              return (
                <div key={`task-${t.id}`} style={{ display: 'flex', gap: 12, padding: '10px 16px', position: 'relative' }}>
                  {!isLast && <div style={{ position: 'absolute', left: 27, top: 34, bottom: 0, width: 2, background: 'var(--gw-border)' }} />}
                  <div style={{ width: 22, height: 22, borderRadius: '50%', background: t.completed ? 'var(--gw-green-light)' : 'var(--gw-bone)', border: `2px solid ${t.completed ? 'var(--gw-green)' : 'var(--gw-border)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 }}>
                    <Icon name={t.completed ? 'check' : typeIcon} size={10} style={{ color: t.completed ? 'var(--gw-green)' : 'var(--gw-mist)' }} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 13, textDecoration: t.completed ? 'line-through' : 'none', color: t.completed ? 'var(--gw-mist)' : 'inherit' }}>{t.title}</div>
                    <div style={{ fontSize: 11, marginTop: 2, color: overdue ? 'var(--gw-red)' : 'var(--gw-mist)', fontWeight: overdue ? 600 : 400 }}>
                      {t.completed ? 'Completed' : overdue ? 'Overdue' : t.priority + ' priority'} · {t.type}
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: overdue ? 'var(--gw-red)' : 'var(--gw-mist)', whiteSpace: 'nowrap', marginTop: 2 }}>
                    {t.due_date ? fmt(t.due_date) : '—'}
                  </div>
                </div>
              )
            }

            return (
              <div key="created" style={{ display: 'flex', gap: 12, padding: '10px 16px' }}>
                <div style={{ width: 22, height: 22, borderRadius: '50%', background: '#fef9ec', border: '2px solid var(--gw-amber)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 }}>
                  <Icon name="contacts" size={10} style={{ color: 'var(--gw-amber)' }} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>Added to CRM</div>
                  <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginTop: 2 }}>Contact record created</div>
                </div>
                <div style={{ fontSize: 11, color: 'var(--gw-mist)', whiteSpace: 'nowrap', marginTop: 2 }}>{new Date(entry.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

function ContactDrawer({ open, onClose, contact, agents, deals, tasks, activities, activeAgent, onSave, onActivityAdded }) {
  const blank = { first_name:'', last_name:'', email:'', phone:'', type:'buyer', status:'active', source:'other', assigned_agent_id:'', notes:'', tags:[], owner_address:'', owner_city:'', owner_state:'', owner_zip:'', birthday:'', anniversary_date:'', submarket:'', asset_types:[], size_min:'', size_max:'', size_unit:'sqft' }
  const blankProp = { address:'', list_price:'', type:'residential', subtype:'', beds:'', baths:'', sqft:'', garage:'', details:{} }
  const [form, setForm] = useState(contact || blank)
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)
  const [tab, setTab] = useState('details')
  const [addProp, setAddProp] = useState(false)
  const [propForm, setPropForm] = useState(blankProp)

  React.useEffect(() => {
    setForm(contact || blank)
    setErrors({})
    setTab('details')
    setAddProp(false)
    setPropForm(blankProp)
  }, [contact, open])

  const set = (k, v) => setForm(p => ({...p, [k]: v}))
  const setP = (k, v) => setPropForm(p => ({...p, [k]: v}))
  const setPD = (k, v) => setPropForm(p => ({...p, details: {...(p.details||{}), [k]: v}}))

  const COMM_SUBTYPES = ['multifamily','office','land','retail','industrial','mixed-use']
  const isComm = propForm.type === 'commercial'

  const validate = () => {
    const e = {}
    if (!form.first_name.trim()) e.first_name = true
    if (!form.last_name.trim()) e.last_name = true
    if (addProp && !propForm.address.trim()) e.prop_address = true
    setErrors(e)
    return Object.keys(e).length === 0
  }

  const save = async () => {
    if (!validate()) return
    setSaving(true)
    const payload = {
      ...form,
      birthday:          form.birthday          || null,
      anniversary_date:  form.anniversary_date  || null,
      assigned_agent_id: form.assigned_agent_id || null,
      email:             form.email?.trim()      || null,
      phone:             form.phone?.trim()      || null,
      size_min:          form.size_min  ? Number(form.size_min)  : null,
      size_max:          form.size_max  ? Number(form.size_max)  : null,
      size_unit:         form.size_unit || 'sqft',
      asset_types: Array.isArray(form.asset_types) ? form.asset_types : [],
      tags: typeof form.tags === 'string'
        ? form.tags.split(',').map(t => t.trim()).filter(Boolean)
        : (form.tags || []),
    }
    let error, contactId
    if (contact?.id) {
      ;({ error } = await supabase.from('contacts').update(payload).eq('id', contact.id))
      contactId = contact.id
    } else {
      const { data, error: e } = await supabase.from('contacts').insert([payload]).select().single()
      error = e; contactId = data?.id
    }
    if (error) { setSaving(false); pushToast(error.message, 'error'); return }

    if (addProp && propForm.address.trim() && contactId) {
      const propPayload = {
        address: propForm.address.trim(),
        type: propForm.type === 'commercial' ? (propForm.subtype || 'commercial') : 'residential',
        list_price: propForm.list_price ? Number(propForm.list_price) : null,
        beds: propForm.beds ? Number(propForm.beds) : null,
        baths: propForm.baths ? Number(propForm.baths) : null,
        sqft: propForm.sqft ? Number(propForm.sqft) : null,
        garage: propForm.garage ? Number(propForm.garage) : 0,
        details: { ...propForm.details, category: propForm.type },
        contact_id: contactId,
        status: 'active',
      }
      const { error: pe } = await supabase.from('properties').insert([propPayload])
      if (pe) pushToast(`Contact saved but property failed: ${pe.message}`, 'error')
      else pushToast('Contact & property saved')
    } else {
      pushToast(contact?.id ? 'Contact updated' : 'Contact added')
    }

    setSaving(false)
    onSave(); onClose()
  }

  const contactDeals      = (deals      || []).filter(d => d.contact_id === contact?.id)
  const contactTasks      = (tasks      || []).filter(t => t.contact_id === contact?.id)
  const contactActivities = (activities || []).filter(a => a.contact_id === contact?.id)
  const activityCount     = contactDeals.length + contactTasks.length + contactActivities.length

  const tabBtn = (id, label, count) => (
    <button onClick={() => setTab(id)} style={{
      padding: '8px 16px', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-body)', fontSize: 13, fontWeight: 600,
      background: tab === id ? '#fff' : 'transparent',
      color: tab === id ? 'var(--gw-slate)' : 'var(--gw-mist)',
      borderBottom: tab === id ? '2px solid var(--gw-slate)' : '2px solid transparent',
      transition: 'all 150ms',
    }}>
      {label}{count > 0 && tab !== id ? <span style={{ marginLeft: 5, background: 'var(--gw-azure)', color: '#fff', borderRadius: 10, fontSize: 10, padding: '1px 6px', fontWeight: 700 }}>{count}</span> : ''}
    </button>
  )

  return (
    <Drawer open={open} onClose={onClose} title={contact?.id ? `${contact.first_name} ${contact.last_name}` : 'Add Contact'} width={500}>
      {contact?.id && (
        <div style={{ display: 'flex', borderBottom: '1px solid var(--gw-border)', background: 'var(--gw-bone)', paddingLeft: 8 }}>
          {tabBtn('details', 'Details')}
          {tabBtn('activity', 'Activity', activityCount)}
        </div>
      )}

      {tab === 'details' && (
        <>
          <div className="drawer__body">
            <div className="form-row">
              <div className="form-group">
                <label className="form-label required">First Name</label>
                <input className={`form-control${errors.first_name?' error':''}`} value={form.first_name} onChange={e=>set('first_name',e.target.value)} placeholder="Jane" />
              </div>
              <div className="form-group">
                <label className="form-label required">Last Name</label>
                <input className={`form-control${errors.last_name?' error':''}`} value={form.last_name} onChange={e=>set('last_name',e.target.value)} placeholder="Smith" />
              </div>
            </div>
            <div className="form-group"><label className="form-label">Email</label><input className="form-control" type="email" value={form.email||''} onChange={e=>set('email',e.target.value)} placeholder="jane@email.com" /></div>
            <div className="form-group"><label className="form-label">Phone</label><input className="form-control" value={form.phone||''} onChange={e=>set('phone',e.target.value)} placeholder="(555) 000-0000" /></div>

            {/* ── Owner / Home Address ── */}
            <div style={{ borderTop:'1px solid var(--gw-border)', marginTop:4, paddingTop:14 }}>
              <div style={{ fontSize:11, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.08em', color:'var(--gw-mist)', marginBottom:10 }}>Owner Address</div>
              <div className="form-group"><label className="form-label">Street</label><input className="form-control" value={form.owner_address||''} onChange={e=>set('owner_address',e.target.value)} placeholder="123 Oak Lane" /></div>
              <div className="form-row">
                <div className="form-group"><label className="form-label">City</label><input className="form-control" value={form.owner_city||''} onChange={e=>set('owner_city',e.target.value)} /></div>
                <div className="form-group"><label className="form-label">State</label><input className="form-control" value={form.owner_state||''} onChange={e=>set('owner_state',e.target.value)} placeholder="TX" style={{ maxWidth:80 }} /></div>
                <div className="form-group"><label className="form-label">ZIP</label><input className="form-control" value={form.owner_zip||''} onChange={e=>set('owner_zip',e.target.value)} placeholder="78701" /></div>
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Type</label>
                <select className="form-control" value={form.type} onChange={e=>set('type',e.target.value)}>
                  {['buyer','seller','landlord','tenant','investor'].map(t=><option key={t} value={t}>{t.charAt(0).toUpperCase()+t.slice(1)}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Status</label>
                <select className="form-control" value={form.status} onChange={e=>set('status',e.target.value)}>
                  {['active','cold','closed'].map(s=><option key={s} value={s}>{s.charAt(0).toUpperCase()+s.slice(1)}</option>)}
                </select>
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Source</label>
                <select className="form-control" value={form.source||'other'} onChange={e=>set('source',e.target.value)}>
                  {['referral','website','open house','social','cold call','other'].map(s=><option key={s} value={s}>{s.charAt(0).toUpperCase()+s.slice(1)}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Assigned Agent</label>
                <select className="form-control" value={form.assigned_agent_id||''} onChange={e=>set('assigned_agent_id',e.target.value)}>
                  <option value="">Unassigned</option>
                  {agents.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </div>
            </div>
            <div className="form-group"><label className="form-label">Tags</label><input className="form-control" value={Array.isArray(form.tags)?form.tags.join(', '):(form.tags||'')} onChange={e=>set('tags',e.target.value)} placeholder="vip, referral, hot-lead" /><div className="form-hint">Comma separated</div></div>

            {/* ── Reminders ── */}
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Birthday</label>
                <input className="form-control" type="date" value={form.birthday||''} onChange={e=>set('birthday',e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">Closing Anniversary</label>
                <input className="form-control" type="date" value={form.anniversary_date||''} onChange={e=>set('anniversary_date',e.target.value)} />
              </div>
            </div>

            <div className="form-group"><label className="form-label">Notes</label><textarea className="form-control form-control--textarea" value={form.notes||''} onChange={e=>set('notes',e.target.value)} placeholder="Add notes…" /></div>

            {/* ── Investment / Buyer Criteria (buyer + investor only) ── */}
            {(form.type === 'buyer' || form.type === 'investor') && (
              <div style={{ borderTop:'1px solid var(--gw-border)', marginTop:4, paddingTop:14 }}>
                <div style={{ fontSize:11, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.08em', color:'var(--gw-mist)', marginBottom:10 }}>
                  {form.type === 'investor' ? 'Investment Criteria' : 'Buyer Criteria'}
                </div>
                <div className="form-group">
                  <label className="form-label">Target Market / Area</label>
                  <input className="form-control" value={form.submarket||''} onChange={e=>set('submarket',e.target.value)} placeholder="e.g. Austin, Travis County, Downtown" />
                </div>
                <div className="form-group">
                  <label className="form-label">Asset Types</label>
                  <div style={{ display:'flex', flexWrap:'wrap', gap:6, marginTop:4 }}>
                    {['residential','rental','multifamily','office','land','retail','industrial','mixed-use'].map(t => {
                      const on = (form.asset_types||[]).includes(t)
                      return (
                        <label key={t} style={{ display:'flex', alignItems:'center', gap:4, cursor:'pointer', fontSize:11, fontWeight:600, padding:'3px 10px', borderRadius:20,
                          color: on ? 'var(--gw-azure)' : 'var(--gw-mist)',
                          background: on ? 'var(--gw-sky)' : '#fff',
                          border: `1px solid ${on ? 'var(--gw-azure)' : 'var(--gw-border)'}`,
                          transition:'all 120ms', userSelect:'none' }}>
                          <input type="checkbox" checked={on} onChange={() => {
                            const current = form.asset_types||[]
                            set('asset_types', on ? current.filter(x=>x!==t) : [...current, t])
                          }} style={{ display:'none' }} />
                          {t.charAt(0).toUpperCase()+t.slice(1)}
                        </label>
                      )
                    })}
                  </div>
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">Min Size</label>
                    <input className="form-control" type="number" value={form.size_min||''} onChange={e=>set('size_min',e.target.value)} placeholder="0" />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Max Size</label>
                    <input className="form-control" type="number" value={form.size_max||''} onChange={e=>set('size_max',e.target.value)} placeholder="Any" />
                  </div>
                  <div className="form-group" style={{ maxWidth:90 }}>
                    <label className="form-label">Unit</label>
                    <select className="form-control" value={form.size_unit||'sqft'} onChange={e=>set('size_unit',e.target.value)}>
                      <option value="sqft">sqft</option>
                      <option value="acres">acres</option>
                      <option value="units">units</option>
                    </select>
                  </div>
                </div>
              </div>
            )}

            {/* ── Inline Add Property ────────────────────────────────── */}
            {!contact?.id && (
              <div style={{ borderTop: '1px solid var(--gw-border)', paddingTop: 14, marginTop: 4 }}>
                <button type="button" onClick={() => setAddProp(p => !p)}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, background: addProp ? 'var(--gw-sky)' : 'var(--gw-bone)', border: `1px solid ${addProp ? 'var(--gw-azure)' : 'var(--gw-border)'}`, borderRadius: 'var(--radius)', padding: '8px 14px', cursor: 'pointer', width: '100%', fontFamily: 'var(--font-body)', fontSize: 13, fontWeight: 600, color: addProp ? 'var(--gw-azure)' : 'var(--gw-slate)', transition: 'all 150ms' }}>
                  <Icon name="plus" size={14} />
                  {addProp ? 'Remove Property' : 'Add a Property'}
                  <span style={{ marginLeft: 'auto', fontSize: 10, opacity: 0.5 }}>{addProp ? '▲' : '▼'}</span>
                </button>

                {addProp && (
                  <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 0 }}>
                    <div className="form-group">
                      <label className="form-label required">Property Address</label>
                      <input className={`form-control${errors.prop_address?' error':''}`} value={propForm.address} onChange={e=>setP('address',e.target.value)} placeholder="123 Main St, City, State" />
                    </div>

                    {/* Residential / Commercial toggle */}
                    <div className="form-group">
                      <label className="form-label">Category</label>
                      <div style={{ display:'flex', border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', overflow:'hidden' }}>
                        {['residential','commercial'].map(cat => (
                          <button key={cat} type="button" onClick={() => { setP('type', cat); setP('subtype','') }}
                            style={{ flex:1, padding:'7px 0', border:'none', cursor:'pointer', fontFamily:'var(--font-body)', fontSize:12, fontWeight:600, transition:'all 150ms',
                              background: propForm.type === cat ? 'var(--gw-slate)' : '#fff',
                              color:      propForm.type === cat ? '#fff'            : 'var(--gw-mist)' }}>
                            {cat.charAt(0).toUpperCase()+cat.slice(1)}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Commercial subtype */}
                    {isComm && (
                      <div className="form-group">
                        <label className="form-label">Commercial Type</label>
                        <select className="form-control" value={propForm.subtype||''} onChange={e=>setP('subtype',e.target.value)}>
                          <option value="">— Select type —</option>
                          {COMM_SUBTYPES.map(t=><option key={t} value={t}>{t.charAt(0).toUpperCase()+t.slice(1)}</option>)}
                        </select>
                      </div>
                    )}

                    <div className="form-group">
                      <label className="form-label">{isComm ? 'Asking Price' : 'List Price'}</label>
                      <input className="form-control" type="number" value={propForm.list_price||''} onChange={e=>setP('list_price',e.target.value)} placeholder="0" />
                    </div>

                    {/* Residential fields */}
                    {!isComm && (
                      <>
                        <div className="form-row">
                          <div className="form-group"><label className="form-label">Beds</label><input className="form-control" type="number" value={propForm.beds||''} onChange={e=>setP('beds',e.target.value)} /></div>
                          <div className="form-group"><label className="form-label">Baths</label><input className="form-control" type="number" step="0.5" value={propForm.baths||''} onChange={e=>setP('baths',e.target.value)} /></div>
                        </div>
                        <div className="form-row">
                          <div className="form-group"><label className="form-label">Sq Ft</label><input className="form-control" type="number" value={propForm.sqft||''} onChange={e=>setP('sqft',e.target.value)} /></div>
                          <div className="form-group"><label className="form-label">Garage</label>
                            <select className="form-control" value={propForm.garage??''} onChange={e=>setP('garage',e.target.value)}>
                              <option value="">—</option><option value="0">No Garage</option><option value="1">1 Car</option><option value="2">2 Car</option><option value="3">3+ Car</option>
                            </select>
                          </div>
                        </div>
                      </>
                    )}

                    {/* Commercial — multifamily */}
                    {isComm && propForm.subtype === 'multifamily' && (
                      <div className="form-row">
                        <div className="form-group"><label className="form-label">Total Units</label><input className="form-control" type="number" value={propForm.details?.total_units||''} onChange={e=>setPD('total_units',e.target.value)} /></div>
                        <div className="form-group"><label className="form-label">Sq Ft (total)</label><input className="form-control" type="number" value={propForm.sqft||''} onChange={e=>setP('sqft',e.target.value)} /></div>
                      </div>
                    )}

                    {/* Commercial — office / retail / industrial */}
                    {isComm && ['office','retail','industrial'].includes(propForm.subtype) && (
                      <div className="form-row">
                        <div className="form-group"><label className="form-label">Sq Ft</label><input className="form-control" type="number" value={propForm.sqft||''} onChange={e=>setP('sqft',e.target.value)} /></div>
                        <div className="form-group"><label className="form-label">Price / SF</label><input className="form-control" type="number" step="0.01" value={propForm.details?.price_per_sf||''} onChange={e=>setPD('price_per_sf',e.target.value)} /></div>
                      </div>
                    )}

                    {/* Commercial — land */}
                    {isComm && propForm.subtype === 'land' && (
                      <div className="form-row">
                        <div className="form-group"><label className="form-label">Acres</label><input className="form-control" type="number" step="0.01" value={propForm.details?.acres||''} onChange={e=>setPD('acres',e.target.value)} /></div>
                        <div className="form-group"><label className="form-label">Zoning</label><input className="form-control" value={propForm.details?.zoning||''} onChange={e=>setPD('zoning',e.target.value)} placeholder="R-1, C-2…" /></div>
                      </div>
                    )}

                    {/* Commercial — mixed-use */}
                    {isComm && propForm.subtype === 'mixed-use' && (
                      <div className="form-row">
                        <div className="form-group"><label className="form-label">Sq Ft</label><input className="form-control" type="number" value={propForm.sqft||''} onChange={e=>setP('sqft',e.target.value)} /></div>
                        <div className="form-group"><label className="form-label">Units</label><input className="form-control" type="number" value={propForm.details?.total_units||''} onChange={e=>setPD('total_units',e.target.value)} /></div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="drawer__foot">
            <button className="btn btn--secondary" onClick={onClose}>Cancel</button>
            <button className="btn btn--primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save Contact'}</button>
          </div>
        </>
      )}

      {tab === 'activity' && (
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <ActivityTab
            contact={contact} deals={deals} tasks={tasks}
            activities={activities} activeAgent={activeAgent}
            onActivityAdded={onActivityAdded} />
        </div>
      )}
    </Drawer>
  )
}

// ── Simple RFC-4180 CSV parser ──────────────────────────────────────────────
function parseCSV(text) {
  const rows = []
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    if (!line.trim()) continue
    const row = []
    let cur = '', inQ = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === '"') { inQ = !inQ }
      else if (ch === ',' && !inQ) { row.push(cur.trim()); cur = '' }
      else { cur += ch }
    }
    row.push(cur.trim())
    rows.push(row)
  }
  return rows
}

const IMPORT_FIELDS = ['first_name','last_name','email','phone','type','source','status','notes']
const IMPORT_LABELS = { first_name:'First Name', last_name:'Last Name', email:'Email', phone:'Phone', type:'Type', source:'Source', status:'Status', notes:'Notes' }

function CSVImportModal({ onClose, onImported, agents, activeAgent }) {
  const [step, setStep]         = useState(1)   // 1=upload  2=map  3=preview  4=importing
  const [headers, setHeaders]   = useState([])
  const [rows, setRows]         = useState([])
  const [mapping, setMapping]   = useState({})
  const [progress, setProgress] = useState(0)
  const [errors, setErrors]     = useState([])

  const handleFile = (file) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = (e) => {
      const parsed = parseCSV(e.target.result)
      if (parsed.length < 2) { alert('File must have a header row and at least one data row.'); return }
      const hdrs = parsed[0]
      setHeaders(hdrs)
      setRows(parsed.slice(1))
      // Auto-map headers that match field names
      const auto = {}
      hdrs.forEach((h, i) => {
        const norm = h.toLowerCase().replace(/\s+/g,'_')
        const match = IMPORT_FIELDS.find(f => f === norm || f.replace('_','') === norm.replace('_',''))
        if (match) auto[match] = i
      })
      setMapping(auto)
      setStep(2)
    }
    reader.readAsText(file)
  }

  const preview = rows.slice(0, 5).map(row => {
    const obj = {}
    IMPORT_FIELDS.forEach(f => { if (mapping[f] !== undefined) obj[f] = row[mapping[f]] || '' })
    return obj
  })

  const doImport = async () => {
    setStep(4); setProgress(0); setErrors([])
    const validTypes   = ['buyer','seller','landlord','tenant','investor']
    const validSources = ['referral','website','open house','social','cold call','other']
    const validStatus  = ['active','cold','closed']
    const CHUNK = 50
    let done = 0, errs = []
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK).map(row => {
        const r = {}
        IMPORT_FIELDS.forEach(f => { if (mapping[f] !== undefined) r[f] = (row[mapping[f]] || '').trim() })
        return {
          first_name: r.first_name || '(Unknown)',
          last_name:  r.last_name  || '',
          email:      r.email  || null,
          phone:      r.phone  || null,
          type:       validTypes.includes(r.type?.toLowerCase())     ? r.type.toLowerCase()   : 'buyer',
          source:     validSources.includes(r.source?.toLowerCase()) ? r.source.toLowerCase() : 'other',
          status:     validStatus.includes(r.status?.toLowerCase())  ? r.status.toLowerCase() : 'active',
          notes:      r.notes  || null,
          assigned_agent_id: activeAgent?.id || null,
          tags: [],
        }
      })
      const { error } = await supabase.from('contacts').insert(chunk)
      if (error) errs.push(`Rows ${i+1}–${i+CHUNK}: ${error.message}`)
      done += chunk.length
      setProgress(Math.round(done / rows.length * 100))
    }
    setErrors(errs)
    if (errs.length === 0) {
      pushToast(`${rows.length} contacts imported`)
      onImported()
      onClose()
    }
  }

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(10,14,28,0.5)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:900, padding:24 }}>
      <div style={{ background:'#fff', borderRadius:14, width:'100%', maxWidth:560, boxShadow:'var(--shadow-modal)', display:'flex', flexDirection:'column', maxHeight:'90vh' }}>
        {/* Header */}
        <div style={{ padding:'20px 24px', borderBottom:'1px solid var(--gw-border)', display:'flex', justifyContent:'space-between', alignItems:'center', flexShrink:0 }}>
          <div>
            <div className="eyebrow-label">Contacts</div>
            <h3 style={{ margin:0, fontFamily:'var(--font-display)', fontSize:20 }}>Import CSV</h3>
          </div>
          <button className="drawer__close" onClick={onClose}><Icon name="x" size={18} /></button>
        </div>

        {/* Step 1 — Upload */}
        {step === 1 && (
          <div style={{ padding:24, flex:1, overflowY:'auto' }}>
            <p style={{ fontSize:13, color:'var(--gw-mist)', lineHeight:1.6, marginTop:0 }}>
              Upload a CSV with contacts. First row must be headers. Supported columns: <strong>first_name, last_name, email, phone, type, source, status, notes</strong>.
            </p>
            <label style={{ display:'block', border:'2px dashed var(--gw-border)', borderRadius:'var(--radius)', padding:'36px 24px', textAlign:'center', cursor:'pointer', transition:'all 150ms' }}
              onDragOver={e => { e.preventDefault(); e.currentTarget.style.borderColor = 'var(--gw-azure)' }}
              onDragLeave={e => { e.currentTarget.style.borderColor = 'var(--gw-border)' }}
              onDrop={e => { e.preventDefault(); handleFile(e.dataTransfer.files[0]) }}>
              <Icon name="upload" size={28} style={{ color:'var(--gw-border)', marginBottom:10 }} />
              <div style={{ fontWeight:600, marginBottom:6 }}>Drop CSV here or click to browse</div>
              <div style={{ fontSize:12, color:'var(--gw-mist)' }}>CSV files only</div>
              <input type="file" accept=".csv,text/csv" style={{ display:'none' }} onChange={e => handleFile(e.target.files[0])} />
            </label>
          </div>
        )}

        {/* Step 2 — Map columns */}
        {step === 2 && (
          <div style={{ padding:24, flex:1, overflowY:'auto' }}>
            <p style={{ fontSize:13, color:'var(--gw-mist)', marginTop:0, lineHeight:1.6 }}>
              Map your CSV columns to CRM fields. <strong>{rows.length} rows</strong> detected.
            </p>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:20 }}>
              {IMPORT_FIELDS.map(field => (
                <React.Fragment key={field}>
                  <div style={{ display:'flex', alignItems:'center', fontSize:13, fontWeight:600 }}>
                    {IMPORT_LABELS[field]}{['first_name','last_name'].includes(field) && <span style={{ color:'var(--gw-red)', marginLeft:2 }}>*</span>}
                  </div>
                  <select className="form-control" style={{ fontSize:12 }} value={mapping[field] ?? ''} onChange={e => setMapping(p => ({ ...p, [field]: e.target.value === '' ? undefined : Number(e.target.value) }))}>
                    <option value="">— Skip —</option>
                    {headers.map((h, i) => <option key={i} value={i}>{h}</option>)}
                  </select>
                </React.Fragment>
              ))}
            </div>
            <div style={{ display:'flex', gap:8 }}>
              <button className="btn btn--secondary" onClick={() => setStep(1)}>Back</button>
              <button className="btn btn--primary" onClick={() => setStep(3)} disabled={mapping.first_name === undefined}>Preview →</button>
            </div>
          </div>
        )}

        {/* Step 3 — Preview */}
        {step === 3 && (
          <div style={{ padding:24, flex:1, overflowY:'auto' }}>
            <p style={{ fontSize:13, color:'var(--gw-mist)', marginTop:0 }}>
              Preview of first {Math.min(5, rows.length)} rows (importing <strong>{rows.length} contacts</strong> total):
            </p>
            <div style={{ overflowX:'auto', marginBottom:20 }}>
              <table className="import-preview-table">
                <thead>
                  <tr>{IMPORT_FIELDS.filter(f => mapping[f] !== undefined).map(f => <th key={f}>{IMPORT_LABELS[f]}</th>)}</tr>
                </thead>
                <tbody>
                  {preview.map((row, i) => (
                    <tr key={i}>{IMPORT_FIELDS.filter(f => mapping[f] !== undefined).map(f => <td key={f}>{row[f] || '—'}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ display:'flex', gap:8 }}>
              <button className="btn btn--secondary" onClick={() => setStep(2)}>Back</button>
              <button className="btn btn--primary" onClick={doImport}><Icon name="import" size={13} /> Import {rows.length} Contacts</button>
            </div>
          </div>
        )}

        {/* Step 4 — Progress */}
        {step === 4 && (
          <div style={{ padding:40, textAlign:'center', flex:1 }}>
            <div style={{ fontWeight:600, fontSize:16, marginBottom:16 }}>Importing…</div>
            <div style={{ height:8, background:'var(--gw-border)', borderRadius:4, marginBottom:12, overflow:'hidden' }}>
              <div style={{ width:`${progress}%`, height:'100%', background:'var(--gw-azure)', borderRadius:4, transition:'width 200ms ease' }} />
            </div>
            <div style={{ fontSize:13, color:'var(--gw-mist)' }}>{progress}% complete</div>
            {errors.length > 0 && (
              <div style={{ marginTop:16, textAlign:'left' }}>
                {errors.map((e, i) => <div key={i} style={{ fontSize:12, color:'var(--gw-red)', marginBottom:4 }}>{e}</div>)}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default function ContactsPage({ db, setDb, activeAgent, go, openCompose }) {
  const [search, setSearch] = useState('')
  const [filterType, setFilterType] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [filterAgent, setFilterAgent] = useState('')
  const [drawer, setDrawer] = useState(false)
  const [editing, setEditing] = useState(null)
  const [confirm, setConfirm] = useState(null)
  const [sortKey, setSortKey] = useState('created_at')
  const [sortDir, setSortDir] = useState('desc')
  const [filterHeat, setFilterHeat] = useState('')
  const [importModal, setImportModal] = useState(false)

  const contacts    = db.contacts    || []
  const agents      = db.agents      || []
  const activities  = db.activities  || []
  const deals       = db.deals       || []

  const filtered = contacts.filter(c => {
    const name = `${c.first_name} ${c.last_name}`.toLowerCase()
    const q = search.toLowerCase()
    if (q && !name.includes(q) && !(c.email||'').toLowerCase().includes(q) && !(c.phone||'').includes(q)) return false
    if (filterType   && c.type               !== filterType)   return false
    if (filterStatus && c.status             !== filterStatus) return false
    if (filterAgent  && c.assigned_agent_id  !== filterAgent)  return false
    if (filterHeat   && calcHeatScore(c, activities, deals)    !== filterHeat) return false
    return true
  }).sort((a, b) => {
    let av = a[sortKey]||'', bv = b[sortKey]||''
    return sortDir === 'asc' ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1)
  })

  const reload = async () => {
    const { data } = await supabase.from('contacts').select('*').order('created_at', { ascending: false })
    setDb(p => ({ ...p, contacts: data || [] }))
  }

  const deleteContact = async (id) => {
    await supabase.from('contacts').delete().eq('id', id)
    pushToast('Contact deleted', 'info')
    setConfirm(null)
    reload()
  }

  const sort = (key) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
  }

  const SortIcon = ({ k }) => sortKey === k ? <Icon name={sortDir === 'asc' ? 'chevronRight' : 'chevronDown'} size={12} /> : null

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <div className="page-title">Contacts</div>
          <div className="page-sub">{contacts.length} total contacts</div>
        </div>
        <div style={{ display:'flex', gap:8 }}>
          <button className="btn btn--secondary" onClick={() => setImportModal(true)}><Icon name="import" size={14} /> Import CSV</button>
          <button className="btn btn--primary" onClick={() => { setEditing(null); setDrawer(true) }}><Icon name="plus" size={14} /> Add Contact</button>
        </div>
      </div>

      <div className="filters-bar">
        <div style={{ display:'flex', alignItems:'center', gap:8, background:'#fff', border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', padding:'0 10px', height:34, flex:1, maxWidth:300 }}>
          <Icon name="search" size={14} style={{ color:'var(--gw-mist)' }} />
          <input style={{ border:'none', outline:'none', fontSize:13, flex:1 }} placeholder="Search contacts…" value={search} onChange={e=>setSearch(e.target.value)} />
        </div>
        <select className="filter-select" value={filterType} onChange={e=>setFilterType(e.target.value)}>
          <option value="">All Types</option>
          {['buyer','seller','landlord','tenant','investor'].map(t=><option key={t} value={t}>{t.charAt(0).toUpperCase()+t.slice(1)}</option>)}
        </select>
        <select className="filter-select" value={filterStatus} onChange={e=>setFilterStatus(e.target.value)}>
          <option value="">All Statuses</option>
          {['active','cold','closed'].map(s=><option key={s} value={s}>{s.charAt(0).toUpperCase()+s.slice(1)}</option>)}
        </select>
        <select className="filter-select" value={filterAgent} onChange={e=>setFilterAgent(e.target.value)}>
          <option value="">All Agents</option>
          {agents.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <select className="filter-select" value={filterHeat} onChange={e=>setFilterHeat(e.target.value)}>
          <option value="">All Heat</option>
          <option value="hot">🔥 Hot</option>
          <option value="warm">▲ Warm</option>
          <option value="cold">– Cold</option>
        </select>
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon="contacts" title="No contacts yet" message="Add your first contact to get started with your CRM."
          action={<button className="btn btn--primary" onClick={() => { setEditing(null); setDrawer(true) }}><Icon name="plus" size={14} /> Add Contact</button>} />
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th className="sortable" onClick={() => sort('first_name')}>Name <SortIcon k="first_name" /></th>
                <th>Heat</th>
                <th>Type</th>
                <th>Status</th>
                <th className="sortable" onClick={() => sort('phone')}>Phone <SortIcon k="phone" /></th>
                <th className="sortable" onClick={() => sort('email')}>Email <SortIcon k="email" /></th>
                <th>Agent</th>
                <th className="sortable" onClick={() => sort('last_contacted_at')}>Last Contact <SortIcon k="last_contacted_at" /></th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(c => {
                const agent = agents.find(a => a.id === c.assigned_agent_id)
                return (
                  <tr key={c.id} onClick={() => { setEditing(c); setDrawer(true) }}>
                    <td>
                      <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                        <div style={{ width:30, height:30, borderRadius:'var(--radius)', background:'var(--gw-sky)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:11, fontWeight:700, color:'var(--gw-azure)', flexShrink:0 }}>
                          {(c.first_name||'')[0]}{(c.last_name||'')[0]}
                        </div>
                        <div>
                          <div style={{ fontWeight:600 }}>{c.first_name} {c.last_name}</div>
                          {c.tags?.length > 0 && <div style={{ fontSize:11, color:'var(--gw-mist)' }}>{c.tags.slice(0,2).join(', ')}</div>}
                        </div>
                      </div>
                    </td>
                    <td><HeatBadge score={calcHeatScore(c, activities, deals)} /></td>
                    <td><Badge variant={c.type}>{c.type}</Badge></td>
                    <td><Badge variant={c.status}>{c.status}</Badge></td>
                    <td style={{ fontFamily:'var(--font-mono)', fontSize:12 }}>{formatPhone(c.phone)}</td>
                    <td style={{ fontSize:12 }}>{c.email || '—'}</td>
                    <td>{agent ? <div style={{ display:'flex', alignItems:'center', gap:6 }}><Avatar agent={agent} size={24} /><span style={{ fontSize:12 }}>{agent.name}</span></div> : '—'}</td>
                    <td style={{ fontSize:12, color:'var(--gw-mist)' }}>{formatDate(c.last_contacted_at)}</td>
                    <td onClick={e => e.stopPropagation()}>
                      <div style={{ display:'flex', gap:4 }}>
                        <button className="btn btn--ghost btn--icon" title="Email" onClick={() => openCompose({ to: c.email, contactName: `${c.first_name} ${c.last_name}` })}><Icon name="mail" size={13} /></button>
                        <button className="btn btn--ghost btn--icon" title="Edit" onClick={() => { setEditing(c); setDrawer(true) }}><Icon name="edit" size={13} /></button>
                        <button className="btn btn--ghost btn--icon" title="Delete" onClick={() => setConfirm(c.id)}><Icon name="trash" size={13} /></button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          </div>
        </div>
      )}

      <ContactDrawer
        open={drawer} onClose={() => setDrawer(false)}
        contact={editing} agents={agents} deals={deals}
        tasks={db.tasks||[]} activities={activities}
        activeAgent={activeAgent}
        onActivityAdded={act => setDb(p => ({ ...p, activities: [act, ...(p.activities || [])] }))}
        onSave={reload}
      />
      {confirm && <ConfirmDialog message="This will permanently delete this contact." onConfirm={() => deleteContact(confirm)} onCancel={() => setConfirm(null)} />}
      {importModal && (
        <CSVImportModal
          agents={agents} activeAgent={activeAgent}
          onClose={() => setImportModal(false)}
          onImported={reload}
        />
      )}
    </div>
  )
}
