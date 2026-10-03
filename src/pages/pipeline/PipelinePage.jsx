// Pipeline — the deals board (kanban by stage) and the listings board.
// The deal itself opens in DealDrawer (src/pages/deal/).

import React, { useState, useRef, useMemo, useCallback } from 'react'
import { supabase } from '../../lib/supabase.js'
import { fetchVisibleDeals } from '../../lib/services/deals.js'
import { formatCurrency, formatDate, getKeyDateUrgency, getNearestKeyDate } from '../../lib/helpers.js'
import { TRACKS, UNIFIED, boardStageFor, isOpenStage } from '../../lib/stages.js'
import { changeDealStage } from '../../lib/services/dealStage.js'
import { mutationErrorMessage } from '../../lib/services/db.js'
import { normalizeStageLabel, hasStageLabelOverrides } from '../../lib/stageLabels.js'
import { useStageLabels } from '../../lib/stageLabelContext.js'
import { saveStageLabels } from '../../lib/services/agentProfile.js'
import {
  weightedValue, daysInStage, isRotting, dealActivityState, nextKeyDate, focusItems, pipelineTotals,
} from '../../lib/pipeline.js'
import { isResidentialPropertyType } from '../../lib/enums.js'
import { agentIdsOnDeal } from '../../lib/coAgents.js'
import { friendlyDbError } from '../../lib/dbErrors.js'
import { streetLine } from '../../lib/address.js'
import { Icon, Badge, Avatar, EmptyState, ConfirmDialog, pushToast } from '../../components/UI.jsx'
import { dealsOnBoard, listingsOnBoard } from './boardFilters.js'
import { LISTING_STATUS_COLORS, LISTING_STATUS_LABELS, LISTING_STATUS_ORDER } from './listingStatus.js'
import { StageHeader } from './StageHeader.jsx'
import { ListingCard } from './ListingCard.jsx'
import { DealDrawer } from '../deal/DealDrawer.jsx'

