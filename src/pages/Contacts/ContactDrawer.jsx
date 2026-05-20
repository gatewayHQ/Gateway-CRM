import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '../../lib/supabase.js'
import { Drawer, Tabs, pushToast } from '../../components/UI.jsx'
import { normalizePhone } from '../../lib/phone.js'
import { validateEmail, validateRequired, validateForm } from '../../lib/validation.js'
import OptionMultiSelect from '../../components/OptionMultiSelect.jsx'
import ChipToggleGroup from '../../components/ChipToggleGroup.jsx'
import ActivityTab from './ActivityTab.jsx'
import { findMatchingProperties } from '../../lib/matching.js'
import { formatCurrency } from '../../lib/helpers.js'

const BLANK = {
  first_name: '', last_name: '', email: '', phone: '',
  type: 'buyer', status: 'active', source: 'other',
  assigned_agent_id: '', notes: '', tags: [],
  owner_address: '', owner_city: '', owner_state: '', owner_zip: '',
  birthday: '', anniversary_date: '',
  submarket: '', submarkets: [], asset_types: [],
  size_min: '', size_max: '', size_unit: 'sqft',
}
const BLANK_PROP = { address: '', list_price: '', type: 'residential', subtype: '', beds: '', baths: '', sqft: '', garage: '', details: {} }

const COMM_SUBTYPES = ['multifamily', 'office', 'land', 'retail', 'industrial', 'mixed-use']

