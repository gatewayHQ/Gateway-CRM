// Create / edit a property, and start a deal from it.

import React, { useState } from 'react'
import { Icon, Avatar, Drawer, Modal, SearchDropdown, pushToast } from '../../components/UI.jsx'
import ContactMultiSelect from '../../components/ContactMultiSelect.jsx'
import { fireWebhooks } from '../../lib/webhooks.js'
import { mutationErrorMessage } from '../../lib/services/db.js'
import { createProperty, updateProperty, updatePropertyCoords } from '../../lib/services/properties.js'
import { syncDealContactsFromProperty, syncPropertyContacts, fetchPropertyContacts } from '../../lib/services/propertyContacts.js'
import { coAgentIdsForNewDeal, isMissingCoAgentColumn } from '../../lib/coAgents.js'
import { isMissingSideColumn } from '../../lib/dealPeople.js'
import { RESIDENTIAL_PROPERTY_TYPES, COMMERCIAL_PROPERTY_TYPES, PROPERTY_TYPE_LABELS, PROPERTY_STATUSES } from '../../lib/enums.js'
import { OPERATING_STATES } from '../../lib/constants.js'
import OptionSelect from '../../components/OptionSelect.jsx'
import { PropertyPricingHistoryTab } from '../../components/PricingHistoryPanel.jsx'
import { syncPriceChange } from '../../lib/services/pricing.js'
import { priceChanged } from '../../lib/pricing.js'
import { streetLine, geocodeQuery, normalizeUnit, isMissingUnitColumn } from '../../lib/address.js'
import { checkOpenDealsOnProperty, createDeal, renameDeals, requestAccessToDeal } from '../../lib/services/dealRecords.js'
import { isCommercial } from './propertyTypes.js'
import { ShowingsTab } from './ShowingsTab.jsx'
import { MarketingChecklistTab } from './MarketingChecklistTab.jsx'
import { CompsTab } from './CompsTab.jsx'
import { PhotoUploader } from './PhotoUploader.jsx'
import { CommercialFields, ResidentialFields } from './PropertyFields.jsx'
import { PossibleBuyers } from './PossibleBuyers.jsx'

// ─────────────────────────────────────────────────────────────────────────────

// Mirror a property's link rows into global state after writing them. The deal
// page shows the property's extra contacts, and the deal drawer seeds its
// picker from them, so both need the rows that now exist — App's loader only
// refetches `property_contacts` on a full reload.
async function reloadPropertyContacts(setDb, propertyId) {
  if (!setDb || !propertyId) return
  const { data, error } = await fetchPropertyContacts(propertyId)
  if (error) return   // table missing (pre-0021) — leave state as it was
  setDb(p => ({
    ...p,
    propertyContacts: [...(p.propertyContacts || []).filter(r => r?.property_id !== propertyId), ...(data || [])],
  }))
}

