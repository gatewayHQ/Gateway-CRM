// ─────────────────────────────────────────────────────────────────────────────
// Deal key dates → Outlook calendar sync — shared logic.
//
// Called from two places (both server-only, service-key client):
//   • api/cron.js          ?task=calendar-sync   — nightly sweep, all deals
//   • api/email-send.js    ?action=outlook-calendar-sync — on-demand, one deal,
//     fired right after an agent edits a key date (src/pages/Pipeline.jsx)
//
// Both need IDENTICAL diffing/create/update/delete logic, so it lives here
// once rather than being duplicated per entry point (migrations/README's
// "single source of truth" convention, applied to code instead of schema).
//
// Sync model: an open deal's comp_data.key_dates (each {type, date}) should
// map 1:1 to a row in deal_calendar_events + a Graph event on the ASSIGNED
// AGENT's own calendar. A closed/lost deal has no key dates to sync — any
// events already created for it get deleted (see resolveKeyDates below), so a
// dead deal doesn't leave stale reminders on someone's calendar forever.
// ─────────────────────────────────────────────────────────────────────────────
import crypto from 'node:crypto'
import { getValidAccessToken, createCalendarEvent, updateCalendarEvent, deleteCalendarEvent } from './msGraph.js'
import { isOpenStage } from '../../src/lib/stages.js'

function eventHash(entry, dealTitle, propertyAddress) {
  return crypto.createHash('sha256')
    .update(JSON.stringify([entry.type, entry.date, dealTitle, propertyAddress || '']))
    .digest('hex')
    .slice(0, 16)
}

// A closed/lost deal has nothing to sync — its key dates are treated as empty
// so the diff below deletes every event already created for it.
function resolveKeyDates(deal) {
  if (!isOpenStage(deal.stage)) return []
  return (deal.comp_data?.key_dates || []).filter(e => e?.date && e?.type)
}

// Sync one deal's key dates to its assigned agent's Outlook calendar.
// Returns { skipped: true, reason } if the agent isn't connected, otherwise
// { created, updated, deleted, errors }.
export async function syncDealCalendar(svc, deal, { property } = {}) {
  const { data: conn } = await svc.from('ms_graph_connections')
    .select('agent_id, status').eq('agent_id', deal.agent_id).maybeSingle()
  if (!conn || conn.status !== 'connected') {
    return { skipped: true, reason: 'Outlook not connected for this deal\'s agent' }
  }

  const { data: existingRows } = await svc.from('deal_calendar_events')
    .select('*').eq('deal_id', deal.id).eq('agent_id', deal.agent_id)
  const existingByType = Object.fromEntries((existingRows || []).map(r => [r.date_type, r]))

  let accessToken
  try {
    ;({ accessToken } = await getValidAccessToken(svc, deal.agent_id))
  } catch (err) {
    return { skipped: true, reason: err.message }
  }

  const propertyAddress = property?.address || null
  const keyDates = resolveKeyDates(deal)
  const seenTypes = new Set()
  const result = { created: 0, updated: 0, deleted: 0, errors: [] }

  for (const entry of keyDates) {
    seenTypes.add(entry.type)
    const hash = eventHash(entry, deal.title, propertyAddress)
    const existing = existingByType[entry.type]
    if (existing && existing.event_hash === hash) continue   // unchanged — skip the write entirely

    const subject  = `${entry.type} — ${deal.title}`
    const bodyHtml = `Gateway CRM deal: <b>${deal.title}</b>${propertyAddress ? `<br>${propertyAddress}` : ''}`

    try {
      if (existing) {
        await updateCalendarEvent(accessToken, existing.graph_event_id, { subject, date: entry.date, bodyHtml })
        await svc.from('deal_calendar_events')
          .update({ event_hash: hash, last_synced_at: new Date().toISOString() })
          .eq('id', existing.id)
        result.updated++
      } else {
        const created = await createCalendarEvent(accessToken, { subject, date: entry.date, bodyHtml })
        await svc.from('deal_calendar_events').insert([{
          deal_id: deal.id, agent_id: deal.agent_id, date_type: entry.type,
          graph_event_id: created.id, event_hash: hash,
        }])
        result.created++
      }
    } catch (err) {
      result.errors.push({ type: entry.type, error: err.message })
    }
  }

  // Key dates removed from the deal (or the deal closed) — delete the events
  // that no longer have a matching entry.
  for (const row of existingRows || []) {
    if (seenTypes.has(row.date_type)) continue
    try {
      await deleteCalendarEvent(accessToken, row.graph_event_id)
    } catch (err) {
      if (err.status !== 404) result.errors.push({ type: row.date_type, error: err.message })
    }
    await svc.from('deal_calendar_events').delete().eq('id', row.id)
    result.deleted++
  }

  return result
}

// Nightly safety net: every deal whose assigned agent has Outlook connected.
// Catches drift the on-demand path can't (a manually deleted calendar event,
// a deal that closed since its last key-date edit, a sync that failed
// mid-request). Bounded like the other cron tasks — see the 200-deal caps
// elsewhere in api/cron.js — so one run can't run away on a very large book.
export async function syncAllDealCalendars(svc) {
  const { data: connections } = await svc.from('ms_graph_connections')
    .select('agent_id').eq('status', 'connected')
  const connectedAgentIds = (connections || []).map(c => c.agent_id)
  if (!connectedAgentIds.length) {
    return { ok: true, message: 'No agents have Outlook connected', synced: 0, total: 0 }
  }

  const { data: deals } = await svc.from('deals')
    .select('id, title, agent_id, stage, comp_data, property_id')
    .in('agent_id', connectedAgentIds)
    .limit(500)

  // Only deals that either have key dates now, or might still have stale
  // events from key dates that were since removed/closed — i.e. anything with
  // a comp_data.key_dates array at all, open or not.
  const candidates = (deals || []).filter(d => Array.isArray(d.comp_data?.key_dates) && d.comp_data.key_dates.length > 0)
  if (!candidates.length) {
    return { ok: true, message: 'No deals with key dates', synced: 0, total: 0 }
  }

  const propertyIds = [...new Set(candidates.map(d => d.property_id).filter(Boolean))]
  const { data: properties } = propertyIds.length
    ? await svc.from('properties').select('id, address').in('id', propertyIds)
    : { data: [] }
  const propertyMap = Object.fromEntries((properties || []).map(p => [p.id, p]))

  let synced = 0
  const errors = []
  for (const deal of candidates) {
    const result = await syncDealCalendar(svc, deal, { property: propertyMap[deal.property_id] })
    if (!result.skipped) synced++
    if (result.errors?.length) errors.push({ deal: deal.title, errors: result.errors })
  }

  return { ok: true, synced, total: candidates.length, errors }
}