export default function ContactDrawer({
  open, onClose, contact, agents,
  deals, tasks, activities, activeAgent,
  allTags = [],
  properties = [],
  onSave, onActivityAdded,
  onDuplicateCheck,  // optional: (form) => existingContact | null
}) {
  const [form, setForm] = useState(BLANK)
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)
  const [tab, setTab] = useState('details')
  const [addProp, setAddProp] = useState(false)
  const [propForm, setPropForm] = useState(BLANK_PROP)
  const [dirty, setDirty] = useState(false)
  const [duplicateWarn, setDuplicateWarn] = useState(null)

  // Reset on contact change
  useEffect(() => {
    if (contact) {
      // Backfill submarkets[] from legacy single-value submarket if needed
      const submarkets = Array.isArray(contact.submarkets) && contact.submarkets.length
        ? contact.submarkets
        : (contact.submarket ? [contact.submarket] : [])
      setForm({
        ...BLANK,
        ...contact,
        submarkets,
        tags:        Array.isArray(contact.tags)        ? contact.tags        : [],
        asset_types: Array.isArray(contact.asset_types) ? contact.asset_types : [],
      })
    } else {
      setForm(BLANK)
    }
    setErrors({})
    setTab('details')
    setAddProp(false)
    setPropForm(BLANK_PROP)
    setDirty(false)
    setDuplicateWarn(null)
  }, [contact, open])

  const set = useCallback((k, v) => {
    setForm(p => ({ ...p, [k]: v }))
    setDirty(true)
  }, [])
  const setP  = useCallback((k, v) => { setPropForm(p => ({ ...p, [k]: v })); setDirty(true) }, [])
  const setPD = useCallback((k, v) => { setPropForm(p => ({ ...p, details: { ...(p.details || {}), [k]: v } })); setDirty(true) }, [])

  // Dirty-form warning on close
  const requestClose = () => {
    if (dirty && !saving) {
      if (!confirm('You have unsaved changes. Discard them?')) return
    }
    onClose()
  }

  const isComm = propForm.type === 'commercial'
  const isBuyer  = form.type === 'buyer' || form.type === 'investor'
  const isSeller = form.type === 'seller' || form.type === 'landlord'
  const hasCriteria = isBuyer || isSeller

  const save = async () => {
    // Validate
    const { valid, errors: validationErrors } = validateForm(form, {
      first_name: [(v) => validateRequired(v, 'First name')],
      last_name:  [(v) => validateRequired(v, 'Last name')],
      email:      [(v) => validateEmail(v, { required: false })],
    })
    if (!valid) { setErrors(validationErrors); return }
    if (addProp && !propForm.address.trim()) {
      setErrors({ prop_address: 'Property address is required' })
      return
    }
    setErrors({})

    // Duplicate check (creating only — not editing)
    if (!contact?.id && onDuplicateCheck) {
      const dup = onDuplicateCheck(form)
      if (dup && !duplicateWarn) {
        setDuplicateWarn(dup)
        return  // First click surfaces the warning; second click proceeds
      }
    }

    setSaving(true)

    // Normalize phone to E.164 before storing
    const normalizedPhone = form.phone ? normalizePhone(form.phone) : null
    if (form.phone && !normalizedPhone) {
      setSaving(false)
      setErrors({ phone: 'Could not parse phone number' })
      return
    }

    const { submarket, submarkets, asset_types, size_min, size_max, size_unit, ...baseForm } = form
    const submarketList = Array.isArray(submarkets) ? submarkets.filter(Boolean) : []

    const payload = {
      ...baseForm,
      birthday:          form.birthday || null,
      anniversary_date:  form.anniversary_date || null,
      assigned_agent_id: form.assigned_agent_id || null,
      email:             form.email?.trim() || null,
      phone:             normalizedPhone,
      tags:              Array.isArray(form.tags) ? form.tags : [],
      ...(hasCriteria && {
        // Keep legacy single-value submarket synced for backward compatibility
        submarket:   submarketList[0] || null,
        submarkets:  submarketList,
        asset_types: Array.isArray(asset_types) ? asset_types : [],
        // For sellers, size_min holds the exact property size and size_max is unused.
        size_min:    size_min ? Number(size_min) : null,
        size_max:    isBuyer && size_max ? Number(size_max) : null,
        size_unit:   size_unit || 'sqft',
      }),
    }

    const doSave = (p) => contact?.id
      ? supabase.from('contacts').update(p).eq('id', contact.id).select().single()
      : supabase.from('contacts').insert([p]).select().single()

    let { data: saved, error } = await doSave(payload)

    // Migration-pending fallback
    let criteriaDropped = false
    if (error?.message?.includes('schema cache') && isBuyer) {
      const { submarket: _s, submarkets: _ss, asset_types: _a, size_min: _mn, size_max: _mx, size_unit: _u, ...payloadNoCriteria } = payload
      ;({ data: saved, error } = await doSave(payloadNoCriteria))
      if (!error) criteriaDropped = true
    }

    if (error) {
      setSaving(false)
      pushToast(error.message, 'error')
      return
    }

    const contactId = saved?.id || contact?.id

    if (addProp && propForm.address.trim() && contactId) {
      const propPayload = {
        address:    propForm.address.trim(),
        type:       propForm.type === 'commercial' ? (propForm.subtype || 'commercial') : 'residential',
        list_price: propForm.list_price ? Number(propForm.list_price) : null,
        beds:       propForm.beds  ? Number(propForm.beds)  : null,
        baths:      propForm.baths ? Number(propForm.baths) : null,
        sqft:       propForm.sqft  ? Number(propForm.sqft)  : null,
        garage:     propForm.garage ? Number(propForm.garage) : 0,
        details:    { ...propForm.details, category: propForm.type },
        linked_contact_id: contactId,
        status:     'active',
      }
      const { error: pe } = await supabase.from('properties').insert([propPayload])
      if (pe) pushToast(`Contact saved but property failed: ${pe.message}`, 'error')
      else pushToast(criteriaDropped ? 'Contact & property saved (run DB migration to store buyer criteria)' : 'Contact & property saved')
    } else {
      pushToast(criteriaDropped
        ? 'Contact saved — run DB migration to store buyer criteria'
        : (contact?.id ? 'Contact updated' : 'Contact added'))
    }

    setSaving(false)
    setDirty(false)
    onSave?.(saved)
    onClose()
  }

  const contactDeals      = (deals      || []).filter(d => d.contact_id === contact?.id)
  const contactTasks      = (tasks      || []).filter(t => t.contact_id === contact?.id)
  const contactActivities = (activities || []).filter(a => a.contact_id === contact?.id)
  const activityCount     = contactDeals.length + contactTasks.length + contactActivities.length

  // Compute matching properties using the live form state so matches update as criteria change
  const matchingProperties = useMemo(() => {
    if (!isBuyer) return []
    return findMatchingProperties(form, properties)
  }, [form, properties, isBuyer])

  return (
    <Drawer
      open={open}
      onClose={requestClose}
      title={contact?.id ? `${contact.first_name} ${contact.last_name}` : 'Add Contact'}
      width={500}
    >
      {contact?.id && (
        <Tabs
          active={tab}
          onChange={setTab}
          tabs={[
            { id: 'details',  label: 'Details',  count: 0 },
            { id: 'activity', label: 'Activity', count: activityCount },
            ...(isBuyer ? [{ id: 'matches', label: 'Matches', count: matchingProperties.length }] : []),
          ]}
        />
      )}

      {tab === 'details' && (
        <>
          <div className="drawer__body">
            {duplicateWarn && (
              <div style={{
                background: 'var(--gw-amber-light, #fef3c7)',
                border: '1px solid var(--gw-amber)',
                borderRadius: 'var(--radius)',
                padding: '10px 12px',
                marginBottom: 14,
                fontSize: 12,
              }}>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>
                  Possible duplicate: {duplicateWarn.first_name} {duplicateWarn.last_name}
                </div>
                <div style={{ color: 'var(--gw-mist)' }}>
                  {duplicateWarn.email && <span>{duplicateWarn.email} · </span>}
                  {duplicateWarn.phone && <span>{duplicateWarn.phone}</span>}
                </div>
                <div style={{ marginTop: 6, fontSize: 11, color: 'var(--gw-mist)' }}>
                  Click "Save" again to add anyway.
                </div>
              </div>
            )}

            <div className="form-row">
              <div className="form-group">
                <label className="form-label required">First Name</label>
                <input
                  className={`form-control${errors.first_name ? ' error' : ''}`}
                  value={form.first_name}
                  onChange={(e) => set('first_name', e.target.value)}
                  placeholder="Jane"
                />
                {errors.first_name && <div className="form-hint" style={{ color: 'var(--gw-red)' }}>{errors.first_name}</div>}
              </div>
              <div className="form-group">
                <label className="form-label required">Last Name</label>
                <input
                  className={`form-control${errors.last_name ? ' error' : ''}`}
                  value={form.last_name}
                  onChange={(e) => set('last_name', e.target.value)}
                  placeholder="Smith"
                />
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Email</label>
              <input
                className={`form-control${errors.email ? ' error' : ''}`}
                type="email"
                value={form.email || ''}
                onChange={(e) => set('email', e.target.value)}
                placeholder="jane@email.com"
              />
              {errors.email && <div className="form-hint" style={{ color: 'var(--gw-red)' }}>{errors.email}</div>}
            </div>

            <div className="form-group">
              <label className="form-label">Phone</label>
              <input
                className={`form-control${errors.phone ? ' error' : ''}`}
                value={form.phone || ''}
                onChange={(e) => set('phone', e.target.value)}
                placeholder="(555) 000-0000"
              />
              {errors.phone && <div className="form-hint" style={{ color: 'var(--gw-red)' }}>{errors.phone}</div>}
            </div>

            {/* Owner Address */}
            <div style={{ borderTop: '1px solid var(--gw-border)', marginTop: 4, paddingTop: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--gw-mist)', marginBottom: 10 }}>
                Owner Address
              </div>
              <div className="form-group">
                <label className="form-label">Street</label>
                <input className="form-control" value={form.owner_address || ''} onChange={(e) => set('owner_address', e.target.value)} placeholder="123 Oak Lane" />
              </div>
              <div className="form-row">
                <div className="form-group"><label className="form-label">City</label><input className="form-control" value={form.owner_city || ''} onChange={(e) => set('owner_city', e.target.value)} /></div>
                <div className="form-group"><label className="form-label">State</label><input className="form-control" value={form.owner_state || ''} onChange={(e) => set('owner_state', e.target.value)} placeholder="TX" style={{ maxWidth: 80 }} /></div>
                <div className="form-group"><label className="form-label">ZIP</label><input className="form-control" value={form.owner_zip || ''} onChange={(e) => set('owner_zip', e.target.value)} placeholder="78701" /></div>
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Type</label>
                <select className="form-control" value={form.type} onChange={(e) => { set('type', e.target.value) }}>
                  {['buyer','seller','landlord','tenant','investor'].map(t => <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Status</label>
                <select className="form-control" value={form.status} onChange={(e) => set('status', e.target.value)}>
                  {['active','cold','closed'].map(s => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
                </select>
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Source</label>
                <select className="form-control" value={form.source || 'other'} onChange={(e) => set('source', e.target.value)}>
                  {['referral','website','open house','social','cold call','other'].map(s => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Assigned Agent</label>
                <select className="form-control" value={form.assigned_agent_id || ''} onChange={(e) => set('assigned_agent_id', e.target.value)}>
                  <option value="">Unassigned</option>
                  {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </div>
            </div>

            {/* ── Buyer / Seller Criteria ────────────────────────────────────────
                Shown right after the Type selector so agents don't have to scroll.
                Buyer/investor → submarkets + asset types they WANT + size range.
                Seller/landlord → submarket + asset type they OWN + exact size.
                All fields optional — no match is made when left empty.          */}
            {hasCriteria && (
              <CriteriaCard
                isBuyer={isBuyer}
                isSeller={isSeller}
                contactType={form.type}
                form={form}
                set={set}
              />
            )}

            {/* Tags — compact select-style: shows selected chips + search to add */}
            <div className="form-group">
              <label className="form-label">
                Tags
                <span style={{ fontWeight: 400, color: 'var(--gw-mist)', fontSize: 11 }}> — optional</span>
              </label>
              <ChipToggleGroup
                mode="select"
                fieldKey="tag"
                value={Array.isArray(form.tags) ? form.tags : []}
                onChange={(v) => set('tags', v)}
                placeholder="Search or add tags…"
                allowAdd
              />
            </div>

            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Birthday</label>
                <input className="form-control" type="date" value={form.birthday || ''} onChange={(e) => set('birthday', e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">Closing Anniversary</label>
                <input className="form-control" type="date" value={form.anniversary_date || ''} onChange={(e) => set('anniversary_date', e.target.value)} />
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Notes</label>
              <textarea className="form-control form-control--textarea" value={form.notes || ''} onChange={(e) => set('notes', e.target.value)} placeholder="Add notes…" />
            </div>
          </div>
          <div className="drawer__foot">
            <button className="btn btn--secondary" onClick={requestClose}>Cancel</button>
            <button className="btn btn--primary" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : duplicateWarn ? 'Save anyway' : 'Save Contact'}
            </button>
          </div>
        </>
      )}

      {tab === 'activity' && (
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <ActivityTab
            contact={contact}
            deals={deals}
            tasks={tasks}
            activities={activities}
            activeAgent={activeAgent}
            onActivityAdded={onActivityAdded}
          />
        </div>
      )}

      {tab === 'matches' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--gw-mist)', lineHeight: 1.6 }}>
            Properties that match this contact's submarket, asset type, and size criteria.
            Update their <strong>Buyer Criteria</strong> in the Details tab to see more or fewer matches.
          </div>

          {matchingProperties.length === 0 ? (
            <div style={{
              flex: 1, display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center',
              textAlign: 'center', color: 'var(--gw-mist)', padding: '40px 20px',
            }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>🏘️</div>
              <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--gw-ink)' }}>No matching properties</div>
              <div style={{ fontSize: 12 }}>
                {form.submarkets?.length === 0 || form.asset_types?.length === 0
                  ? 'Add submarkets and asset types in the Details tab to enable matching.'
                  : 'No active listings match their submarket, asset type, and size criteria right now.'}
              </div>
            </div>
          ) : (
            matchingProperties.map(p => (
              <div key={p.id} style={{
                border: '1px solid var(--gw-border)',
                borderRadius: 'var(--radius)',
                padding: '12px 14px',
                background: '#fff',
              }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--gw-ink)', marginBottom: 2 }}>
                      {p.address}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--gw-mist)' }}>
                      {[p.city, p.state].filter(Boolean).join(', ')}
                      {p.submarket ? ` · ${p.submarket}` : ''}
                    </div>
                  </div>
                  {p.list_price && (
                    <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--gw-gold, #C8A84B)', whiteSpace: 'nowrap' }}>
                      {formatCurrency(p.list_price)}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                  {p.type && (
                    <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 99, background: 'var(--gw-sky)', color: 'var(--gw-azure)', fontWeight: 600 }}>
                      {p.type}
                    </span>
                  )}
                  {p.sqft && (
                    <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 99, background: 'var(--gw-bone)', color: 'var(--gw-mist)' }}>
                      {Number(p.sqft).toLocaleString()} sqft
                    </span>
                  )}
                  {p.status && (
                    <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 99, background: 'var(--gw-bone)', color: 'var(--gw-mist)', textTransform: 'capitalize' }}>
                      {p.status}
                    </span>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </Drawer>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// CriteriaCard — Buyer/Investor or Seller/Landlord profile panel.
//
// Buyer/Investor: submarkets + asset types they WANT + size range (min–max)
// Seller/Landlord: submarket + asset type they OWN + exact property size
//
// Brand-tinted card (azure for buyers, gold for sellers) makes it visually
// distinct so the agent's eye finds it immediately.
// ─────────────────────────────────────────────────────────────────────────────
function CriteriaCard({ isBuyer, isSeller, contactType, form, set }) {
  const palette = isBuyer
    ? { bg: 'var(--gw-sky, #f0f7ff)',   border: 'var(--gw-azure)',         accent: 'var(--gw-azure)' }
    : { bg: 'var(--gw-cream, #fdf9f0)', border: 'var(--gw-gold, #C8A84B)', accent: 'var(--gw-gold, #C8A84B)' }

  const title = isBuyer
    ? (contactType === 'investor' ? 'Investment Criteria' : 'Buyer Criteria')
    : (contactType === 'landlord' ? 'Property Profile' : 'Seller Profile')

  const subtitle = isBuyer
    ? 'What this contact is looking for — used to match them with listings.'
    : 'About the property they own — used to surface matching buyers.'

  return (
    <div style={{
      background: palette.bg,
      border: `1px solid ${palette.border}`,
      borderRadius: 'var(--radius)',
      padding: '12px 14px',
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
    }}>
      <div>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: palette.accent }}>
          {title}
          <span style={{ marginLeft: 6, fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: 'var(--gw-mist)', fontSize: 11 }}>
            — all optional
          </span>
        </div>
        <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginTop: 2, lineHeight: 1.4 }}>
          {subtitle}
        </div>
      </div>

      {/* Asset Types — chip grid (small finite set, visible at a glance) */}
      <div>
        <label className="form-label" style={{ marginBottom: 6, display: 'block' }}>
          {isBuyer ? 'Asset Types' : 'Asset Type'}
        </label>
        <ChipToggleGroup
          fieldKey="asset_type"
          value={Array.isArray(form.asset_types) ? form.asset_types : []}
          onChange={(v) => set('asset_types', v)}
          placeholder="Filter asset types…"
          allowAdd
          searchThreshold={12}
        />
      </div>

      {/* Submarkets — search-first; sellers usually pick one, buyers may pick many */}
      <div>
        <label className="form-label" style={{ marginBottom: 6, display: 'block' }}>
          {isBuyer ? 'Submarkets' : 'Submarket'}
        </label>
        <OptionMultiSelect
          fieldKey="submarket"
          value={Array.isArray(form.submarkets) ? form.submarkets : []}
          onChange={(v) => set('submarkets', v)}
          placeholder={isBuyer ? 'Search submarkets…' : 'Where is the property?'}
          allowAdd
        />
      </div>

      {/* Size — buyer = range, seller = exact value */}
      {isBuyer ? (
        <div>
          <label className="form-label" style={{ marginBottom: 6, display: 'block' }}>Size Range</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              className="form-control"
              type="number"
              value={form.size_min || ''}
              onChange={(e) => set('size_min', e.target.value)}
              placeholder="Min"
              style={{ flex: 1 }}
            />
            <span style={{ color: 'var(--gw-mist)', fontSize: 13, flexShrink: 0 }}>–</span>
            <input
              className="form-control"
              type="number"
              value={form.size_max || ''}
              onChange={(e) => set('size_max', e.target.value)}
              placeholder="Max"
              style={{ flex: 1 }}
            />
            <select
              className="form-control"
              value={form.size_unit || 'sqft'}
              onChange={(e) => set('size_unit', e.target.value)}
              style={{ width: 76, flexShrink: 0 }}
            >
              <option value="sqft">sqft</option>
              <option value="acres">acres</option>
              <option value="units">units</option>
            </select>
          </div>
        </div>
      ) : (
        <div>
          <label className="form-label" style={{ marginBottom: 6, display: 'block' }}>Property Size</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              className="form-control"
              type="number"
              value={form.size_min || ''}
              onChange={(e) => set('size_min', e.target.value)}
              placeholder="e.g. 12,500"
              style={{ flex: 1 }}
            />
            <select
              className="form-control"
              value={form.size_unit || 'sqft'}
              onChange={(e) => set('size_unit', e.target.value)}
              style={{ width: 76, flexShrink: 0 }}
            >
              <option value="sqft">sqft</option>
              <option value="acres">acres</option>
              <option value="units">units</option>
            </select>
          </div>
        </div>
      )}
    </div>
  )
}
