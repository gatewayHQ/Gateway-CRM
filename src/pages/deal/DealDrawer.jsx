// The deal drawer: Details plus the Terms, Key Dates, Checklist, Documents,
// Signatures and Portal tabs. Shared by the Pipeline board and the deal page.

import React, { useState, useRef } from 'react'
import { updateDeal, insertDeal, checkOpenDealsOnProperty } from '../../lib/services/dealRecords.js'
import { formatCurrency } from '../../lib/helpers.js'
import { TRACKS, UNIFIED, boardStageFor } from '../../lib/stages.js'
import { DEAL_TABS, dealTabOrDefault } from '../../lib/dealTabs.js'
import { checklistKindFor, checklistStateFor } from '../../lib/checklistTemplates.js'
import { useStageLabels } from '../../lib/stageLabelContext.js'
import { coAgentIdsForNewDeal, dealCoAgentIds, propertyCoAgentIds, isMissingCoAgentColumn } from '../../lib/coAgents.js'
import {
  propertyContactIds, propertyExtrasNotOnDeal, seedPickerFromProperty, REPRESENTING_OPTIONS, SIDE_LABELS, representingFor, sidesFor, primaryContactIdFor, dealContactIdsForSide, propertyContactSide, isMissingSideColumn,
} from '../../lib/dealPeople.js'
import { priceChanged } from '../../lib/pricing.js'
import { syncPriceChange } from '../../lib/services/pricing.js'
import { DealPriceLine } from '../../components/PricingHistoryPanel.jsx'
import { friendlyDbError } from '../../lib/dbErrors.js'
import { streetLine, propertyLabel } from '../../lib/address.js'
import { Drawer, SearchDropdown, pushToast } from '../../components/UI.jsx'
import ContactMultiSelect from '../../components/ContactMultiSelect.jsx'
import AgentMultiSelect from '../../components/AgentMultiSelect.jsx'
import { dealContactKeyFor, reloadDealContacts, syncDealContacts } from '../../lib/services/dealContacts.js'
import { seedChecklist } from '../../lib/services/dealChecklist.js'
import { CommissionFields } from './CommissionFields.jsx'
import { DealTermsTab } from './DealTermsTab.jsx'
import { KeyDatesTab } from './KeyDatesTab.jsx'
import { ChecklistTab } from './ChecklistTab.jsx'
import { DocumentsTab } from './DocumentsTab.jsx'
import { SignaturesTab } from './signatures/SignaturesTab.jsx'
import { PortalTab } from './PortalTab.jsx'
import { updatePropertyDetails } from '../../lib/services/properties.js'

// The deal drawer's two widths. 860 is the working default — wide enough for
// all seven tabs and a two-column form; the wide one takes most of a laptop
// screen for a heavy editing session. Both are capped by the Drawer's own
// maxWidth so neither can run off a small screen.
const DRAWER_WIDTH = 860

const DRAWER_WIDE  = 1320

const DRAWER_WIDE_KEY = 'gw.dealDrawer.wide'

