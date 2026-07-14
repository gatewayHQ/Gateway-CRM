import React, { useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { Icon, Drawer, SearchDropdown, pushToast } from '../components/UI.jsx'
import { STAGE_LABELS } from '../lib/helpers.js'
import { TRACKS, UNIFIED } from '../lib/stages.js'
import { syncPropertyStatusForStage } from '../lib/services/deals.js'
import {
  CONTACT_TYPES, RESIDENTIAL_PROPERTY_TYPES, COMMERCIAL_PROPERTY_TYPES,
  PROPERTY_TYPE_LABELS, PROPERTY_STATUSES, isResidentialPropertyType, titleCase,
} from '../lib/enums.js'

function QuickContactDrawer({ open, onClose, agents, activeAgent, onSaved }) {
  const blank = () => ({ first_name: '', last_name: '', phone: '', email: '', type: 'buyer', assigned_agent_id: activeAgent?.id || '' })
  const [form, setForm] = useState(blank())
  const [saving, setSaving] = useState(false)
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }))

  React.useEffect(() => { setForm(blank()) }, [open, activeAgent?.id])

  const save = async () => {
    if (!form.first_name.trim() || !form.last_name.trim()) { pushToast('First and last name required', 'error'); return }
    setSaving(true)
    const { error } = await supabase.from('contacts').insert([{ ...form, status: 'active', source: 'other', tags: [], assigned_agent_id: form.assigned_agent_id || null }])
    setSaving(false)
    if (error) { pushToast(error.message, 'error'); return }
    pushToast(`${form.first_name} ${form.last_name} added to Contacts`)
    onSaved(); onClose()
  }

  return (
    <Drawer open={open} onClose={onClose} title="Quick Add Contact" width={400}>
      <div className="drawer__body">
        <div className="form-row">
          <div className="form-group">
            <label className="form-label required">First Name</label>
            <input className="form-control" autoFocus value={form.first_name} onChange={e => set('first_name', e.target.value)} placeholder="Jane" />
          </div>
          <div className="form-group">
            <label className="form-label required">Last Name</label>
            <input className="form-control" value={form.last_name} onChange={e => set('last_name', e.target.value)} placeholder="Smith" />
          </div>
        </div>
        <div className="form-group">
          <label className="form-label">Phone</label>
          <input className="form-control" type="tel" value={form.phone} onChange={e => set('phone', e.target.value)} placeholder="(555) 000-0000" />
        </div>
        <div className="form-group">
          <label className="form-label">Email</label>
          <input className="form-control" type="email" value={form.email} onChange={e => set('email', e.target.value)} placeholder="jane@email.com" />
        </div>
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Type</label>
            <select className="form-control" value={form.type} onChange={e => set('type', e.target.value)}>
              {['buyer', 'seller', 'investor', 'landlord', 'tenant'].map(t => <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Assign To</label>
            <select className="form-control" value={form.assigned_agent_id} onChange={e => set('assigned_agent_id', e.target.value)}>
              <option value="">Unassigned</option>
              {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
        </div>
      </div>
      <div className="drawer__foot">
        <button className="btn btn--secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn--primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Add Contact'}</button>
      </div>
    </Drawer>
  )
}

// Unified pipeline stages for a brand-new deal.
const DEAL_STAGES = TRACKS[UNIFIED].stages
// Form-facing property types (grouped residential + commercial), same set the
// Property drawer offers.
const FORM_PROPERTY_TYPES = [...RESIDENTIAL_PROPERTY_TYPES, ...COMMERCIAL_PROPERTY_TYPES]

// Section heading inside the drawer.
function SectionLabel({ children, first }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em',
      color: 'var(--gw-mist)', margin: first ? '0 0 12px' : '18px 0 12px',
      borderTop: first ? 'none' : '1px solid var(--gw-border)', paddingTop: first ? 0 : 14,
      display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      {children}
    </div>
  )
}

// Existing | New segmented toggle.
function Seg({ value, onChange, options }) {
  return (
    <div style={{ display: 'flex', gap: 0, border: '1px solid var(--gw-border)', borderRadius: 'var(--radius)', overflow: 'hidden', marginBottom: 10 }}>
      {options.map(([val, label]) => (
        <button key={val} type="button" onClick={() => onChange(val)}
          style={{ flex: 1, padding: '7px 0', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-body)',
            fontSize: 12, fontWeight: 600, transition: 'all 150ms',
            background: value === val ? 'var(--gw-slate)' : '#fff', color: value === val ? '#fff' : 'var(--gw-mist)' }}>
          {label}
        </button>
      ))}
    </div>
  )
}