export function PropertyDrawer({ open, onClose, property, agents, contacts, propertyContacts = [], deals = [], activeAgent, isAdmin = false, onSave, go, setDb, announce }) {
  const blank = { address:'', unit:'', city:'', state:'', zip:'', county:'', submarket:'', type:'residential', status:'active', list_price:'', sqft:'', beds:'', baths:'', garage:0, mls_number:'', linked_contact_id:'', assigned_agent_id:'', notes:'', details:{}, listing_expiry_date:'', price_history:[], comps:[] }
  const [form, setForm]             = useState(property || blank)
  const [errors, setErrors]         = useState({})
  // An open deal somebody else already has on this property. Held rather than
  // acted on: the agent decides whether to open it, ask to join it, or (office
  // admins only) start a second one anyway.
  const [dupeDeals, setDupeDeals]   = useState(null)
  const [asking, setAsking]         = useState('')
  const [saving, setSaving]         = useState(false)
  const [startingDeal, setStartingDeal] = useState(false)
  const [tab, setTab]               = useState('details')
  // The new listing's id, chosen up front so photos can upload under it before
  // the first save. The drawer stays mounted between opens, so it must be minted
  // fresh for every new property: reusing the last one made the next "Add
  // Property" insert an id that already existed ("This record already exists").
  const [tempId, setTempId] = useState(() => property?.id || crypto.randomUUID())
  React.useEffect(() => {
    if (open) setTempId(property?.id || crypto.randomUUID())
  }, [open, property?.id])
  // Additional contacts (co-owners, husband & wife) — primary stays linked_contact_id.
  const [additionalContactIds, setAdditionalContactIds] = useState([])

  React.useEffect(() => {
    setForm(property
      ? { ...blank, ...property, details: property.details || {}, price_history: property.price_history || [], comps: property.comps || [], listing_expiry_date: property.listing_expiry_date ? property.listing_expiry_date.slice(0,10) : '' }
      : { ...blank, assigned_agent_id: activeAgent?.id || '' })
    setErrors({})
    setTab('details')
    setAdditionalContactIds(
      property?.id ? (propertyContacts || []).filter(pc => pc.property_id === property.id).map(pc => pc.contact_id) : []
    )
  }, [property, open, activeAgent?.id, propertyContacts])

  const set = (k, v) => setForm(p => ({...p, [k]: v}))

  const photos     = form.details?.photos      || []
  const coAgentIds = form.details?.co_agent_ids || []

  const addPhoto    = (url) => set('details', { ...(form.details || {}), photos: [...photos, url] })
  const removePhoto = (url) => set('details', { ...(form.details || {}), photos: photos.filter(u => u !== url) })
  const toggleCoAgent = (agentId) => {
    const next = coAgentIds.includes(agentId)
      ? coAgentIds.filter(id => id !== agentId)
      : [...coAgentIds, agentId]
    set('details', { ...(form.details || {}), co_agent_ids: next })
  }

  // `force` is the office-admin override. Everyone else goes through the check.
  const startDeal = async (force = false) => {
    setStartingDeal(true)
    // Does this property already carry an open deal on the side this button
    // creates? Asked of the DATABASE, not of the deals in this browser — the
    // in-memory list is RLS-scoped, so a colleague's deal is invisible here and
    // a client-side check would wave through exactly the duplicate it is meant
    // to catch. "Start Deal" always creates a seller-side deal (see comp_data
    // below), so that is the side we ask about.
    if (!force) {
      const { deals: existing, error: dupeErr } = await checkOpenDealsOnProperty(property.id, 'seller')
      if (dupeErr) {
        // A failed check must not block the work. Log the reason and continue —
        // the unique index from migration 0054 is the backstop.
        console.warn('Duplicate-deal check failed, continuing:', dupeErr)
      } else if (existing.length) {
        setDupeDeals(existing)
        setStartingDeal(false)
        return
      }
    }
    const primaryAgentId = activeAgent?.id || form.assigned_agent_id || null
    const dealPayload = {
      // The suite is part of the address, so it is part of the deal's title —
      // two spaces in the same strip mall must not both open as "2212 Okoboji Ave".
      title:       streetLine(form),
      property_id: property.id,
      contact_id:  form.linked_contact_id || null,
      // A deal started from our own listing is a SELLER-side deal, and the
      // property's linked contact is the owner — so they are filed as the seller
      // rather than landing on the buyer side by default (migration 0040). This
      // is also what points the deal's required forms at the listing packets.
      seller_contact_id: form.linked_contact_id || null,
      comp_data:   { transaction_type: 'seller' },
      agent_id:    primaryAgentId,
      stage:       'lead',
      value:       form.list_price ? Number(form.list_price) : null,
      // Co-agents ride along with the property (the primary agent owns the deal
      // and is never listed twice) so the new deal's team and its commission
      // split start out complete — see src/lib/coAgents.js.
      co_agent_ids: coAgentIdsForNewDeal(form, primaryAgentId),
    }
    let payload = dealPayload
    let { data, error } = await createDeal(payload)
    // Migration 0025 adds deals.co_agent_ids. Until it's applied, create the
    // deal without the co-agents rather than blocking the conversion — the
    // deal page still resolves them from the linked property.
    let coAgentsDropped = false
    if (error && isMissingCoAgentColumn(error)) {
      const { co_agent_ids, ...rest } = payload
      payload = rest
      ;({ data, error } = await createDeal(payload))
      coAgentsDropped = !error && dealPayload.co_agent_ids.length > 0
    }
    // Same for deals.seller_contact_id (migration 0040) — the owner still lands
    // on the deal as `contact_id`, which is the pre-0040 behavior.
    if (error && isMissingSideColumn(error)) {
      const { seller_contact_id, ...rest } = payload
      payload = rest
      ;({ data, error } = await createDeal(payload))
    }
    setStartingDeal(false)
    if (error) { pushToast(error.message, 'error'); return }
    if (coAgentsDropped) pushToast('Co-agents not carried over — run migration 0025', 'error')
    // Carry the property's additional contacts onto the new deal.
    let newDealContacts = []
    if (data?.id && additionalContactIds.length) newDealContacts = await syncDealContactsFromProperty(data.id, additionalContactIds)
    if (setDb) setDb(p => ({
      ...p,
      deals: [data, ...(p.deals || [])],
      dealContacts: [...(p.dealContacts || []), ...newDealContacts],
    }))
    pushToast('Deal created — opening Pipeline')
    onClose()
    if (go) go('pipeline')
  }

  const save = async () => {
    const e = {}
    if (!form.address.trim()) e.address = true
    setErrors(e)
    if (Object.keys(e).length > 0) return
    setSaving(true)
    const resolvedId = property?.id || tempId

    // Price changes are propagated AFTER the save (syncPriceChange below), so
    // the listing's own write is never held up by the deals it feeds. The
    // history mirror on this payload is whatever the row already had — the sync
    // appends to it, which is also what makes the append survive a failed
    // propagation.
    const priceMoved = !!property?.id && priceChanged(property?.list_price, form.list_price)

    const payload = {
      ...form,
      // TRIM. The validator above already calls .trim() to decide whether the
      // address is empty, but the value SAVED was the raw one — so
      // '102 7th St. SE' and '102 7th St. SE ' became two different property
      // rows, each with its own deals, invisible to every report that groups by
      // property. Live data carried exactly that. See migration 0054, which
      // also trims what is already stored.
      address:              (form.address || '').trim(),
      unit:                 form.unit ? form.unit.trim() : form.unit,
      city:                 form.city ? form.city.trim() : form.city,
      mls_number:           form.mls_number ? form.mls_number.trim() : form.mls_number,
      id:                   resolvedId,
      // 'Suite 200' / '#4' / '' — a bare "200" becomes "Suite 200", and an
      // empty field is stored as null rather than an empty string so the
      // address composes to the plain street line. See src/lib/address.js.
      unit:                 normalizeUnit(form.unit) || null,
      list_price:           form.list_price ? Number(form.list_price) : null,
      sqft:                 form.sqft       ? Number(form.sqft)       : null,
      beds:                 form.beds       ? Number(form.beds)       : null,
      baths:                form.baths      ? Number(form.baths)      : null,
      garage:               form.garage != null ? Number(form.garage) : 0,
      linked_contact_id:    form.linked_contact_id || null,
      assigned_agent_id:    form.assigned_agent_id || activeAgent?.id || null,
      listing_expiry_date:  form.listing_expiry_date || null,
      price_history:        Array.isArray(form.price_history) ? form.price_history : [],
      comps:                form.comps || [],
    }
    let error, data, status
    let unitDropped = false
    const write = (body) => property?.id
      ? updateProperty(property.id, body)
      : createProperty(body)
    ;({ error, data, status } = await write(payload))
    // Migration 0042 adds properties.unit. Until it is applied, save the
    // listing without the suite rather than refusing the save — same
    // degrade-and-continue pattern as co_agent_ids (0025) and the deal sides (0040).
    if (error && isMissingUnitColumn(error)) {
      const { unit, ...withoutUnit } = payload
      ;({ error, data, status } = await write(withoutUnit))
      unitDropped = !error && !!payload.unit
    }
    setSaving(false)
    if (error) { pushToast(mutationErrorMessage(error, status, 'Could not save property — please try again.'), 'error'); return }
    if (unitDropped) pushToast('Suite / unit not saved — ask an admin to apply database migration 0042.', 'error')

    // Geocode on save if address changed or not yet geocoded
    const savedId = data?.id || resolvedId

    // Sync additional contacts (best-effort — property is already saved), then
    // mirror them into state so a deal on this property sees them right away.
    if (savedId && await syncPropertyContacts(savedId, additionalContactIds)) {
      await reloadPropertyContacts(setDb, savedId)
    }
    // ── Price round-trip ─────────────────────────────────────────────────────
    // The listing price and every open deal's value are the same number
    // (src/lib/pricing.js). A reduction typed here reaches those deals and the
    // shared Pricing History; a failure warns instead of undoing the save.
    if (priceMoved && savedId) {
      const sync = await syncPriceChange({
        price: form.list_price, previousPrice: property?.list_price,
        origin: 'property',
        property: { ...(data || payload), id: savedId },
        deals, actor: activeAgent,
      })
      if (sync.warning) pushToast(sync.warning, 'error')
      if (sync.propertyPatch) {
        // The mirror the sync appended. The drawer's own copy is updated so the
        // Pricing History tab shows the new entry without a reload, and the row
        // handed to onSave() carries it so the grid and the deal drawer do too.
        setForm(f => ({ ...f, price_history: sync.propertyPatch.price_history }))
        if (data) data = { ...data, ...sync.propertyPatch }
      }
      if (sync.repricedDealIds.length && setDb) {
        const nextValue = Number(form.list_price)
        setDb(prev => ({
          ...prev,
          deals: (prev.deals || []).map(d => sync.repricedDealIds.includes(d.id) ? { ...d, value: nextValue } : d),
        }))
        pushToast(`Price synced to ${sync.repricedDealIds.length} open deal${sync.repricedDealIds.length === 1 ? '' : 's'}`)
      }
    }

    // ── Address round-trip ───────────────────────────────────────────────────
    // "Start Deal" titles a new deal with the property's address, so renaming
    // the property leaves those deals pointing at an address that no longer
    // exists. Only titles that EXACTLY match the old address are renamed — a
    // title the agent wrote themselves is theirs, and is never touched.
    const oldTitle = streetLine(property)
    const newTitle = streetLine({ ...form, unit: normalizeUnit(form.unit) })
    if (property?.id && oldTitle && newTitle && newTitle !== oldTitle) {
      // Both the pre-suite title (the bare street line) and the composed one
      // count as "the address we gave this deal" — a listing that gains a suite
      // was titled without one.
      const stale = (deals || []).filter(d => d.property_id === property.id && (d.title === oldTitle || d.title === property.address))
      if (stale.length) {
        const { error: renameError } = await renameDeals(stale.map(d => d.id), newTitle)
        if (renameError) pushToast('Property saved, but its deals kept the old address as their title.', 'error')
        else if (setDb) setDb(prev => ({
          ...prev,
          deals: (prev.deals || []).map(d => stale.some(x => x.id === d.id) ? { ...d, title: newTitle } : d),
        }))
      }
    }

    const addressChanged = !property?.id || form.address !== property?.address || form.city !== property?.city
    if (savedId && addressChanged && (!form.lat || !form.lng)) {
      // No suite: geocoders resolve buildings, not the spaces inside them.
      const fullAddr = geocodeQuery(form)
      try {
        const geoRes = await fetch(
          `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(fullAddr)}`,
          { headers: { 'User-Agent': 'GatewayCRM/1.0' } }
        )
        const geoData = await geoRes.json()
        if (geoData[0]) {
          await updatePropertyCoords(savedId, parseFloat(geoData[0].lat), parseFloat(geoData[0].lon))
        }
      } catch { /* geocoding failure is non-fatal */ }
    }

    if (!property?.id) fireWebhooks('property.added', { id: savedId, address: form.address, unit: normalizeUnit(form.unit) || null, city: form.city, type: form.type, status: form.status })

    pushToast(property?.id ? 'Property updated' : 'Property added')
    onSave(data || payload)
    onClose()
  }

  const commercial = isCommercial(form.type)

  const isExisting = !!property?.id

  return (
    <Drawer open={open} onClose={onClose} title={property?.id ? 'Edit Property' : 'Add Property'} width={520}>
      {/* Tab bar — only for existing properties */}
      {isExisting && (
        <div className="drawer-tabs">
          {[['details','Details'],['history','Price History'],['showings','Showings'],['marketing','Marketing'],['comps','Comps']].map(([id, label]) => (
            <button key={id} className={`drawer-tab${tab === id ? ' active' : ''}`} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>
      )}

      {/* Non-details tabs */}
      {tab === 'history'   && isExisting && <PropertyPricingHistoryTab property={{ ...property, price_history: form.price_history }} />}
      {tab === 'showings'  && isExisting && <ShowingsTab property={property} />}
      {tab === 'marketing' && isExisting && <MarketingChecklistTab property={property} />}
      {tab === 'comps'     && isExisting && (
        <CompsTab
          property={{ ...property, comps: form.comps, list_price: form.list_price ? Number(form.list_price) : property.list_price }}
          onUpdateComps={(newComps) => {
            set('comps', newComps)
            if (onSave) onSave({ ...property, comps: newComps })
          }}
        />
      )}

      {/* Details tab (also shown for new properties) */}
      {(tab === 'details' || !isExisting) && (<>
      <div className="drawer__body">
        {/* Photos */}
        <div className="form-group">
          <PhotoUploader
            photos={photos}
            propertyId={tempId}
            onAdd={addPhoto}
            onRemove={removePhoto}
          />
        </div>
        {/* Address */}
        <div className="form-group"><label className="form-label required">Address</label><input className={`form-control${errors.address?' error':''}`} value={form.address} onChange={e=>set('address',e.target.value)} placeholder="123 Main Street" /></div>
        {/* Suite / unit — the space inside the building, for a strip-mall or
            office listing. Optional, and left out of the map query below. */}
        <div className="form-group">
          <label className="form-label">Suite / Unit #</label>
          <input
            className="form-control"
            value={form.unit || ''}
            onChange={e=>set('unit', e.target.value)}
            onBlur={e=>set('unit', normalizeUnit(e.target.value))}
            placeholder="Suite 200 (optional)"
          />
        </div>
        <div className="form-row">
          <div className="form-group"><label className="form-label">City</label><input className="form-control" value={form.city||''} onChange={e=>set('city',e.target.value)} /></div>
          <div className="form-group"><label className="form-label">State</label>
            <select className="form-control" value={form.state||''} onChange={e=>set('state',e.target.value)}>
              <option value="">Select…</option>
              {OPERATING_STATES.map(s => <option key={s.code} value={s.code}>{s.name} ({s.code})</option>)}
            </select>
          </div>
        </div>
        <div className="form-row">
          <div className="form-group"><label className="form-label">ZIP</label><input className="form-control" value={form.zip||''} onChange={e=>set('zip',e.target.value)} /></div>
          <div className="form-group"><label className="form-label">County</label><input className="form-control" value={form.county||''} onChange={e=>set('county',e.target.value)} placeholder="e.g. Travis County" /></div>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Submarket</label>
            <OptionSelect
              fieldKey="submarket"
              value={form.submarket || ''}
              onChange={v => set('submarket', v)}
              placeholder="Select submarket…"
              allowAdd
            />
          </div>
          <div className="form-group"><label className="form-label">MLS #</label><input className="form-control" value={form.mls_number||''} onChange={e=>set('mls_number',e.target.value)} /></div>
        </div>

        {/* Google Maps embed — shown when address exists */}
        {form.address && (
          <div className="form-group">
            <iframe
              title="Property Map"
              src={`https://maps.google.com/maps?q=${encodeURIComponent(geocodeQuery(form))}&output=embed`}
              width="100%" height="200"
              style={{ border:0, borderRadius:'var(--radius)', display:'block' }}
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
            />
          </div>
        )}

        {/* Type + Status */}
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Property Type</label>
            <select className="form-control" value={form.type} onChange={e=>set('type',e.target.value)}>
              <optgroup label="Residential">
                {RESIDENTIAL_PROPERTY_TYPES.map(t=><option key={t} value={t}>{PROPERTY_TYPE_LABELS[t]}</option>)}
              </optgroup>
              <optgroup label="Commercial">
                {COMMERCIAL_PROPERTY_TYPES.map(t=><option key={t} value={t}>{PROPERTY_TYPE_LABELS[t]}</option>)}
              </optgroup>
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Status</label>
            <select className="form-control" value={form.status} onChange={e=>set('status',e.target.value)}>
              {PROPERTY_STATUSES.map(s=><option key={s} value={s}>{s.charAt(0).toUpperCase()+s.slice(1).replace('-',' ')}</option>)}
            </select>
          </div>
        </div>

        {/* Price + Expiry */}
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">{commercial ? 'Asking Price / Value' : 'List Price'}</label>
            <input className="form-control" type="number" value={form.list_price||''} onChange={e=>set('list_price',e.target.value)} placeholder="0" />
          </div>
          <div className="form-group">
            <label className="form-label">Listing Expiry Date</label>
            <input className="form-control" type="date" value={form.listing_expiry_date||''} onChange={e=>set('listing_expiry_date',e.target.value)} />
          </div>
        </div>

        {/* Dynamic fields based on type */}
        {!commercial
          ? <ResidentialFields form={form} set={set} />
          : <CommercialFields form={form} set={set} />
        }

        {/* Always-present fields */}
        <div className="form-group"><label className="form-label">Linked Contact</label><SearchDropdown items={contacts} value={form.linked_contact_id} onSelect={v=>set('linked_contact_id',v)} placeholder="Search contacts…" labelKey={c=>`${c.first_name} ${c.last_name}`} /></div>
        <div className="form-group">
          <label className="form-label">Additional Contacts</label>
          <ContactMultiSelect contacts={contacts} selectedIds={additionalContactIds} onChange={setAdditionalContactIds} excludeId={form.linked_contact_id} placeholder="Add co-owner, spouse…" />
          <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginTop: 4 }}>Co-owners, husband &amp; wife — carried onto a new deal when you Start a Deal from this property.</div>
        </div>
        <div className="form-group"><label className="form-label">Assigned Agent</label><select className="form-control" value={form.assigned_agent_id||''} onChange={e=>set('assigned_agent_id',e.target.value)}><option value="">Unassigned</option>{agents.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></div>
        {/* Co-Agents */}
        {agents.filter(a => a.id !== form.assigned_agent_id).length > 0 && (
          <div className="form-group">
            <label className="form-label">
              Co-Agents
              <span style={{ fontWeight: 400, color: 'var(--gw-mist)', marginLeft: 6, fontSize: 11 }}>
                share commission on this property
              </span>
            </label>
            <div className="coagent-list">
              {agents.filter(a => a.id !== form.assigned_agent_id).map(a => (
                <label key={a.id} className={`coagent-item${coAgentIds.includes(a.id) ? ' checked' : ''}`}>
                  <input type="checkbox" checked={coAgentIds.includes(a.id)} onChange={() => toggleCoAgent(a.id)} />
                  <Avatar agent={a} size={22} />
                  <span>{a.name}</span>
                  {a.role && <span style={{ fontSize: 11, color: 'var(--gw-mist)' }}>{a.role}</span>}
                </label>
              ))}
            </div>
          </div>
        )}
        <div className="form-group"><label className="form-label">Notes</label><textarea className="form-control form-control--textarea" value={form.notes||''} onChange={e=>set('notes',e.target.value)} /></div>

        {/* ── Possible Buyers — powered by the matching engine ── */}
        <PossibleBuyers form={form} contacts={contacts} />
      </div>
      {/* ── Already has a deal ──────────────────────────────────────────────
          Emma clicked Start Deal on a property Steph already had a deal on.
          Steph's deal is invisible to Emma (RLS shows you only deals you are
          on), so the property looked untouched and the CRM silently made a
          second one. That is the whole bug: two rows, each with their own
          documents, terms and tasks, neither aware of the other.

          Naming the agent is a deliberate, narrow disclosure — properties and
          the agent roster are already org-wide readable, so this adds only the
          fact that a deal exists, which is precisely what was missing. */}
      <Modal open={!!dupeDeals} onClose={() => setDupeDeals(null)} width={560}>
        <div style={{ padding: 20 }}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>
            This property already has a deal
          </div>
          <div style={{ fontSize: 13, color: 'var(--gw-mist)', lineHeight: 1.7, marginBottom: 14 }}>
            Starting another would split the work in two — documents, deal terms, key dates and
            signatures all live on one deal and never cross between them.
          </div>
          {(dupeDeals || []).map(d => (
            <div key={d.deal_id} style={{ border: '1px solid var(--gw-line, #e6e2da)', borderRadius: 'var(--radius)', padding: 12, marginBottom: 10 }}>
              <div style={{ fontWeight: 600, fontSize: 13.5 }}>{d.title || 'Untitled deal'}</div>
              <div style={{ fontSize: 12, color: 'var(--gw-mist)', marginTop: 3 }}>
                {d.agent_name || 'Unassigned'} · {String(d.stage || '').replace(/-/g, ' ')}
                {d.side && d.side !== 'unknown' ? ` · ${d.side} side` : ''}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                <button className="btn btn--secondary btn--sm" onClick={() => { setDupeDeals(null); onClose(); go && go('pipeline') }}>
                  <Icon name="pipeline" size={12} /> Open in Pipeline
                </button>
                {d.agent_id !== activeAgent?.id && (
                  <button
                    className="btn btn--secondary btn--sm"
                    disabled={asking === d.deal_id}
                    onClick={async () => {
                      setAsking(d.deal_id)
                      const r = await requestAccessToDeal(d.deal_id)
                      setAsking('')
                      pushToast(
                        r.ok ? `Asked ${d.agent_name || 'the owner'} to add you to this deal.` : (r.error || 'Could not send that request.'),
                        r.ok ? 'success' : 'error'
                      )
                    }}>
                    <Icon name="mail" size={12} /> {asking === d.deal_id ? 'Sending…' : `Ask ${(d.agent_name || 'owner').split(' ')[0]} to add me`}
                  </button>
                )}
              </div>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
            <button className="btn btn--secondary" onClick={() => setDupeDeals(null)}>Cancel</button>
            {isAdmin && (
              // Office admins only. There are real reasons for a second deal on
              // one property; there is no reason for an agent to make one by
              // accident because they could not see the first.
              <button className="btn btn--danger" onClick={() => { setDupeDeals(null); startDeal(true) }}>
                Start a second deal anyway
              </button>
            )}
          </div>
        </div>
      </Modal>

      <div className="drawer__foot">

        {property?.id && (
          <div style={{ display:'flex', gap:6, marginRight:'auto' }}>
            <button
              className="btn btn--secondary"
              onClick={startDeal}
              disabled={startingDeal}
              title="Create a deal in the Pipeline linked to this property"
            >
              <Icon name="pipeline" size={13} />
              {startingDeal ? 'Creating…' : 'Start Deal'}
            </button>
            <button
              className="btn btn--secondary"
              title="Email a Just Closed / New Listing announcement about this property"
              onClick={() => { onClose(); announce?.(property.id) }}
            >
              <Icon name="mail" size={13} />
              Announce
            </button>
            <button
              className="btn btn--ghost"
              title="Copy share link — works on social media, email, and text"
              onClick={() => {
                const url = `${window.location.origin}/share/${property.id}`
                navigator.clipboard.writeText(url).then(() => pushToast('Share link copied! Works on social, email & text.'))
              }}
            >
              <Icon name="link" size={13} />
              Share Link
            </button>
          </div>
        )}
        <button className="btn btn--secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn--primary" onClick={save} disabled={saving}>{saving?'Saving…':'Save Property'}</button>
      </div>
      </>)}
    </Drawer>
  )
}