export default function PipelinePage({ db, setDb, activeAgent, isAdmin, dealAgentIds, go, focusRecord, onFocusHandled }) {
  const [drawer, setDrawer] = useState(false)
  const [editing, setEditing] = useState(null)
  const [defaultStage, setDefaultStage] = useState('lead')
  const [pipelineTab, setPipelineTab] = useState('deals')
  // Board | List | Focus — remembered per agent; first visit defaults by specialty
  // (commercial agents read few high-value deals best as a table).
  const viewKey = `gw_deal_view_${activeAgent?.id || 'default'}`
  const [dealView, setDealView] = useState(() => {
    const saved = localStorage.getItem(viewKey)
    if (['board', 'list', 'focus'].includes(saved)) return saved
    return activeAgent?.specialty === 'commercial' ? 'list' : 'board'
  })
  const pickView = (v) => { setDealView(v); localStorage.setItem(viewKey, v) }
  const [sortBy, setSortBy] = useState({ col: 'updated', dir: 'desc' })
  const [confirm, setConfirm] = useState(null)
  const [confirmProp, setConfirmProp] = useState(null)
  const [dragging, setDragging] = useState(null)
  const [dragOver, setDragOver] = useState(null)
  const [dragListing, setDragListing] = useState(null)
  const [dragOverStatus, setDragOverStatus] = useState(null)
  const [agentFilter, setAgentFilter] = useState('all')

  // ── Personal column headers ──────────────────────────────────────────────
  // Provided by App (defaults + this agent's overrides). Renaming writes to the
  // agent row through the authenticated profile API and mirrors the SAVED row
  // back into db.agents, which is what re-renders the provider — so a rename
  // the server rejected never sticks on screen.
  const stageLabels   = useStageLabels()
  const canRename     = !!activeAgent?.id
  const [renaming, setRenaming] = useState(false)

  // Renaming two columns in quick succession must not lose the first. Each save
  // sends the WHOLE map, so the second request has to be built from the first
  // one's intent — not from `activeAgent`, which won't have caught up yet. This
  // ref carries that intent, tagged with the agent it belongs to so switching
  // agents (admin "view as") can never inherit someone else's pending edit.
  const pendingLabels = useRef({ agentId: null, labels: null })
  const myStageLabels =
    (pendingLabels.current.agentId === activeAgent?.id ? pendingLabels.current.labels : null)
    || activeAgent?.stage_labels || {}

  const persistStageLabels = async (next) => {
    if (!activeAgent?.id) return
    pendingLabels.current = { agentId: activeAgent.id, labels: next }
    setRenaming(true)
    try {
      const saved = await saveStageLabels(activeAgent.id, next)
      setDb(p => ({ ...p, agents: (p.agents || []).map(a => a.id === saved.id ? { ...a, ...saved } : a) }))
    } catch (e) {
      // Fall back to whatever the server actually holds, so a retry doesn't
      // build on an edit that never landed.
      pendingLabels.current = { agentId: null, labels: null }
      pushToast(e.message || 'Could not save the column name', 'error')
    } finally {
      setRenaming(false)
    }
  }

  const renameStage = (stage, value) => {
    const label = normalizeStageLabel(stage, value)
    const next  = { ...myStageLabels }
    // A blank entry (or one that matches the built-in name) removes the
    // override rather than storing it — that's how a column resets.
    if (label) next[stage] = label
    else       delete next[stage]
    if (next[stage] === myStageLabels[stage]) return   // nothing actually changed
    persistStageLabels(next)
  }

  const resetStageLabels = () => persistStageLabels({})

  const deals        = db.deals        || []
  const agents       = db.agents       || []
  const contacts     = db.contacts     || []
  const properties   = db.properties   || []
  const tasks        = db.tasks        || []
  const dealContacts = db.dealContacts || []   // additional-contact link rows (migration 0021)

  // O(1) lookups — built once per data change, not per-card in render loop
  const contactMap  = useMemo(() => Object.fromEntries(contacts.map(c => [c.id, c])),   [contacts])
  const agentMap    = useMemo(() => Object.fromEntries(agents.map(a => [a.id, a])),     [agents])
  const propertyMap = useMemo(() => Object.fromEntries(properties.map(p => [p.id, p])), [properties])

  // Filter deals for admin view (by agent) or show all.
  //
  // "That agent's deals" means the deals they are ON, not the ones they own.
  // Filtering on `agent_id` alone showed a shared deal under the OWNER only, so
  // an admin checking two agents who co-list would see it on one pipeline and
  // not the other — and read that as the deal failing to sync between them,
  // when both agents' own logins showed it correctly all along. Third instance
  // of the same mistake (the deal grant in #151, the Listings board in #152):
  // an access question answered by ownership instead of membership.
  const visibleDeals = useMemo(
    () => dealsOnBoard({ deals, propertyMap, isAdmin, agentFilter }),
    [deals, propertyMap, isAdmin, agentFilter])

  // One unified pipeline — every deal on the same board (no res/comm split).
  const resolvedTrack = UNIFIED
  const track = TRACKS[UNIFIED]

  // "+ Deal" from elsewhere (the dashboard) lands here with the blank deal
  // form already open — same one-shot handoff ContactsPage uses.
  React.useEffect(() => {
    if (focusRecord?.type !== 'new-deal') return
    setEditing(null); setDefaultStage(track.stages[0]); setDrawer(true)
    onFocusHandled?.()
  }, [focusRecord])
  const trackDeals = visibleDeals

  // Single-pass O(n) grouping into the active track's columns. Foreign stage
  // tokens (legacy data) land in the nearest column via boardStageFor — the
  // stored stage is rewritten only when the card is dragged.
  const { stageGroups, stageTotals } = useMemo(() => {
    const groups = Object.fromEntries(track.stages.map(s => [s, []]))
    const totals = Object.fromEntries(track.stages.map(s => [s, 0]))
    trackDeals.forEach(d => {
      const col = boardStageFor(d, resolvedTrack)
      groups[col].push(d)
      totals[col] += d.value || 0
    })
    return { stageGroups: groups, stageTotals: totals }
  }, [trackDeals, track, resolvedTrack])

  // ── Intelligence bar: open-deal rollups for the active track ───────────────
  const openTrackDeals = useMemo(() => trackDeals.filter(d => isOpenStage(d.stage)), [trackDeals])
  const intel = useMemo(() => {
    const t = pipelineTotals(openTrackDeals)
    const now = new Date(); const eom = new Date(now.getFullYear(), now.getMonth() + 1, 0)
    const closingThisMonth = openTrackDeals
      .filter(d => d.expected_close_date && new Date(d.expected_close_date) <= eom)
      .reduce((s, d) => s + (Number(d.value) || 0), 0)
    return { ...t, closingThisMonth }
  }, [openTrackDeals])

  // ── List view: flat, sortable rows for the active track ────────────────────
  const listRows = useMemo(() => {
    const now = new Date()
    const rows = trackDeals.map(d => {
      const act = dealActivityState(d, tasks, now)
      const kd  = nextKeyDate(d, now)
      return {
        deal: d, contact: contactMap[d.contact_id], agent: agentMap[d.agent_id],
        weighted: weightedValue(d), dis: daysInStage(d, now), rotting: isRotting(d, now),
        activity: act, keyDate: kd,
      }
    })
    const dir = sortBy.dir === 'asc' ? 1 : -1
    const val = (r) => {
      switch (sortBy.col) {
        case 'title':    return (r.deal.title || '').toLowerCase()
        case 'stage':    return track.stages.indexOf(boardStageFor(r.deal, resolvedTrack))
        case 'value':    return Number(r.deal.value) || 0
        case 'weighted': return r.weighted
        case 'close':    return r.deal.expected_close_date ? new Date(r.deal.expected_close_date).getTime() : Infinity * dir
        case 'keydate':  return r.keyDate ? r.keyDate.daysUntil : Infinity * dir
        case 'stale':    return r.dis ?? -1
        default:         return new Date(r.deal.updated_at || r.deal.created_at || 0).getTime()
      }
    }
    return rows.sort((a, b) => {
      const av = val(a), bv = val(b)
      if (typeof av === 'string') return av.localeCompare(bv) * dir
      return (av - bv) * dir
    })
  }, [trackDeals, tasks, contactMap, agentMap, sortBy, track, resolvedTrack])
  const toggleSort = (col) => setSortBy(s => s.col === col ? { col, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: col === 'title' ? 'asc' : 'desc' })

  // ── Focus view: cross-track "needs attention today" ───────────────────────
  const focus = useMemo(() => focusItems(visibleDeals, tasks, new Date()), [visibleDeals, tasks])
  const focusCount = focus.length

  // Listings board — filter by agent if needed, group by property status
  //
  // "Mine" here means the listings this agent is ON, not only the ones assigned
  // to them. Migration 0055 made that the rule everywhere else — a co-agent
  // named on a listing, or on a deal linked to it, is on that listing — but
  // this board open-coded `assigned_agent_id === me`, so the second agent on a
  // shared listing saw the DEAL on the Deals tab and no listing behind it on
  // the Listings tab. Same class of bug as the one 0055 fixed: a client-side
  // reimplementation of the access rule, drifted from the rule.
  //
  // For a non-admin, every deal in `deals` is already a deal they are on (RLS
  // plus fetchVisibleDeals), so the property behind any of them is a listing
  // they are on — no extra fetch needed to answer it.
  const visibleListings = useMemo(
    () => listingsOnBoard({ properties, deals, propertyMap, isAdmin, agentFilter, activeAgentId: activeAgent?.id }),
    [properties, propertyMap, deals, isAdmin, agentFilter, activeAgent])

  const { listingGroups, listingTotals, totalListingValue } = useMemo(() => {
    const groups = Object.fromEntries(LISTING_STATUS_ORDER.map(s => [s, []]))
    const totals = Object.fromEntries(LISTING_STATUS_ORDER.map(s => [s, 0]))
    let total = 0
    visibleListings.forEach(p => {
      const key = p.status || 'active'
      if (groups[key]) {
        groups[key].push(p)
        totals[key] += p.list_price || 0
        total += p.list_price || 0
      }
    })
    return { listingGroups: groups, listingTotals: totals, totalListingValue: total }
  }, [visibleListings])

  const reload = useCallback(async () => {
    const { data } = await fetchVisibleDeals(supabase, {
      isAdmin, agentId: activeAgent?.id, dealAgentIds,
    })
    setDb(p => ({ ...p, deals: data || [] }))
  }, [setDb, isAdmin, dealAgentIds, activeAgent?.id])

  const del = useCallback(async (id) => {
    // Best-effort: clear this deal off any tasks pointing at it. RLS makes tasks
    // strictly personal, so this only ever reaches the CALLER'S OWN tasks — a
    // co-agent's task on the same deal is invisible here and silently unaffected,
    // which is exactly how a shared deal used to fail the delete below with a raw
    // "violates foreign key constraint tasks_deal_id_fkey". The database now
    // clears those itself (migration 0029); this stays because it costs nothing
    // and keeps deletes working on a database that hasn't had 0029 applied yet.
    await supabase.from('tasks').update({ deal_id: null }).eq('deal_id', id)
    const { error } = await supabase.from('deals').delete().eq('id', id)
    if (error) { pushToast(friendlyDbError(error) || error.message, 'error'); setConfirm(null); return }
    pushToast('Deal deleted', 'info')
    setConfirm(null); reload()
  }, [reload])

  // ── Listings: drag between statuses, delete, and open the linked deal ──────
  // Listings are `properties`; documents/signatures live on the deal that links
  // to a property (deal.property_id), so opening a listing routes to that deal.
  const moveListingStatus = useCallback(async (propertyId, newStatus) => {
    const { error } = await supabase.from('properties').update({ status: newStatus }).eq('id', propertyId)
    if (error) { pushToast(error.message, 'error'); return }
    setDb(p => ({ ...p, properties: (p.properties || []).map(pr => pr.id === propertyId ? { ...pr, status: newStatus } : pr) }))
    pushToast(`Listing moved to ${LISTING_STATUS_LABELS[newStatus]}`)
  }, [setDb])

  const delProperty = useCallback(async (id) => {
    // deals.property_id is ON DELETE SET NULL — linked deals are kept, just unlinked.
    const { error } = await supabase.from('properties').delete().eq('id', id)
    if (error) { pushToast(error.message, 'error'); setConfirmProp(null); return }
    setDb(p => ({ ...p, properties: (p.properties || []).filter(pr => pr.id !== id) }))
    pushToast('Listing removed', 'info'); setConfirmProp(null)
  }, [setDb])

  const openListing = useCallback((property) => {
    const linked = deals.filter(d => d.property_id === property.id)
    if (linked.length) {
      // Prefer an in-contract deal (either track's tokens); otherwise the most recent one.
      const target = linked.find(d => ['under-contract','psa','due-diligence','loi'].includes(d.stage)) || linked[0]
      go(`deal/${target.id}`)
      return
    } else {
      // No deal yet — open a new one prefilled from the property. Saving it
      // unlocks the Documents & Signatures tabs (those need an existing deal).
      setEditing({
        stage: 'lead',
        property_id: property.id,
        title: streetLine(property) || 'New Listing Deal',
        agent_id: property.assigned_agent_id || activeAgent?.id || '',
        prop_category: isResidentialPropertyType(property.type) ? 'residential' : 'commercial',
      })
    }
    setDrawer(true)
  }, [deals, activeAgent])

  // A drag saves through the same path as the deal page's stage rail. Closing
  // is the exception: its checks need the deal's checklist and signatures, so
  // a drop on Closed opens the deal, where the close happens.
  const moveStage = useCallback(async (dealId, newStage) => {
    const deal = deals.find(d => d.id === dealId)
    if (!deal || deal.stage === newStage) return
    if (newStage === 'closed') {
      pushToast('Close it from the deal — the closing checks run there.', 'info')
      go?.(`deal/${dealId}`)
      return
    }
    const before = deal
    setDb(p => ({ ...p, deals: p.deals.map(d => d.id === dealId ? { ...d, stage: newStage } : d) }))
    const r = await changeDealStage(deal, newStage, { actorId: activeAgent?.id })
    if (r.error) {
      setDb(p => ({ ...p, deals: p.deals.map(d => d.id === dealId ? before : d) }))
      pushToast(mutationErrorMessage(r.error, r.status), 'error')
      return
    }
    setDb(p => ({ ...p,
      deals: p.deals.map(d => d.id === dealId ? { ...d, stage: newStage, comp_data: r.comp_data } : d),
      tasks: r.task ? [r.task, ...(p.tasks || [])] : p.tasks,
    }))
    pushToast(`Moved to ${stageLabels[newStage]}`)
    if (r.task) pushToast(`Task auto-created: ${r.task.title}`, 'info')
  }, [setDb, deals, activeAgent?.id, go, stageLabels])

  return (
    <div className="page-content" style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div className="page-header">
        <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
          <div style={{ display:'flex', alignItems:'center', gap:12 }}>
            <div className="page-title">Pipeline{isAdmin ? ' — Admin View' : ''}</div>
            {/* Tab toggle */}
            <div style={{ display:'flex', background:'var(--gw-bone)', borderRadius:'var(--radius)', padding:3, gap:2 }}>
              {[['deals','Transactions'],['listings','Listings']].map(([id, label]) => (
                <button key={id} onClick={() => setPipelineTab(id)} style={{
                  padding:'5px 14px', border:'none', borderRadius:'var(--radius)', cursor:'pointer',
                  fontFamily:'var(--font-body)', fontSize:12, fontWeight:600,
                  background: pipelineTab === id ? 'var(--gw-slate)' : 'transparent',
                  color: pipelineTab === id ? '#fff' : 'var(--gw-mist)',
                  transition:'all 150ms ease',
                }}>{label}</button>
              ))}
            </div>
          </div>
          {pipelineTab === 'deals'
            ? (dealView === 'focus'
                ? <div className="page-sub">{focusCount === 0 ? 'Nothing needs attention right now — you’re clear.' : `${focusCount} item${focusCount !== 1 ? 's' : ''} need attention across all your open deals`}</div>
                : <div className="page-sub">
                    {track.label} · {intel.count} open · {formatCurrency(intel.value)} value
                    {' · '}<strong style={{ color: 'var(--gw-ink)' }}>{formatCurrency(intel.weighted)}</strong> weighted
                    {intel.closingThisMonth > 0 && <> · {formatCurrency(intel.closingThisMonth)} closing this month</>}
                  </div>)
            : <div className="page-sub">Your property inventory by status · {visibleListings.length} listing{visibleListings.length !== 1 ? 's' : ''} · {formatCurrency(totalListingValue)} listed</div>
          }
        </div>
        <div style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
          {pipelineTab === 'deals' && (
            <div style={{ display:'flex', background:'var(--gw-bone)', borderRadius:'var(--radius)', padding:3, gap:2 }}>
              {[['board','Board'],['list','List'],['focus','Focus']].map(([id, label]) => (
                <button key={id} onClick={() => pickView(id)} style={{
                  padding:'5px 12px', border:'none', borderRadius:'var(--radius)', cursor:'pointer',
                  fontFamily:'var(--font-body)', fontSize:12, fontWeight:600, display:'flex', alignItems:'center', gap:6,
                  background: dealView === id ? 'var(--gw-slate)' : 'transparent',
                  color: dealView === id ? '#fff' : 'var(--gw-mist)', transition:'all 150ms ease',
                }}>
                  {label}
                  {id === 'focus' && focusCount > 0 && (
                    <span style={{ fontSize:10, fontWeight:700, padding:'0 6px', borderRadius:8, lineHeight:'16px',
                      background: dealView === id ? 'rgba(255,255,255,0.22)' : '#fde2e2', color: dealView === id ? '#fff' : '#dc2626' }}>{focusCount}</span>
                  )}
                </button>
              ))}
            </div>
          )}
          {pipelineTab === 'deals' && dealView === 'board' && canRename && hasStageLabelOverrides(myStageLabels) && (
            <button className="btn btn--ghost btn--sm" style={{ fontSize:11 }}
              onClick={resetStageLabels} disabled={renaming}
              title="Put every column back to its standard name">
              Reset headers
            </button>
          )}
          {isAdmin && (
            <select
              value={agentFilter}
              onChange={e => setAgentFilter(e.target.value)}
              className="form-control"
              style={{ fontSize:13, minWidth:160 }}
            >
              <option value="all">All Agents</option>
              {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          )}
          {!isAdmin && pipelineTab === 'deals' && (
            <button className="btn btn--primary" onClick={() => { setEditing(null); setDefaultStage(track.stages[0]); setDrawer(true) }}>
              <Icon name="plus" size={14} /> Add Deal
            </button>
          )}
        </div>
      </div>

      {pipelineTab === 'deals' && dealView === 'board' && (
        deals.length === 0 ? (
          <EmptyState icon="pipeline" title="No deals yet" message="Add your first deal to start tracking your pipeline." action={<button className="btn btn--primary" onClick={() => { setEditing(null); setDrawer(true) }}><Icon name="plus" size={14} /> Add Deal</button>} />
        ) : (
          <div className="kanban-board">
            {track.stages.map(stage => (
              <div key={stage} className="kanban-col">
                <div className="kanban-col__head">
                  <div style={{ minWidth:0 }}>
                    <StageHeader stage={stage} label={stageLabels[stage]}
                      canRename={canRename} onRename={renameStage} />
                    {stageTotals[stage] > 0 && <div style={{ fontSize:10, color:'var(--gw-mist)', marginTop:1 }}>{formatCurrency(stageTotals[stage])}</div>}
                  </div>
                  <span className="kanban-col__count">{stageGroups[stage].length}</span>
                </div>
                <div
                  className={`kanban-col__body${dragOver === stage ? ' drag-over' : ''}`}
                  onDragOver={e => { e.preventDefault(); setDragOver(stage) }}
                  onDragLeave={() => setDragOver(null)}
                  onDrop={e => { e.preventDefault(); if (dragging && dragging !== stage) moveStage(dragging, stage); setDragOver(null); setDragging(null) }}
                >
                  {stageGroups[stage].map(deal => {
                    const contact    = contactMap[deal.contact_id]
                    const agent      = agentMap[deal.agent_id]
                    const dealProp   = deal.property_id ? propertyMap[deal.property_id] : null
                    // The deal's own co-agents (copied over at conversion), with
                    // the linked property as the fallback for deals converted
                    // before migration 0025.
                    const allAgents  = agentIdsOnDeal(deal, dealProp)
                      .map(id => agentMap[id]).filter(Boolean)
                    const overdue    = deal.expected_close_date && new Date(deal.expected_close_date) < new Date() && stage !== 'closed' && stage !== 'lost'
                    const urgency    = getKeyDateUrgency(deal)
                    const nearestKD  = urgency ? getNearestKeyDate(deal) : null
                    const act        = dealActivityState(deal, tasks)
                    const rotting    = isRotting(deal)
                    const dis        = daysInStage(deal)
                    const wtd        = weightedValue(deal)
                    const cardBorder = urgency === 'urgent' ? '2px solid #ef4444' : urgency === 'warning' ? '2px solid #f59e0b' : undefined
                    const cardBg     = urgency === 'urgent' ? '#fef2f2' : urgency === 'warning' ? '#fffbeb' : undefined
                    return (
                      <div key={deal.id} className={`deal-card${dragging === deal.id ? ' dragging' : ''}`}
                        style={{ border: cardBorder, background: cardBg }}
                        draggable
                        onDragStart={() => setDragging(deal.id)}
                        onDragEnd={() => { setDragging(null); setDragOver(null) }}
                        onClick={() => go(`deal/${deal.id}`)}
                      >
                        {urgency && nearestKD && (
                          <div style={{ display:'flex', alignItems:'center', gap:4, marginBottom:5, fontSize:10, fontWeight:700, color: urgency === 'urgent' ? '#dc2626' : '#d97706' }}>
                            <span style={{ fontSize:11 }}>⚠</span>
                            <span>{nearestKD.type}: {nearestKD.daysUntil === 0 ? 'Today' : nearestKD.daysUntil === 1 ? 'Tomorrow' : `${nearestKD.daysUntil} days`}</span>
                          </div>
                        )}
                        <div style={{ display:'flex', alignItems:'flex-start', gap:6 }}>
                          <span title={act.state === 'overdue' ? `Task overdue ${act.overdueBy}d` : act.state === 'scheduled' ? 'Next step scheduled' : 'No next step planned'}
                            style={{ width:8, height:8, borderRadius:'50%', flexShrink:0, marginTop:4,
                              background: act.color, boxShadow: act.state === 'none' ? 'inset 0 0 0 1px var(--gw-border)' : undefined }} />
                          <div className="deal-card__title" style={{ flex:1 }}>{deal.title}</div>
                        </div>
                        {isAdmin && agent && (
                          <div style={{ display:'flex', alignItems:'center', gap:4, marginBottom:2 }}>
                            <Avatar agent={agent} size={14} />
                            <span style={{ fontSize:10, color:'var(--gw-mist)' }}>{agent.name}</span>
                          </div>
                        )}
                        {contact && <div className="deal-card__contact">{contact.first_name} {contact.last_name}</div>}
                        {deal.value > 0 && (
                          <div className="deal-card__value">
                            {formatCurrency(deal.value)}
                            {deal.probability > 0 && deal.probability < 100 && (
                              <span style={{ fontSize:10, fontWeight:500, color:'var(--gw-mist)', marginLeft:6 }}>wtd {formatCurrency(wtd)}</span>
                            )}
                          </div>
                        )}
                        {rotting && (
                          <div style={{ display:'inline-flex', alignItems:'center', gap:3, marginTop:3, fontSize:10, fontWeight:700, color:'#b45309', background:'#fef3c7', padding:'1px 6px', borderRadius:6 }}>
                            ⚠ Idle {dis}d
                          </div>
                        )}
                        <div className="deal-card__meta">
                          <div style={{ fontSize:11, color: overdue ? 'var(--gw-red)' : 'var(--gw-mist)' }}>
                            {deal.expected_close_date ? formatDate(deal.expected_close_date) : ''}
                          </div>
                          <div style={{ display:'flex', alignItems:'center', gap:4 }}>
                            {deal.probability > 0 && <span style={{ fontSize:10, color:'var(--gw-mist)' }}>{deal.probability}%</span>}
                            <div style={{ display:'flex', alignItems:'center' }}>
                              {allAgents.slice(0, 3).map((a, i) => (
                                <div key={a.id} style={{ marginLeft: i > 0 ? -5 : 0, zIndex: 10 - i, position: 'relative' }}>
                                  <Avatar agent={a} size={20} />
                                </div>
                              ))}
                            </div>
                            <button className="btn btn--ghost btn--icon" style={{ padding:2 }} title="Delete deal" onClick={e=>{e.stopPropagation(); setConfirm(deal.id)}}><Icon name="trash" size={11} /></button>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                  {!isAdmin && (
                    <button className="btn btn--ghost" style={{ width:'100%', justifyContent:'center', fontSize:12, marginTop:'auto', borderStyle:'dashed', border:'1px dashed var(--gw-border)' }}
                      onClick={() => { setEditing(null); setDefaultStage(stage); setDrawer(true) }}>
                      <Icon name="plus" size={13} /> Add deal
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {/* ── LIST VIEW ── */}
      {pipelineTab === 'deals' && dealView === 'list' && (
        trackDeals.length === 0 ? (
          <EmptyState icon="pipeline" title={`No ${track.label.toLowerCase()} deals`} message="Add a deal to this track, or pick another track above." />
        ) : (
          <div style={{ flex:1, minHeight:0, overflow:'auto', border:'1px solid var(--gw-border)', borderRadius:'var(--radius-lg)', background:'#fff' }}>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
              <thead>
                <tr style={{ background:'var(--gw-bone)', textAlign:'left' }}>
                  {[['', ''],['title','Deal'],['stage','Stage'],['value','Value'],['weighted','Weighted'],['close','Close'],['keydate','Next Key Date'],['stale','In Stage'],['agents','Team']].map(([col, label]) => (
                    <th key={col || 'dot'} onClick={() => col && toggleSort(col)}
                      style={{ padding:'9px 12px', fontSize:11, fontWeight:700, color:'var(--gw-mist)', textTransform:'uppercase', letterSpacing:'0.05em',
                        cursor: col ? 'pointer' : 'default', whiteSpace:'nowrap', userSelect:'none', position:'sticky', top:0, background:'var(--gw-bone)' }}>
                      {label}{sortBy.col === col && col ? (sortBy.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {listRows.map(({ deal, contact, weighted, dis, rotting, activity, keyDate }) => {
                  const col = boardStageFor(deal, resolvedTrack)
                  const teamAgents = agentIdsOnDeal(deal, propertyMap[deal.property_id])
                    .map(id => agentMap[id]).filter(Boolean)
                  const kdColor = keyDate == null ? 'var(--gw-mist)' : keyDate.daysUntil <= 2 ? '#dc2626' : keyDate.daysUntil <= 7 ? '#d97706' : 'var(--gw-ink)'
                  return (
                    <tr key={deal.id} onClick={() => go(`deal/${deal.id}`)}
                      style={{ borderTop:'1px solid var(--gw-border)', cursor:'pointer' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--gw-bone)'}
                      onMouseLeave={e => e.currentTarget.style.background = ''}>
                      <td style={{ padding:'9px 12px' }}>
                        <span title={activity.state === 'overdue' ? `Overdue ${activity.overdueBy}d` : activity.state === 'scheduled' ? 'Next step scheduled' : 'No next step'}
                          style={{ display:'inline-block', width:8, height:8, borderRadius:'50%', background:activity.color, boxShadow: activity.state === 'none' ? 'inset 0 0 0 1px var(--gw-border)' : undefined }} />
                      </td>
                      <td style={{ padding:'9px 12px', maxWidth:260 }}>
                        <div style={{ fontWeight:600, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{deal.title}</div>
                        {contact && <div style={{ fontSize:11, color:'var(--gw-mist)' }}>{contact.first_name} {contact.last_name}</div>}
                      </td>
                      <td style={{ padding:'9px 12px', whiteSpace:'nowrap' }}><Badge variant={col === 'closed' ? 'closed' : col === 'lost' ? 'lost' : 'lead'}>{stageLabels[col]}</Badge></td>
                      <td style={{ padding:'9px 12px', whiteSpace:'nowrap', fontWeight:600 }}>{deal.value > 0 ? formatCurrency(deal.value) : '—'}</td>
                      <td style={{ padding:'9px 12px', whiteSpace:'nowrap', color:'var(--gw-mist)' }}>{deal.value > 0 ? formatCurrency(weighted) : '—'}</td>
                      <td style={{ padding:'9px 12px', whiteSpace:'nowrap' }}>{deal.expected_close_date ? formatDate(deal.expected_close_date) : '—'}</td>
                      <td style={{ padding:'9px 12px', whiteSpace:'nowrap', color:kdColor, fontWeight: keyDate && keyDate.daysUntil <= 7 ? 700 : 400 }}>
                        {keyDate ? `${keyDate.type} · ${keyDate.daysUntil === 0 ? 'today' : keyDate.daysUntil === 1 ? '1d' : `${keyDate.daysUntil}d`}` : '—'}
                      </td>
                      <td style={{ padding:'9px 12px', whiteSpace:'nowrap', color: rotting ? '#b45309' : 'var(--gw-mist)', fontWeight: rotting ? 700 : 400 }}>
                        {dis == null ? '—' : `${dis}d`}{rotting ? ' ⚠' : ''}
                      </td>
                      <td style={{ padding:'9px 12px' }}>
                        <div style={{ display:'flex' }}>
                          {teamAgents.slice(0, 3).map((a, i) => (
                            <div key={a.id} style={{ marginLeft: i > 0 ? -5 : 0, zIndex: 10 - i, position:'relative' }}><Avatar agent={a} size={20} /></div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )
      )}

      {/* ── FOCUS VIEW ── */}
      {pipelineTab === 'deals' && dealView === 'focus' && (
        focus.length === 0 ? (
          <EmptyState icon="check" title="You're all clear" message="No overdue tasks, looming deadlines, or stalled deals across your pipeline. Nice." />
        ) : (
          <div style={{ flex:1, minHeight:0, overflow:'auto', display:'flex', flexDirection:'column', gap:8, maxWidth:760, paddingRight:4 }}>
            {focus.map((item, i) => {
              const dot = item.severity === 'critical' ? '#dc2626' : '#d97706'
              const icon = item.kind === 'task' ? '⏰' : item.kind === 'date' ? '📅' : '⚠'
              return (
                <div key={`${item.deal.id}-${item.kind}-${i}`} onClick={() => go(`deal/${item.deal.id}`)}
                  className="card" style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 16px', cursor:'pointer', borderLeft:`3px solid ${dot}` }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--gw-bone)'}
                  onMouseLeave={e => e.currentTarget.style.background = ''}>
                  <span style={{ fontSize:18 }}>{icon}</span>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontWeight:600, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{item.deal.title}</div>
                    <div style={{ fontSize:12, color: item.severity === 'critical' ? '#dc2626' : '#b45309', fontWeight:600 }}>
                      {item.label}{item.detail ? <span style={{ color:'var(--gw-mist)', fontWeight:400 }}> — {item.detail}</span> : ''}
                    </div>
                  </div>
                  <Badge variant={item.deal.prop_category === 'commercial' ? 'commercial' : 'residential'}>
                    {stageLabels[item.deal.stage] || item.deal.stage}
                  </Badge>
                </div>
              )
            })}
          </div>
        )
      )}

      {pipelineTab === 'listings' && (
        visibleListings.length === 0 ? (
          <EmptyState icon="properties" title="No listings yet" message="Add properties in the Properties page and they'll appear here grouped by status." />
        ) : (
          <div className="kanban-board">
            {LISTING_STATUS_ORDER.map(status => (
              <div key={status} className="kanban-col">
                <div className="kanban-col__head">
                  <div>
                    <div className="kanban-col__label" style={{ display:'flex', alignItems:'center', gap:6 }}>
                      <span style={{ width:8, height:8, borderRadius:'50%', background: LISTING_STATUS_COLORS[status], flexShrink:0, display:'inline-block' }} />
                      {LISTING_STATUS_LABELS[status]}
                    </div>
                    {listingTotals[status] > 0 && (
                      <div style={{ fontSize:10, color:'var(--gw-mist)', marginTop:1 }}>{formatCurrency(listingTotals[status])}</div>
                    )}
                  </div>
                  <span className="kanban-col__count">{listingGroups[status].length}</span>
                </div>
                <div
                  className={`kanban-col__body${dragOverStatus === status ? ' drag-over' : ''}`}
                  onDragOver={e => { e.preventDefault(); setDragOverStatus(status) }}
                  onDragLeave={() => setDragOverStatus(null)}
                  onDrop={e => { e.preventDefault(); if (dragListing) moveListingStatus(dragListing, status); setDragOverStatus(null); setDragListing(null) }}
                >
                  {listingGroups[status].length === 0 ? (
                    <div style={{ fontSize:12, color:'var(--gw-border)', textAlign:'center', padding:'20px 0', fontStyle:'italic' }}>Drop a listing here</div>
                  ) : (
                    listingGroups[status].map(property => (
                      <ListingCard
                        key={property.id}
                        property={property}
                        agent={agentMap[property.assigned_agent_id]}
                        deals={deals}
                        onClick={() => openListing(property)}
                        onDelete={() => setConfirmProp(property.id)}
                        draggable
                        dragging={dragListing === property.id}
                        onDragStart={() => setDragListing(property.id)}
                        onDragEnd={() => { setDragListing(null); setDragOverStatus(null) }}
                      />
                    ))
                  )}
                </div>
              </div>
            ))}
          </div>
        )
      )}

      <DealDrawer open={drawer} onClose={() => setDrawer(false)}
        deal={editing ? editing : { stage: defaultStage }}
        agents={agents} contacts={contacts} properties={properties} deals={deals} dealContacts={dealContacts} propertyContacts={db.propertyContacts || []} activeAgent={activeAgent} onSave={reload} onCreated={id => go?.(`deal/${id}`)} setDb={setDb} />
      {confirm && <ConfirmDialog message="This will permanently delete this deal." onConfirm={() => del(confirm)} onCancel={() => setConfirm(null)} />}
      {confirmProp && <ConfirmDialog message="Remove this listing from the pipeline? Any linked deals are kept but will be unlinked from the property." onConfirm={() => delProperty(confirmProp)} onCancel={() => setConfirmProp(null)} />}
    </div>
  )
}