// Full "New Deal" flow: fills contact + (optional) property + deal stage in one
// pass and creates each record, linked, so it lands on Contacts, Properties and
// the Pipeline with no follow-up editing. Contact can be an existing record or
// created inline; property is optional (a buyer with no chosen home yet).
function FullDealDrawer({ open, onClose, agents, contacts, properties, activeAgent, setDb }) {
  const blankDeal = () => ({ title: '', stage: 'lead', value: '', expected_close_date: '', agent_id: activeAgent?.id || '' })
  const BLANK_CONTACT = { first_name: '', last_name: '', phone: '', email: '', type: 'buyer' }
  const BLANK_PROPERTY = { address: '', city: '', state: '', zip: '', type: 'residential', status: 'active', list_price: '' }

  const [deal, setDeal]                 = useState(blankDeal())
  const [contactMode, setContactMode]   = useState('existing')  // existing | new
  const [contactId, setContactId]       = useState('')
  const [newContact, setNewContact]     = useState(BLANK_CONTACT)
  const [includeProperty, setIncludeProperty] = useState(true)
  const [propertyMode, setPropertyMode] = useState('new')       // existing | new
  const [propertyId, setPropertyId]     = useState('')
  const [newProperty, setNewProperty]   = useState(BLANK_PROPERTY)
  const [saving, setSaving]             = useState(false)

  React.useEffect(() => {
    if (!open) return
    setDeal(blankDeal())
    setContactMode('existing'); setContactId(''); setNewContact(BLANK_CONTACT)
    setIncludeProperty(true); setPropertyMode('new'); setPropertyId(''); setNewProperty(BLANK_PROPERTY)
    setSaving(false)
  }, [open, activeAgent?.id])

  const setD  = (k, v) => setDeal(p => ({ ...p, [k]: v }))
  const setNC = (k, v) => setNewContact(p => ({ ...p, [k]: v }))
  const setNP = (k, v) => setNewProperty(p => ({ ...p, [k]: v }))

  const save = async () => {
    // ── validate ──
    if (contactMode === 'existing' && !contactId) { pushToast('Pick a contact or switch to “New”', 'error'); return }
    if (contactMode === 'new' && (!newContact.first_name.trim() || !newContact.last_name.trim())) { pushToast('Contact first and last name required', 'error'); return }
    if (includeProperty && propertyMode === 'existing' && !propertyId) { pushToast('Pick a property or switch to “New”', 'error'); return }
    if (includeProperty && propertyMode === 'new' && !newProperty.address.trim()) { pushToast('Property address required', 'error'); return }

    setSaving(true)
    const agentId = deal.agent_id || activeAgent?.id || null
    try {
      // ── 1. Contact (link existing or create) ──
      let cId = contactId
      let contactRow = contacts.find(c => c.id === contactId) || null
      if (contactMode === 'new') {
        const { error, data } = await supabase.from('contacts').insert([{
          first_name: newContact.first_name.trim(), last_name: newContact.last_name.trim(),
          phone: newContact.phone || null, email: newContact.email || null,
          type: newContact.type, status: 'active', source: 'other', tags: [],
          assigned_agent_id: agentId,
        }]).select().single()
        if (error) { pushToast(`Contact: ${error.message}`, 'error'); setSaving(false); return }
        cId = data.id; contactRow = data
        setDb(p => ({ ...p, contacts: [data, ...(p.contacts || [])] }))
      }

      // ── 2. Property (optional — link existing or create) ──
      let pId = null, propType = null, propertyRow = null
      if (includeProperty) {
        if (propertyMode === 'existing') {
          pId = propertyId; propertyRow = properties.find(p => p.id === propertyId) || null; propType = propertyRow?.type
        } else {
          const { error, data } = await supabase.from('properties').insert([{
            address: newProperty.address.trim(), city: newProperty.city || null,
            state: newProperty.state || null, zip: newProperty.zip || null,
            type: newProperty.type, status: newProperty.status,
            list_price: newProperty.list_price ? Number(newProperty.list_price) : null,
            linked_contact_id: cId || null, assigned_agent_id: agentId,
          }]).select().single()
          if (error) { pushToast(`Property: ${error.message}`, 'error'); setSaving(false); return }
          pId = data.id; propType = data.type; propertyRow = data
          setDb(p => ({ ...p, properties: [data, ...(p.properties || [])] }))
        }
      }

      // ── 3. Deal (linked to both) ──
      const title = deal.title.trim()
        || propertyRow?.address
        || (contactRow ? `${contactRow.first_name} ${contactRow.last_name}` : '')
      if (!title) { pushToast('Add a deal title, property, or contact', 'error'); setSaving(false); return }
      const prop_category = propType ? (isResidentialPropertyType(propType) ? 'residential' : 'commercial') : 'residential'
      const { error: dealErr, data: dealRow } = await supabase.from('deals').insert([{
        title, stage: deal.stage,
        value: deal.value ? Number(deal.value) : null,
        expected_close_date: deal.expected_close_date || null,
        contact_id: cId || null, property_id: pId || null,
        agent_id: agentId, prop_category,
      }]).select().single()
      if (dealErr) { pushToast(`Deal: ${dealErr.message}`, 'error'); setSaving(false); return }
      setDb(p => ({ ...p, deals: [dealRow, ...(p.deals || [])] }))

      // ── 4. Under-contract → linked property goes Pending ──
      if (pId) {
        const sync = await syncPropertyStatusForStage(supabase, { property_id: pId }, deal.stage)
        if (sync.updated) setDb(p => ({ ...p, properties: (p.properties || []).map(pr => pr.id === pId ? { ...pr, status: 'pending' } : pr) }))
      }

      const created = ['deal']
      if (contactMode === 'new') created.push('contact')
      if (includeProperty && propertyMode === 'new') created.push('property')
      pushToast(`Created ${created.join(' + ')} — “${title}”`)
      setSaving(false)
      onClose()
    } catch (err) {
      console.error('[FullDealDrawer] save error:', err)
      pushToast('Something went wrong.', 'error')
      setSaving(false)
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title="Add Deal" width={480}>
      <div className="drawer__body">
        {/* ── Deal ── */}
        <SectionLabel first>Deal</SectionLabel>
        <div className="form-group">
          <label className="form-label">Deal Title <span style={{ fontWeight: 400, color: 'var(--gw-mist)' }}>— optional, defaults to the property or contact</span></label>
          <input className="form-control" autoFocus value={deal.title} onChange={e => setD('title', e.target.value)} placeholder="123 Main St — Purchase" />
        </div>
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Stage</label>
            <select className="form-control" value={deal.stage} onChange={e => setD('stage', e.target.value)}>
              {DEAL_STAGES.map(s => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Value</label>
            <input className="form-control" type="number" value={deal.value} onChange={e => setD('value', e.target.value)} placeholder="500000" />
          </div>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Expected Close</label>
            <input className="form-control" type="date" value={deal.expected_close_date} onChange={e => setD('expected_close_date', e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">Assign To</label>
            <select className="form-control" value={deal.agent_id} onChange={e => setD('agent_id', e.target.value)}>
              <option value="">Unassigned</option>
              {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
        </div>

        {/* ── Contact ── */}
        <SectionLabel>Contact</SectionLabel>
        <Seg value={contactMode} onChange={setContactMode} options={[['existing', 'Existing'], ['new', 'New']]} />
        {contactMode === 'existing' ? (
          <div className="form-group">
            <SearchDropdown items={contacts} value={contactId} onSelect={setContactId}
              placeholder="Search contacts…" labelKey={c => `${c.first_name} ${c.last_name}`} />
          </div>
        ) : (
          <>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label required">First Name</label>
                <input className="form-control" value={newContact.first_name} onChange={e => setNC('first_name', e.target.value)} placeholder="Jane" />
              </div>
              <div className="form-group">
                <label className="form-label required">Last Name</label>
                <input className="form-control" value={newContact.last_name} onChange={e => setNC('last_name', e.target.value)} placeholder="Smith" />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Phone</label>
                <input className="form-control" type="tel" value={newContact.phone} onChange={e => setNC('phone', e.target.value)} placeholder="(555) 000-0000" />
              </div>
              <div className="form-group">
                <label className="form-label">Email</label>
                <input className="form-control" type="email" value={newContact.email} onChange={e => setNC('email', e.target.value)} placeholder="jane@email.com" />
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Type</label>
              <select className="form-control" value={newContact.type} onChange={e => setNC('type', e.target.value)}>
                {CONTACT_TYPES.map(t => <option key={t} value={t}>{titleCase(t)}</option>)}
              </select>
            </div>
          </>
        )}

        {/* ── Property (optional) ── */}
        <SectionLabel>
          <span>Property</span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, textTransform: 'none', letterSpacing: 0, fontWeight: 500, fontSize: 12, cursor: 'pointer', color: 'var(--gw-ink)' }}>
            <input type="checkbox" checked={includeProperty} onChange={e => setIncludeProperty(e.target.checked)} />
            Add a property
          </label>
        </SectionLabel>
        {includeProperty && (
          <>
            <Seg value={propertyMode} onChange={setPropertyMode} options={[['existing', 'Existing'], ['new', 'New']]} />
            {propertyMode === 'existing' ? (
              <div className="form-group">
                <SearchDropdown items={properties} value={propertyId} onSelect={setPropertyId}
                  placeholder="Search properties…" labelKey="address" />
              </div>
            ) : (
              <>
                <div className="form-group">
                  <label className="form-label required">Address</label>
                  <input className="form-control" value={newProperty.address} onChange={e => setNP('address', e.target.value)} placeholder="123 Main St" />
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">City</label>
                    <input className="form-control" value={newProperty.city} onChange={e => setNP('city', e.target.value)} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">State</label>
                    <input className="form-control" value={newProperty.state} onChange={e => setNP('state', e.target.value)} placeholder="IA" />
                  </div>
                  <div className="form-group">
                    <label className="form-label">ZIP</label>
                    <input className="form-control" value={newProperty.zip} onChange={e => setNP('zip', e.target.value)} />
                  </div>
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">Type</label>
                    <select className="form-control" value={newProperty.type} onChange={e => setNP('type', e.target.value)}>
                      {FORM_PROPERTY_TYPES.map(t => <option key={t} value={t}>{PROPERTY_TYPE_LABELS[t] || titleCase(t)}</option>)}
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Status</label>
                    <select className="form-control" value={newProperty.status} onChange={e => setNP('status', e.target.value)}>
                      {PROPERTY_STATUSES.map(s => <option key={s} value={s}>{titleCase(s)}</option>)}
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label">List Price</label>
                    <input className="form-control" type="number" value={newProperty.list_price} onChange={e => setNP('list_price', e.target.value)} placeholder="500000" />
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </div>
      <div className="drawer__foot">
        <button className="btn btn--secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn--primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Create Deal'}</button>
      </div>
    </Drawer>
  )
}

function QuickTaskDrawer({ open, onClose, agents, activeAgent, onSaved }) {
  const defaultDue = () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d.toISOString().slice(0, 16) }
  const blank = () => ({ title: '', type: 'follow-up', priority: 'medium', due_date: defaultDue(), agent_id: activeAgent?.id || '' })
  const [form, setForm] = useState(blank())
  const [saving, setSaving] = useState(false)
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }))

  React.useEffect(() => { setForm(blank()) }, [open, activeAgent?.id])

  const save = async () => {
    if (!form.title.trim()) { pushToast('Task title required', 'error'); return }
    setSaving(true)
    const { error } = await supabase.from('tasks').insert([{ ...form, completed: false, agent_id: form.agent_id || null }])
    setSaving(false)
    if (error) { pushToast(error.message, 'error'); return }
    pushToast('Task added')
    onSaved(); onClose()
  }

  return (
    <Drawer open={open} onClose={onClose} title="Quick Add Task" width={400}>
      <div className="drawer__body">
        <div className="form-group">
          <label className="form-label required">Task</label>
          <input className="form-control" autoFocus value={form.title} onChange={e => set('title', e.target.value)} placeholder="Follow up with Jane Smith" />
        </div>
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Type</label>
            <select className="form-control" value={form.type} onChange={e => set('type', e.target.value)}>
              {['call', 'email', 'showing', 'follow-up', 'document', 'other'].map(t => <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Priority</label>
            <select className="form-control" value={form.priority} onChange={e => set('priority', e.target.value)}>
              {['high', 'medium', 'low'].map(p => <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>)}
            </select>
          </div>
        </div>
        <div className="form-group">
          <label className="form-label">Due</label>
          <input className="form-control" type="datetime-local" value={form.due_date} onChange={e => set('due_date', e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label">Assign To</label>
          <select className="form-control" value={form.agent_id} onChange={e => set('agent_id', e.target.value)}>
            <option value="">Unassigned</option>
            {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
      </div>
      <div className="drawer__foot">
        <button className="btn btn--secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn--primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Add Task'}</button>
      </div>
    </Drawer>
  )
}

const OPTIONS = [
  { id: 'task',    label: 'New Task',    icon: 'tasks',    bg: '#4a6fa5' },
  { id: 'deal',    label: 'New Deal',    icon: 'pipeline', bg: '#2e7d5e' },
  { id: 'contact', label: 'New Contact', icon: 'contacts', bg: '#c9a84c' },
]

export default function QuickAdd({ db, setDb, activeAgent }) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState(null)

  const reload = (table, key, order = 'created_at') => async () => {
    const { data } = await supabase.from(table).select('*').order(order, { ascending: table === 'tasks' })
    setDb(p => ({ ...p, [key]: data || [] }))
  }

  return (
    <>
      {open && <div style={{ position: 'fixed', inset: 0, zIndex: 498 }} onClick={() => setOpen(false)} />}

      <div className="fab-wrap">
        {open && (
          <div className="fab-menu">
            {OPTIONS.map(o => (
              <button key={o.id} className="fab-option" style={{ background: o.bg }}
                onClick={() => { setMode(o.id); setOpen(false) }}>
                <Icon name={o.icon} size={14} />
                {o.label}
              </button>
            ))}
          </div>
        )}
        <button className={`fab-btn${open ? ' fab-btn--open' : ''}`} onClick={() => setOpen(v => !v)} title="Quick add">
          <Icon name={open ? 'x' : 'plus'} size={22} />
        </button>
      </div>

      <QuickContactDrawer open={mode === 'contact'} onClose={() => setMode(null)}
        agents={db.agents || []} activeAgent={activeAgent}
        onSaved={reload('contacts', 'contacts')} />

      <FullDealDrawer open={mode === 'deal'} onClose={() => setMode(null)}
        agents={db.agents || []} contacts={db.contacts || []} properties={db.properties || []}
        activeAgent={activeAgent} setDb={setDb} />

      <QuickTaskDrawer open={mode === 'task'} onClose={() => setMode(null)}
        agents={db.agents || []} activeAgent={activeAgent}
        onSaved={reload('tasks', 'tasks', 'due_date')} />
    </>
  )
}