export function DealDrawer({ open, onClose, deal, agents, contacts, properties, deals = [], dealContacts = [], propertyContacts = [], activeAgent, onSave, onCreated, setDb, initialTab = 'details' }) {
  // A new deal belongs to the agent creating it. It used to start Unassigned,
  // and new agents didn't know to pick themselves — the database then refused
  // the save, or the deal landed in nobody's pipeline.
  const blank = { title:'', contact_id:'', buyer_contact_id:'', seller_contact_id:'', property_id:'', agent_id: activeAgent?.id || '', stage:'lead', value:'', probability:0, expected_close_date:'', notes:'', prop_category:'residential', prop_subtype:'', comp_data:{}, commission_type:'percent', commission_pct:'', commission_flat:'' }
  const [form, setForm]     = useState(deal || blank)
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)
  const [tab, setTab]       = useState(dealTabOrDefault(initialTab))
  // HOW WIDE THE DRAWER OPENS.
  //
  // It used to be 500px, which could not fit its own tab strip — the tabs
  // scrolled sideways — and forced every form inside into one narrow column.
  // 860 fits all seven tabs on a laptop and lets the .form-row grids below
  // actually be two columns, while still leaving the board visible behind it.
  //
  // The wider setting is for a long editing session (Deal Terms, Documents) and
  // is REMEMBERED per browser rather than per deal: it is a working preference,
  // like a window size, not a property of the deal being looked at. On a phone
  // both are overridden by the full-height sheet in app.css.
  const [expanded, setExpanded] = useState(() => {
    try { return localStorage.getItem(DRAWER_WIDE_KEY) === '1' } catch { return false }
  })
  React.useEffect(() => {
    try { localStorage.setItem(DRAWER_WIDE_KEY, expanded ? '1' : '0') } catch { /* private window: the session keeps it, the next one doesn't */ }
  }, [expanded])
  // Stage picker reads the agent's own column names, so the drawer and the
  // board they dragged the card from agree.
  const stageLabels         = useStageLabels()
  // Additional contacts (husband & wife, co-buyers, co-owners), kept PER SIDE —
  // the primaries are form.buyer_contact_id / form.seller_contact_id. Both sides
  // are held in state even when only one is shown, so flipping Representing to
  // 'both' and back never discards the other side's people.
  const [additionalBySide, setAdditionalBySide] = useState({ buyer: [], seller: [] })

  // WHY THE DEPS ARE CONTENT, NOT OBJECTS — this is the "the modal closed when I
  // switched tabs" bug.
  //
  // This effect re-seeds the form AND resets the visible tab. It used to depend on
  // the `deal` OBJECT and the `dealContacts` ARRAY, both of which arrive from App's
  // `db` state. Switching browser tabs makes Supabase refresh the auth token, which
  // hands App a new session object, which re-runs its loader, which calls setDb with
  // freshly-built arrays. Same data, new identities — so this effect fired and
  // `setTab()` threw the agent back to Details, unmounting the Signatures tab and
  // destroying the open BoldSign editor with it. The draft survived in BoldSign; the
  // agent's place in it did not.
  //
  // Seeding belongs to "the drawer opened on this deal", so that is what it depends
  // on: the deal's ID, not its object identity, and a content KEY for the linked
  // contacts rather than the array they came in. A refetch that changes nothing now
  // changes nothing. It also means an agent's half-typed edits are no longer wiped
  // by a background refetch — the same bug wearing different clothes.
  const dealContactKey = dealContactKeyFor(dealContacts, deal?.id)

  React.useEffect(() => {
    setForm(deal ? {
      ...blank, ...deal,
      expected_close_date: deal.expected_close_date ? deal.expected_close_date.slice(0,10) : '',
      comp_data: deal.comp_data || {},
      // Null columns must become '' so the inputs stay controlled, and a legacy
      // row with no type flag reads as a percentage deal (matching migration 0024).
      commission_type:  deal.commission_type === 'flat' ? 'flat' : 'percent',
      commission_pct:   deal.commission_pct  ?? '',
      commission_flat:  deal.commission_flat ?? '',
      // A deal saved before the per-side columns existed has its single contact
      // read onto the side it represents (src/lib/dealPeople.js), so opening the
      // drawer shows that person where they belong instead of an empty field.
      buyer_contact_id:  primaryContactIdFor(deal, 'buyer')  || '',
      seller_contact_id: primaryContactIdFor(deal, 'seller') || '',
      // Additional Agents shows everyone the DATABASE counts as on this deal —
      // the deal's own column unioned with the listing's co-agents — not just
      // the copy taken when the property was converted. Showing only the copy is
      // how an agent added to the listing afterwards stayed invisible here while
      // RLS granted them the deal (migration 0055): the field looked complete,
      // so nobody thought to re-add them, and saving wrote the short list back.
      co_agent_ids: dealCoAgentIds(deal, (properties || []).find(p => p.id === deal.property_id) || null),
    } : blank)
    setErrors({})
    setTab(deal?.id ? dealTabOrDefault(initialTab) : 'details')
    setAdditionalBySide(deal?.id ? {
      buyer:  dealContactIdsForSide(dealContacts, deal, 'buyer'),
      seller: dealContactIdsForSide(dealContacts, deal, 'seller'),
    } : { buyer: [], seller: [] })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately keyed on
    // the deal's IDENTITY and its contacts' CONTENT; see the comment above.
  }, [deal?.id, open, initialTab, dealContactKey])

  // ── Carry the linked property's extra contacts into the picker ─────────────
  // "Start Deal" copies the property's Additional Contacts onto the new deal, so
  // a co-owner normally arrives here as a real deal_contacts row and seeds a
  // signer row of their own. Deals that never got that copy — converted before
  // the carry-over shipped, or built from scratch and linked to a property later
  // — had nothing, and the co-owner silently missed the signature packet.
  //
  // So an EMPTY picker seeds from the property. A picker that already has
  // someone in it is left alone: re-adding a person the agent deliberately
  // removed from this deal would put them back on the next send, which is
  // exactly the silent behavior worth avoiding. Those show up as a one-click
  // "also on the property" suggestion under the field instead.
  const propertyContactKey = propertyContactIds(propertyContacts, form.property_id).slice().sort().join(',')
  const propertySeedRef = useRef('')

  // ── Which side(s) this deal represents ────────────────────────────────────
  // Buyer, Seller, or Both, read from comp_data.transaction_type — the same
  // field the old two-way toggle wrote, so no deal changes meaning here. 'Both'
  // is what makes the two contact sections appear.
  const representing  = representingFor(form)
  const visibleSides  = sidesFor(representing)
  const primaryFor    = (side) => (side === 'seller' ? form.seller_contact_id : form.buyer_contact_id) || ''

  // People the agent has taken off this deal. Removing the LAST extra empties
  // the picker, which reads exactly like "this deal never had one" — without
  // this, the property would seed them back on the next open and the removal
  // would never stick. Kept for the session; they remain one click away below.
  // Kept PER SIDE, because a removal only sticks on the side it was made on.
  const removedRef = useRef({ dealKey: '', ids: { buyer: [], seller: [] } })
  const changeAdditionalContacts = (side, next) => {
    const dealKey = deal?.id || 'new'
    const known = removedRef.current.dealKey === dealKey ? removedRef.current.ids : { buyer: [], seller: [] }
    // Anyone previously removed or currently picked, who isn't in the new list.
    // Re-adding someone drops them from the memory by the same rule.
    removedRef.current = {
      dealKey,
      ids: {
        ...known,
        [side]: [...new Set([...(known[side] || []), ...(additionalBySide[side] || [])])].filter(id => !next.includes(id)),
      },
    }
    setAdditionalBySide(prev => ({ ...prev, [side]: next }))
  }

  // Which side the property's co-owners belong to: the seller side when the deal
  // has one, otherwise the single client set they have always sat in.
  const ownerSide = propertyContactSide(form)

  React.useEffect(() => {
    if (!open) { propertySeedRef.current = ''; return }
    // The key includes the property's link CONTENT, so rows that arrive after
    // the drawer opened can still seed an empty picker. Nothing is ever
    // overwritten — `prev.length` inside seedPickerFromProperty is what
    // protects a curated list.
    const seedKey = `${deal?.id || 'new'}:${form.property_id || ''}:${ownerSide}:${propertyContactKey}`
    if (propertySeedRef.current === seedKey) return
    propertySeedRef.current = seedKey
    const excludeIds = removedRef.current.dealKey === (deal?.id || 'new') ? (removedRef.current.ids[ownerSide] || []) : []
    setAdditionalBySide(prev => ({
      ...prev,
      [ownerSide]: seedPickerFromProperty({
        selectedIds: prev[ownerSide] || [], propertyId: form.property_id, propertyContacts,
        primaryContactId: primaryFor(ownerSide), excludeIds,
      }),
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the deal's
    // IDENTITY and the property links' CONTENT, like the seeding effect above.
  }, [open, deal?.id, form.property_id, form.buyer_contact_id, form.seller_contact_id, ownerSide, propertyContactKey])

  // Anyone left on the property who isn't on the deal — offered, never forced.
  const propertyOnlyIds = propertyExtrasNotOnDeal({
    propertyId: form.property_id, propertyContacts,
    selectedIds: [...(additionalBySide.buyer || []), ...(additionalBySide.seller || [])],
    primaryContactId: primaryFor(ownerSide),
    excludeIds: [primaryFor(ownerSide === 'buyer' ? 'seller' : 'buyer')].filter(Boolean),
  })
  const propertyOnlyContacts = propertyOnlyIds.map(id => contacts.find(c => c.id === id)).filter(Boolean)

  // Resolved additional-contact objects — used for the "Send from Template"
  // signer prefill on the Signatures tab (co-signers get their own rows). Both
  // sides go in: on a deal representing both parties, everyone signs something.
  const extraContacts = [...(additionalBySide.buyer || []), ...(additionalBySide.seller || [])]
    .map(id => contacts.find(c => c.id === id)).filter(Boolean)

  // The same people, kept in their sides and each side's PRIMARY first — what
  // the signature prefill needs to put the buyer on the Buyer line and the
  // seller on the Seller line. Only sent for a both-sided deal: a one-sided deal
  // has one client set and the flat list is the correct, unchanged input.
  const sideClients = React.useMemo(() => {
    if (representing !== 'both') return null
    const resolve = (side) => [primaryFor(side), ...(additionalBySide[side] || [])]
      .filter(Boolean)
      .map(id => contacts.find(c => c.id === id))
      .filter(Boolean)
    return { buyerClients: resolve('buyer'), sellerClients: resolve('seller') }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- primaryFor reads the
    // two form fields named here; additionalBySide is the picker's own state.
  }, [representing, form.buyer_contact_id, form.seller_contact_id, additionalBySide, contacts])

  const set  = (k, v) => setForm(p => ({...p, [k]: v}))
  const setCD = (k, v) => setForm(p => ({...p, comp_data: {...(p.comp_data||{}), [k]: v}}))
  const cd = form.comp_data || {}
  const setPrimaryFor = (side, id) => set(side === 'seller' ? 'seller_contact_id' : 'buyer_contact_id', id || '')

  const linkedProperty = form.property_id ? (properties || []).find(p => p.id === form.property_id) || null : null

  // Linking a property fills in what the listing already knows, but only where
  // the deal is BLANK — an agent who typed a negotiated number or a deal title
  // of their own keeps it. This is what stops a fresh deal from sitting at "no
  // value" next to a priced listing, which is the state the two-way sync then
  // has to reconcile forever.
  const linkProperty = (propertyId) => {
    const picked = propertyId ? (properties || []).find(p => p.id === propertyId) : null
    setForm(prev => ({
      ...prev,
      property_id: propertyId,
      value: (prev.value === '' || prev.value === null || prev.value === undefined) && picked?.list_price != null
        ? picked.list_price
        : prev.value,
      title: !prev.title.trim() && picked?.address ? streetLine(picked) : prev.title,
    }))
  }

  // Additional agents — mirrors deals.co_agent_ids, the same column the deal
  // page's "Agents on deal" card reads via agentIdsOnDeal(), so adding/removing
  // one here shows up there once saved.
  const additionalAgentIds = form.co_agent_ids || []

  // One unified stage list for every deal. Deals stored with an off-list token
  // (from the brief track-split era) display as the nearest column and are
  // rewritten only when the agent actually changes the stage.
  const formTrack  = UNIFIED
  const formStages = TRACKS[UNIFIED].stages
  const applyTrackChange = (patch) => setForm(p => (
    { ...p, ...patch, comp_data: { ...(p.comp_data || {}), ...(patch.comp_data || {}) } }
  ))

  const COMM_SUBTYPES = ['multifamily','office','land','retail','industrial','mixed-use']

  const save = async () => {
    const e = {}
    if (!form.title.trim()) e.title = true
    setErrors(e)
    if (Object.keys(e).length > 0) return
    setSaving(true)
    try {
      // Linking a NEW deal to a property is a conversion too, so its co-agents
      // come along exactly as they do from the property's "Start Deal" button.
      // An existing deal only seeds from the property once, at conversion time.
      const seededCoAgents = deal?.id ? [] : coAgentIdsForNewDeal(linkedProperty, form.agent_id || null)
      // Manual picks from the Additional Agents field, merged with anything seeded
      // from the property above — never the primary agent, never duplicated.
      const finalCoAgentIds = [...new Set([...additionalAgentIds, ...seededCoAgents])].filter(id => id && id !== form.agent_id)

      // Anyone taken OFF the field who is still on the listing. Access is
      // derived from both records (migration 0055), so removing them from the
      // deal alone revokes nothing — the listing would keep granting them the
      // deal and every document on it. Removing them here means removing them
      // from the listing, which is also how the database then propagates it to
      // the listing's other deals. Additions travel the other way on their own,
      // through the deal → listing trigger.
      const removedFromListing = propertyCoAgentIds(linkedProperty)
        .filter(id => id && id !== form.agent_id && !finalCoAgentIds.includes(id))

      // Only the sides this deal actually represents are saved: flipping Both →
      // Buyer must not leave a seller contact on the row for a form to print.
      // The picked people stay in drawer state, so flipping back restores them.
      const savedSides = { buyer: null, seller: null }
      for (const side of visibleSides) savedSides[side] = primaryFor(side) || null
      const savedExtras = {
        buyer:  visibleSides.includes('buyer')  ? (additionalBySide.buyer  || []) : [],
        seller: visibleSides.includes('seller') ? (additionalBySide.seller || []) : [],
      }
      // On a both-sided deal either primary is a defensible mirror, so the rule
      // is "don't change it": a deal already pointing at one of the two keeps
      // pointing there, and only a deal with no usable mirror picks one — the
      // seller, the party this deal's property, title and price belong to.
      // Without this, switching an existing buyer-side deal to Both would
      // silently repoint the portal, the mass-email token and the BoldSign
      // prefill at a different person.
      const mirrorPrimaryId = representing === 'both'
        ? ([savedSides.buyer, savedSides.seller].includes(form.contact_id) ? form.contact_id : (savedSides.seller || savedSides.buyer))
        : savedSides[visibleSides[0]]

      // Explicit whitelist — never spread full form object (prevents unknown-column schema errors)
      let payload = {
        co_agent_ids:        finalCoAgentIds,
        title:               form.title.trim(),
        stage:               form.stage,
        value:               form.value !== '' && form.value !== null ? Number(form.value) : null,
        probability:         Number(form.probability) || 0,
        expected_close_date: form.expected_close_date || null,
        // `contact_id` stays the single primary contact of the side we represent —
        // the BoldSign prefill, the client portal, mass email and every deal card
        // read it, and none of them know about sides. See mirrorPrimaryId above
        // for what a both-sided deal points it at.
        contact_id:          mirrorPrimaryId       || null,
        buyer_contact_id:    savedSides.buyer,
        seller_contact_id:   savedSides.seller,
        property_id:         form.property_id  || null,
        agent_id:            form.agent_id     || null,
        notes:               form.notes        || null,
        prop_category:       form.prop_category || null,
        prop_subtype:        form.prop_subtype  || null,
        comp_data:           form.comp_data     || null,
        // Commission entry — only the field the chosen type uses is persisted, so
        // switching percent ⇄ flat can't leave a stale amount behind for the
        // engine (or a listing agreement) to pick up.
        commission_type:     form.commission_type === 'flat' ? 'flat' : 'percent',
        commission_pct:      form.commission_type !== 'flat' && form.commission_pct  !== '' && form.commission_pct  !== null ? Number(form.commission_pct)  : null,
        commission_flat:     form.commission_type === 'flat' && form.commission_flat !== '' && form.commission_flat !== null ? Number(form.commission_flat) : null,
      }
      // The other way a duplicate gets made: a NEW deal in this drawer pointed
      // at a property that already carries an open one on the same side. Same
      // reasoning as Properties.jsx — the check has to reach the database,
      // because the deals in this browser are RLS-scoped and a colleague's is
      // not among them. Editing an existing deal is never blocked.
      if (!deal?.id && payload.property_id) {
        const side = String(payload.comp_data?.transaction_type || '').trim() || null
        const { deals: clash, error: clashErr } = await checkOpenDealsOnProperty(payload.property_id, side)
        if (clashErr) {
          console.warn('Duplicate-deal check failed, continuing:', clashErr)
        } else {
          const other = clash.filter(c => c.deal_id !== deal?.id)
          if (other.length) {
            setSaving(false)
            const who = other[0].agent_name || 'Another agent'
            pushToast(
              `${who} already has an open ${other[0].side !== 'unknown' ? other[0].side + '-side ' : ''}deal on this property. ` +
              `Add yourself to that deal instead of starting a second one — documents and terms do not cross between them.`,
              'error'
            )
            return
          }
        }
      }

      const write = async (body) => {
        if (deal?.id) {
          const { error } = await updateDeal(deal.id, body)
          return { error, savedId: deal.id }
        }
        const { data, error } = await insertDeal(body)
        return { error, savedId: data?.id }
      }

      let { error, savedId } = await write(payload)
      let degraded = false
      let coAgentsDropped = false

      // deals.co_agent_ids arrives with migration 0025. Until it's applied the
      // deal saves without it and the team still resolves from the linked
      // property, so this degrades quietly rather than failing the save.
      if (error && isMissingCoAgentColumn(error)) {
        const { co_agent_ids, ...rest } = payload
        payload = rest
        coAgentsDropped = true
        ;({ error, savedId } = await write(payload))
      }

      // deals.buyer_contact_id / seller_contact_id arrive with migration 0040.
      // Until it's applied the deal saves with `contact_id` alone — the
      // pre-0040 single-contact behavior — rather than failing the save.
      let sidesDropped = false
      if (error && isMissingSideColumn(error)) {
        const { buyer_contact_id, seller_contact_id, ...rest } = payload
        payload = rest
        sidesDropped = true
        ;({ error, savedId } = await write(payload))
      }

      // The commission columns arrive with migration 0024. Until it's applied,
      // drop them and save the rest rather than blocking the whole deal — the
      // agent gets an actionable pointer instead of an opaque schema error.
      if (error && /commission_(type|pct|flat)/.test(error.message || '')) {
        const { commission_type, commission_pct, commission_flat, ...rest } = payload
        const retry = await write(rest)
        if (retry.error) { pushToast(friendlyDbError(retry.error) || retry.error.message, 'error'); return }
        savedId  = retry.savedId
        degraded = true
      } else if (error) {
        pushToast(friendlyDbError(error) || error.message, 'error'); return
      }

      // Sync additional contacts (best-effort — the deal itself is already saved),
      // then mirror the result into global state so the picker and the deal page's
      // People card read the rows that now exist.
      if (savedId && await syncDealContacts(savedId, savedExtras)) {
        await reloadDealContacts(setDb, savedId)
      }

      // A NEW deal gets its checklist straight away when its state is known —
      // from the deal or its property — so the Checklist tab is already filled
      // the first time the agent opens it. Best-effort: the deal is saved.
      if (!deal?.id && savedId) {
        const seedFrom = { prop_category: payload.prop_category, comp_data: payload.comp_data }
        const st = checklistStateFor(seedFrom, linkedProperty)
        if (st) {
          try { await seedChecklist(savedId, st, checklistKindFor(seedFrom), payload.prop_category) }
          catch (err) { console.warn('[DealDrawer] checklist seed failed:', err) }
        }
      }

      // ── Take the removed agents off the listing ────────────────────────────
      // Best-effort and AFTER the deal is saved: the edit is never lost to this.
      // RLS lets it through because anyone editing this deal is on the listing
      // (properties_update, migration 0055); if it is refused, say so rather
      // than leaving the agent believing access was revoked when it was not.
      if (savedId && linkedProperty && removedFromListing.length) {
        const keptOnListing = propertyCoAgentIds(linkedProperty)
          .filter(id => !removedFromListing.includes(id))
        const { error: listingErr } = await updatePropertyDetails(linkedProperty.id, { ...(linkedProperty.details || {}), co_agent_ids: keptOnListing })
        if (listingErr) {
          console.warn('[DealDrawer] could not update the listing team:', listingErr)
          pushToast('Deal saved, but those agents are still on the listing — ask an office admin to remove them there.', 'error')
        } else if (setDb) {
          setDb(prev => ({
            ...prev,
            properties: (prev.properties || []).map(p => p.id === linkedProperty.id
              ? { ...p, details: { ...(p.details || {}), co_agent_ids: keptOnListing } }
              : p),
          }))
        }
      }

      // ── Price round-trip ───────────────────────────────────────────────────
      // The deal's value and the listing's price are one number
      // (src/lib/pricing.js): a change here reaches the property, its other open
      // deals, and the shared Pricing History both tabs read. Best-effort — the
      // deal is already saved, so a failure warns rather than losing the edit.
      let priceWarning = null
      if (savedId && priceChanged(deal?.value, form.value)) {
        const sync = await syncPriceChange({
          price: form.value, previousPrice: deal?.value, origin: 'deal',
          property: linkedProperty, dealId: savedId, deals, actor: activeAgent,
        })
        priceWarning = sync.warning
        if ((sync.propertyPatch || sync.repricedDealIds.length) && setDb) {
          const nextValue = payload.value
          setDb(prev => ({
            ...prev,
            properties: sync.propertyPatch
              ? (prev.properties || []).map(p => p.id === form.property_id ? { ...p, ...sync.propertyPatch } : p)
              : prev.properties,
            deals: (prev.deals || []).map(d => sync.repricedDealIds.includes(d.id) ? { ...d, value: nextValue } : d),
          }))
        }
      }

      const coAgentWarning = coAgentsDropped && seededCoAgents.length
        ? 'Deal saved, but its co-agents were not — ask an admin to apply database migration 0025.'
        : null
      const sidesWarning = sidesDropped
        ? 'Deal saved, but the buyer/seller split was not — ask an admin to apply database migration 0040.'
        : null
      const warning = degraded
        ? 'Deal saved, but the commission was not — ask an admin to apply database migration 0024.'
        : sidesWarning || coAgentWarning || priceWarning
      pushToast(warning || (deal?.id ? 'Deal updated' : 'Deal added'), warning ? 'error' : undefined)
      await onSave()
      onClose()
      // A NEW deal opens on its own page — its checklist, signatures and key
      // dates are the next thing the agent needs, and the board was a dead end.
      if (!deal?.id && savedId) onCreated?.(savedId)
    } catch(err) {
      console.error('[DealDrawer] save error:', err)
      pushToast('Something went wrong.', 'error')
    } finally {
      setSaving(false)
    }
  }

  const isExisting = !!deal?.id

  return (
    <Drawer
      open={open} onClose={onClose}
      title={deal?.id ? (form.title || 'Edit Deal') : 'Add Deal'}
      width={expanded ? DRAWER_WIDE : DRAWER_WIDTH}
      headerExtra={isExisting ? (
        <button
          type="button" className="btn btn--ghost btn--icon btn--sm"
          onClick={() => setExpanded(e => !e)}
          title={expanded ? 'Narrow the drawer — the board comes back into view' : 'Widen the drawer for a longer editing session'}
          aria-label={expanded ? 'Narrow this drawer' : 'Widen this drawer'}
          style={{ fontSize:14, lineHeight:1, color:'var(--gw-mist)' }}
        >
          {expanded ? '⇥' : '⇤'}
        </button>
      ) : null}
    >
      {/* Tab bar — only for existing deals. Pricing History is not here on
          purpose: price changes record themselves (syncPriceChange, below), so
          the history is a read-only log and now lives under the number it
          describes on the Details tab, instead of costing a whole tab. */}
      {isExisting && (
        <div className="drawer-tabs">
          {DEAL_TABS.map(([id, label]) => (
            <button key={id} className={`drawer-tab${tab === id ? ' active' : ''}`} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>
      )}

      {/* Details tab */}
      {tab === 'details' && (
        <>
          <div className="drawer__body">
            <div className="form-group"><label className="form-label required">Deal Title</label><input className={`form-control${errors.title?' error':''}`} value={form.title} onChange={e=>set('title',e.target.value)} placeholder="e.g. 123 Main St Purchase" /></div>

            {/* Residential / Commercial toggle */}
            <div className="form-group">
              <label className="form-label">Property Category</label>
              <div style={{ display:'flex', gap:0, border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', overflow:'hidden' }}>
                {['residential','commercial'].map(cat => (
                  <button key={cat} type="button" onClick={() => applyTrackChange({ prop_category: cat, ...(cat === 'residential' ? { prop_subtype: '' } : {}) })}
                    style={{ flex:1, padding:'7px 0', border:'none', cursor:'pointer', fontFamily:'var(--font-body)', fontSize:12, fontWeight:600, transition:'all 150ms',
                      background: form.prop_category === cat ? 'var(--gw-slate)' : '#fff',
                      color:      form.prop_category === cat ? '#fff'            : 'var(--gw-mist)' }}>
                    {cat.charAt(0).toUpperCase()+cat.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            {/* Which side(s) of the table we represent. Decides which contact
                sections appear below, and which Form Library packets the deal's
                forms come from. Shares the Forms tab's
                comp_data.transaction_type field.

                Commercial deals get it too: an agent representing both parties
                on a multifamily sale has the same two client sets to keep
                apart, and nothing on the board depends on this value. */}
            <div className="form-group">
              <label className="form-label">Representing</label>
              <div style={{ display:'flex', gap:0, border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', overflow:'hidden' }}>
                {REPRESENTING_OPTIONS.map(([side, label]) => {
                  const selected = representing === side
                  return (
                    <button key={side} type="button" onClick={() => applyTrackChange({ comp_data: { transaction_type: side } })}
                      style={{ flex:1, padding:'7px 0', border:'none', cursor:'pointer', fontFamily:'var(--font-body)', fontSize:12, fontWeight:600, transition:'all 150ms',
                        background: selected ? 'var(--gw-slate)' : '#fff',
                        color:      selected ? '#fff'            : 'var(--gw-mist)' }}>
                      {label}
                    </button>
                  )
                })}
              </div>
              {representing === 'both' && (
                <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginTop: 4 }}>
                  Representing both parties — each side keeps its own contacts below.
                </div>
              )}
            </div>

            {/* Commercial subtype */}
            {form.prop_category === 'commercial' && (
              <div className="form-group">
                <label className="form-label">Commercial Type</label>
                <select className="form-control" value={form.prop_subtype||''} onChange={e=>set('prop_subtype',e.target.value)}>
                  <option value="">— Select type —</option>
                  {COMM_SUBTYPES.map(t=><option key={t} value={t}>{t.charAt(0).toUpperCase()+t.slice(1)}</option>)}
                </select>
              </div>
            )}

            <div className="form-group"><label className="form-label">Stage</label><select className="form-control" value={formStages.includes(form.stage) ? form.stage : boardStageFor(form, formTrack)} onChange={e=>set('stage',e.target.value)}>{formStages.map(s=><option key={s} value={s}>{stageLabels[s]}</option>)}</select></div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Sale / Deal Value</label>
                <input className="form-control" type="number" value={form.value||''} onChange={e=>set('value',e.target.value)} placeholder="0" />
                {/* The deal's value and the listing's price are one number
                    (src/lib/pricing.js) — this says so out loud before the
                    agent saves, rather than letting the two drift silently. */}
                {linkedProperty && priceChanged(linkedProperty.list_price, form.value) && (
                  <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginTop: 4 }}>
                    Listing price is {linkedProperty.list_price ? formatCurrency(linkedProperty.list_price) : 'not set'} — saving updates the property and logs the change.
                  </div>
                )}
                {/* The history of this number, under the number. This replaced
                    the Pricing History tab: the log records itself, so it needs
                    to be READ here, not worked in somewhere else. */}
                {isExisting && <DealPriceLine deal={deal} property={linkedProperty} />}
              </div>
              <div className="form-group"><label className="form-label">Probability %</label><input className="form-control" type="number" min="0" max="100" value={form.probability||0} onChange={e=>set('probability',e.target.value)} /></div>
            </div>
            <div className="form-group"><label className="form-label">Expected Close Date</label><input className="form-control" type="date" value={form.expected_close_date||''} onChange={e=>set('expected_close_date',e.target.value)} /></div>
            {/* One contact section per side we represent. On a 'both' deal that
                is two, each with its own primary and its own extras, because a
                buyer and a seller are not interchangeable people and editing one
                must never touch the other. On a one-sided deal it reads exactly
                like the single Contact field it replaces, just labelled with the
                side it belongs to. */}
            {visibleSides.map(side => {
              const otherSide   = side === 'buyer' ? 'seller' : 'buyer'
              const extras      = additionalBySide[side] || []
              const showOwners  = side === ownerSide && propertyOnlyContacts.length > 0
              // Anyone on the other side can't also be picked here.
              const takenOnOtherSide = new Set([
                primaryFor(otherSide),
                ...(visibleSides.includes(otherSide) ? (additionalBySide[otherSide] || []) : []),
              ].filter(Boolean))
              const pickable = contacts.filter(c => !takenOnOtherSide.has(c.id))
              return (
                <div key={side} style={representing === 'both' ? {
                  border:'1px solid var(--gw-border)', borderRadius:'var(--radius)',
                  padding:'12px 12px 4px', marginBottom:12, background:'var(--gw-bone)',
                } : undefined}>
                  {representing === 'both' && (
                    <div style={{ fontSize:11, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.08em', color:'var(--gw-mist)', marginBottom:10 }}>
                      {SIDE_LABELS[side]} side
                    </div>
                  )}
                  <div className="form-group">
                    <label className="form-label">{SIDE_LABELS[side]} Contact</label>
                    <SearchDropdown items={pickable} value={primaryFor(side)} onSelect={v=>setPrimaryFor(side, v)}
                      placeholder={`Search ${side === 'buyer' ? 'buyers' : 'sellers'}…`} labelKey={c=>`${c.first_name} ${c.last_name}`} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Additional {SIDE_LABELS[side]} Contacts</label>
                    <ContactMultiSelect contacts={pickable} selectedIds={extras} onChange={next=>changeAdditionalContacts(side, next)}
                      excludeId={primaryFor(side)}
                      placeholder={side === 'buyer' ? 'Add co-buyer, spouse…' : 'Add co-owner, spouse…'} />
                    <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginTop: 4 }}>Husband &amp; wife, co-buyers, co-owners — these also pre-fill as signers when you Send from Template.</div>
                    {showOwners && (
                      <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginTop: 6, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span>Also on this property:</span>
                        {propertyOnlyContacts.map(c => (
                          <button key={c.id} type="button" className="btn btn--ghost btn--sm" style={{ fontSize: 11, padding: '1px 7px' }}
                            onClick={() => changeAdditionalContacts(side, [...extras, c.id])}>
                            + {c.first_name} {c.last_name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
            <div className="form-group"><label className="form-label">Property</label><SearchDropdown items={properties} value={form.property_id} onSelect={linkProperty} placeholder="Search properties…" labelKey={propertyLabel} /></div>
            <div className="form-group"><label className="form-label">Assigned Agent</label><select className="form-control" value={form.agent_id||''} onChange={e=>set('agent_id',e.target.value)}>{!form.agent_id && <option value="">Choose an agent…</option>}{agents.map(a=><option key={a.id} value={a.id}>{a.id === activeAgent?.id ? `${a.name} (you)` : a.name}</option>)}</select></div>
            <div className="form-group">
              <label className="form-label">Additional Agents</label>
              <AgentMultiSelect agents={agents} selectedIds={additionalAgentIds} onChange={v=>set('co_agent_ids',v)} excludeId={form.agent_id} placeholder="Search agents to add…" />
            </div>

            {/* ── Commission ────────────────────────────────────── */}
            <CommissionFields form={form} deal={deal} set={set} apply={applyTrackChange} agents={agents} viewerId={activeAgent?.id} />

            {/* ── Comp Data ─────────────────────────────────────── */}
            <div style={{ borderTop:'1px solid var(--gw-border)', paddingTop:14, marginTop:4 }}>
              <div style={{ fontSize:11, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.08em', color:'var(--gw-mist)', marginBottom:12 }}>Comp Data</div>

              {form.prop_category === 'residential' && (
                <>
                  <div className="form-row">
                    <div className="form-group"><label className="form-label">Beds</label><input className="form-control" type="number" value={cd.beds||''} onChange={e=>setCD('beds',e.target.value)} /></div>
                    <div className="form-group"><label className="form-label">Baths</label><input className="form-control" type="number" step="0.5" value={cd.baths||''} onChange={e=>setCD('baths',e.target.value)} /></div>
                  </div>
                  <div className="form-row">
                    <div className="form-group"><label className="form-label">Sq Ft</label><input className="form-control" type="number" value={cd.sqft||''} onChange={e=>setCD('sqft',e.target.value)} /></div>
                    <div className="form-group"><label className="form-label">Garage</label>
                      <select className="form-control" value={cd.garage??''} onChange={e=>setCD('garage',e.target.value)}>
                        <option value="">—</option><option value="0">No Garage</option><option value="1">1 Car</option><option value="2">2 Car</option><option value="3">3+ Car</option>
                      </select>
                    </div>
                  </div>
                </>
              )}

              {form.prop_category === 'commercial' && form.prop_subtype === 'multifamily' && (
                <>
                  <div className="form-row">
                    <div className="form-group"><label className="form-label">Total Units</label><input className="form-control" type="number" value={cd.total_units||''} onChange={e=>setCD('total_units',e.target.value)} /></div>
                    <div className="form-group"><label className="form-label">Price / Unit</label><input className="form-control" type="number" value={cd.price_per_unit||''} onChange={e=>setCD('price_per_unit',e.target.value)} /></div>
                  </div>
                  <div className="form-group"><label className="form-label">Unit Mix</label><input className="form-control" value={cd.unit_mix||''} onChange={e=>setCD('unit_mix',e.target.value)} placeholder="e.g. 10×1BR, 5×2BR" /></div>
                  <div className="form-row">
                    <div className="form-group"><label className="form-label">City / County</label><input className="form-control" value={cd.city||''} onChange={e=>setCD('city',e.target.value)} /></div>
                    <div className="form-group"><label className="form-label">Sq Ft (total)</label><input className="form-control" type="number" value={cd.sqft||''} onChange={e=>setCD('sqft',e.target.value)} /></div>
                  </div>
                </>
              )}

              {form.prop_category === 'commercial' && form.prop_subtype === 'land' && (
                <>
                  <div className="form-row">
                    <div className="form-group"><label className="form-label">Acres</label><input className="form-control" type="number" step="0.01" value={cd.acres||''} onChange={e=>setCD('acres',e.target.value)} /></div>
                    <div className="form-group"><label className="form-label">Sq Ft</label><input className="form-control" type="number" value={cd.sqft||''} onChange={e=>setCD('sqft',e.target.value)} /></div>
                  </div>
                  <div className="form-row">
                    <div className="form-group"><label className="form-label">Status</label>
                      <select className="form-control" value={cd.land_status||''} onChange={e=>setCD('land_status',e.target.value)}>
                        <option value="">—</option><option value="raw">Raw Land</option><option value="developed">Developed</option><option value="ready">Ready to Build</option>
                      </select>
                    </div>
                    <div className="form-group"><label className="form-label">Zoning</label><input className="form-control" value={cd.zoning||''} onChange={e=>setCD('zoning',e.target.value)} placeholder="R-1, C-2…" /></div>
                  </div>
                </>
              )}

              {form.prop_category === 'commercial' && form.prop_subtype === 'office' && (
                <>
                  <div className="form-row">
                    <div className="form-group"><label className="form-label">Sq Ft</label><input className="form-control" type="number" value={cd.sqft||''} onChange={e=>setCD('sqft',e.target.value)} /></div>
                    <div className="form-group"><label className="form-label">Price / SF</label><input className="form-control" type="number" step="0.01" value={cd.price_per_sf||''} onChange={e=>setCD('price_per_sf',e.target.value)} /></div>
                  </div>
                  <div className="form-row">
                    <div className="form-group"><label className="form-label">Class</label>
                      <select className="form-control" value={cd.class||''} onChange={e=>setCD('class',e.target.value)}>
                        <option value="">—</option><option value="A">Class A</option><option value="B">Class B</option><option value="C">Class C</option>
                      </select>
                    </div>
                    <div className="form-group"><label className="form-label">Floors</label><input className="form-control" type="number" value={cd.floors||''} onChange={e=>setCD('floors',e.target.value)} /></div>
                  </div>
                </>
              )}

              {form.prop_category === 'commercial' && form.prop_subtype === 'retail' && (
                <>
                  <div className="form-row">
                    <div className="form-group"><label className="form-label">Sq Ft</label><input className="form-control" type="number" value={cd.sqft||''} onChange={e=>setCD('sqft',e.target.value)} /></div>
                    <div className="form-group"><label className="form-label">Price / SF</label><input className="form-control" type="number" step="0.01" value={cd.price_per_sf||''} onChange={e=>setCD('price_per_sf',e.target.value)} /></div>
                  </div>
                  <div className="form-row">
                    <div className="form-group"><label className="form-label">Frontage (ft)</label><input className="form-control" type="number" value={cd.frontage||''} onChange={e=>setCD('frontage',e.target.value)} /></div>
                    <div className="form-group"><label className="form-label">Parking Spaces</label><input className="form-control" type="number" value={cd.parking||''} onChange={e=>setCD('parking',e.target.value)} /></div>
                  </div>
                </>
              )}

              {form.prop_category === 'commercial' && form.prop_subtype === 'industrial' && (
                <>
                  <div className="form-row">
                    <div className="form-group"><label className="form-label">Sq Ft</label><input className="form-control" type="number" value={cd.sqft||''} onChange={e=>setCD('sqft',e.target.value)} /></div>
                    <div className="form-group"><label className="form-label">Price / SF</label><input className="form-control" type="number" step="0.01" value={cd.price_per_sf||''} onChange={e=>setCD('price_per_sf',e.target.value)} /></div>
                  </div>
                  <div className="form-row">
                    <div className="form-group"><label className="form-label">Clear Height (ft)</label><input className="form-control" type="number" value={cd.clear_height||''} onChange={e=>setCD('clear_height',e.target.value)} /></div>
                    <div className="form-group"><label className="form-label">Loading Docks</label><input className="form-control" type="number" value={cd.loading_docks||''} onChange={e=>setCD('loading_docks',e.target.value)} /></div>
                  </div>
                </>
              )}

              {form.prop_category === 'commercial' && !form.prop_subtype && (
                <div style={{ fontSize:12, color:'var(--gw-mist)', textAlign:'center', padding:'8px 0' }}>Select a commercial type above to enter comp data.</div>
              )}
            </div>

            <div className="form-group" style={{ marginTop:4 }}><label className="form-label">Notes</label><textarea className="form-control form-control--textarea" value={form.notes||''} onChange={e=>set('notes',e.target.value)} /></div>
          </div>
          <div className="drawer__foot">
            <button className="btn btn--secondary" onClick={onClose}>Cancel</button>
            <button className="btn btn--primary" onClick={save} disabled={saving}>{saving?'Saving…':'Save Deal'}</button>
          </div>
        </>
      )}

      {/* Key Dates tab */}
      {/* Deal Terms tab — the per-agreement facts every packet asks for. Sits
          right after Details because it is the same kind of work: describing
          the deal once so nothing downstream has to ask again. */}
      {tab === 'terms' && isExisting && (
        <DealTermsTab deal={deal} />
      )}

      {tab === 'dates' && isExisting && (
        <KeyDatesTab deal={deal} />
      )}

      {/* Pricing History tab — the LINKED PROPERTY's price log, which is the
          same log the property drawer's own tab shows. The price belongs to the
          building, so a reduction made on either surface appears on both. */}
      {/* Checklist tab */}
      {tab === 'checklist' && isExisting && (
        <ChecklistTab deal={deal} property={linkedProperty} />
      )}

      {/* Documents tab */}
      {tab === 'documents' && isExisting && (
        <DocumentsTab deal={deal} />
      )}

      {/* Signatures tab */}
      {tab === 'signatures' && isExisting && (
        <SignaturesTab deal={deal} contacts={contacts} properties={properties} extraContacts={extraContacts} sideClients={sideClients} agents={agents} activeAgent={activeAgent} />
      )}

      {/* Client Portal tab */}
      {tab === 'portal' && isExisting && (
        <PortalTab deal={deal} />
      )}
    </Drawer>
  )
}
