// Deal drawer → Signatures tab: every BoldSign packet on the deal, grouped by
// what it is waiting on, with the actions each one allows.

import React from 'react'
import {
  fetchDealBoldsignDocuments, updateBoldsignDocument, subscribeToDealBoldsignDocuments, fetchDealFieldLayouts, fetchPacketTimeline,
} from '../../../lib/services/boldsignDocuments.js'
import { listDealFolder } from '../../../lib/services/documents.js'
import { fetchDealCommissionParticipants } from '../../../lib/services/commissions.js'
import { propertyLabel } from '../../../lib/address.js'
import {
  packetEditUrl, packetAddInitials, packetCloneUrl, packetSync, packetChangeSigner, revokeDocument as apiRevokeDocument, packetState, canFixPacket, fixPacketBlockedReason, canSendCorrection, canRevoke, canChangeSigner, isInFlight, isEditPending, editPendingMs, documentEditUrl, fileDocumentToDeal, getDocStatus, downloadSigned as apiDownloadSigned, downloadAudit as apiDownloadAudit, deleteDocument as apiDeleteDocument, remindDocument as apiRemindDocument, sendDraft as apiSendDraft, signerRows, outstandingSigners, waitingOnLabel, describeSignerState, signerProgress, dealAgentList,
} from '../../../lib/services/boldsign.js'
import { buildCandidates } from '../../../components/SignerPicker.jsx'
import { openPrintTab, closePrintTab } from '../../../lib/savePdf.js'
import { Icon, ConfirmDialog, MenuButton, pushToast } from '../../../components/UI.jsx'
import { groupPackets, summaryLine, nextStep, showsStatusChip, daysOut as packetDaysOut, OVERDUE_DAYS } from '../../../lib/services/signaturesView.js'
import MlsPackModal from '../../../components/MlsPackModal.jsx'
import ComposePacketModal from '../../../components/ComposePacketModal.jsx'
import { boldSignReturnUrl, printBoldSignDocument, saveBoldSignDocumentPdf } from './boldsignDocs.js'
import { SignaturesGettingStarted } from './SignaturesGettingStarted.jsx'
import { SendSignatureModal } from './SendSignatureModal.jsx'
import { BoldSignStepModal } from './BoldSignStepModal.jsx'
import { SendFromTemplateModal } from './SendFromTemplateModal.jsx'
import { AcknowledgementDialog, ChangeSignerDialog } from './SignatureDialogs.jsx'
import { fetchSendableFormPackets } from '../../../lib/services/formPackets.js'

// The colour a group's rail and dot are drawn in. One tone per group, so the
// left edge of a row says which group it is in even after the header scrolls
// off — and so the status is carried by position and colour instead of being
// spelled out three times per card.
const GROUP_TONE = {
  amber: 'var(--gw-amber)',
  azure: 'var(--gw-azure)',
  mist:  'var(--gw-border)',
  green: 'var(--gw-green)',
}

const DS_STATUS = {
  draft:     { bg: '#fff3cd', color: '#856404' },
  sent:      { bg: '#e8f4fd', color: 'var(--gw-azure)' },
  delivered: { bg: '#fff3cd', color: '#856404' },
  // Red, not amber. BoldSign raises this when a recipient cannot get in at all —
  // a bounced address, a failed authentication — and the packet will sit there
  // forever until somebody fixes the recipient. It looks like "waiting" and is
  // not, so it must not wear the colour of one.
  needs_attention: { bg: 'var(--gw-red-light)', color: 'var(--gw-red)' },
  completed: { bg: 'var(--gw-green-light)', color: 'var(--gw-green)' },
  declined:  { bg: 'var(--gw-red-light)',   color: 'var(--gw-red)' },
  expired:   { bg: 'var(--gw-bone)',         color: 'var(--gw-mist)' },
  voided:    { bg: 'var(--gw-bone)',         color: 'var(--gw-mist)' },
}

export function SignaturesTab({ deal, contacts, properties, extraContacts = [], sideClients = null, agents = [], activeAgent }) {
  const [envelopes,   setEnvelopes]   = React.useState([])
  const [loading,     setLoading]     = React.useState(true)
  const [tableReady,  setTableReady]  = React.useState(true)
  const [sendOpen,    setSendOpen]    = React.useState(false)
  const [tplOpen,     setTplOpen]     = React.useState(false)
  const [templates,   setTemplates]   = React.useState([])
  const [dealFiles,   setDealFiles]   = React.useState([])
  const [downloading, setDownloading] = React.useState({})
  const [deleting,    setDeleting]    = React.useState({})
  const [reminding,   setReminding]   = React.useState({})
  const [templateErr, setTemplateErr] = React.useState('')   // set when the catalog can't be read (e.g. migration not applied)
  const [participantIds, setParticipantIds] = React.useState([])   // co-agents paid on the deal (admin-visible only)
  // WHICH GROUPS ARE OPEN, and which rows have been asked for. Both are view
  // state and neither is persisted: an agent who opens Signed to find one
  // document should get the tab back the way it starts next time they visit,
  // with what needs them at the top and the finished work put away.
  const [groupOpen,    setGroupOpen]    = React.useState({})   // group id → open?, absent = the group's own default
  const [expandedRows, setExpandedRows] = React.useState({})   // envelope id → showing its detail?
  const [layoutsOpen,  setLayoutsOpen]  = React.useState(false)  // the remembered-layout footnote
  const [opening,     setOpening]     = React.useState({})    // env.id → fetching its edit URL
  const [editDraft,   setEditDraft]   = React.useState(null)  // { url, env } — draft reopened in BoldSign
  const [layouts,     setLayouts]     = React.useState([])    // saved per-deal field arrangements
  const [savingPdf,   setSavingPdf]   = React.useState({})    // env.id → building its PDF copy
  const [printingPdf, setPrintingPdf] = React.useState({})    // env.id → opening its printable copy
  const [filing,      setFiling]      = React.useState({})    // env.id → filing a copy onto the deal
  const [sendingDraft, setSendingDraft] = React.useState({})  // env.id → draftSend in flight
  const [sendAsk,     setSendAsk]     = React.useState(null)  // env awaiting "yes, send it" confirmation
  // ── Signature packets ──────────────────────────────────────────────────────
  const [composeOpen, setComposeOpen] = React.useState(false) // several forms, one screen
  const [mlsOpen,     setMlsOpen]     = React.useState(false) // Pack for MLS
  const [fixing,      setFixing]      = React.useState({})    // env.id → fetching its Fix packet URL
  const [fixFrame,    setFixFrame]    = React.useState(null)  // { url, env } — packet reopened in BoldSign
  const [correcting,  setCorrecting]  = React.useState({})    // env.id → minting its clone URL
  const [cloneFrame,  setCloneFrame]  = React.useState(null)  // { url, env } — the correction being prepared
  const [correctAsk,  setCorrectAsk]  = React.useState(null)  // env awaiting the correction explainer
  const [revokeAsk,   setRevokeAsk]   = React.useState(null)  // env awaiting "yes, recall it"
  const [revoking,    setRevoking]    = React.useState({})    // env.id → revoke in flight
  const [ackFor,      setAckFor]      = React.useState(null)  // env whose acknowledgement is being placed
  const [signerSwap,  setSignerSwap]  = React.useState(null)  // { env, signer } being replaced
  const [swapping,    setSwapping]    = React.useState(false)
  const [timelineFor, setTimelineFor] = React.useState(null)  // env.id whose timeline is expanded
  const [timeline,    setTimeline]    = React.useState({})    // env.id → rows

  React.useEffect(() => {
    if (!deal?.id) return
    loadEnvelopes()
    loadDealFiles()
    loadTemplates()
    loadParticipants()
    loadLayouts()

    // Realtime subscription — auto-update status when webhook fires
    return subscribeToDealBoldsignDocuments(deal.id, payload => {
      if (payload.eventType === 'DELETE') {
        setEnvelopes(prev => prev.filter(e => e.id !== payload.old?.id))
        return
      }
      // INSERT as well as UPDATE: every send path writes its row server-side
      // before handing back a send URL, so a document that went out from
      // another tab (or from BoldSign itself) used to be invisible here until
      // the agent reloaded the deal.
      setEnvelopes(prev => (prev.some(e => e.id === payload.new.id)
        ? prev.map(e => e.id === payload.new.id ? { ...e, ...payload.new } : e)
        : [payload.new, ...prev]))
      if (payload.new.status === 'completed' && payload.old?.status !== 'completed') {
        loadDealFiles() // signed copy should now be in storage
        pushToast('Document fully signed — signed copy saved to Documents tab', 'success')
      }
    })
  }, [deal?.id])

  const loadEnvelopes = async () => {
    setLoading(true)
    const { data, error } = await fetchDealBoldsignDocuments(deal.id)
    if (error?.code === '42P01') { setTableReady(false); setLoading(false); return }
    setEnvelopes(data || [])
    setLoading(false)
  }

  const loadTemplates = async () => {
    // Form Library is the e-sign template catalog — an entry is sendable once
    // it carries a boldsign_template_id. Alias to `template_id` so the rest of
    // this component (written against the old boldsign_templates shape) needs
    // no other changes.
    //
    // The error is BOUND and SURFACED. It used to be discarded, which meant that
    // on a database where the e-sign columns hadn't been added yet the query
    // failed, `templates` stayed empty, and the "Send from Template" button
    // simply never rendered — the entire feature looked unbuilt rather than
    // unprovisioned, with nothing anywhere saying why.
    // `transaction_type` and `signing_panel` ride along because they decide
    // which sender decisions the send screen asks for — see resolvePanel().
    // `signing_panel` is migration 0043, so it is asked for OPTIMISTICALLY and
    // dropped on a database that doesn't have it yet: a missing column fails the
    // whole query, and letting that empty the catalog would make the entire
    // template feature look unbuilt over one additive column. Without it every
    // packet falls back to the built-in self-validating panel, which is exactly
    // the behavior that shipped before 0043.
    const BASE_COLUMNS = 'template_id:boldsign_template_id, name, state, transaction_type, doc_type, field_tokens, active'

    let { data, error } = await fetchSendableFormPackets(`${BASE_COLUMNS}, signing_panel`)
    if (error && (error.code === '42703' || error.code === 'PGRST204' || /signing_panel/.test(error.message || ''))) {
      console.warn('[boldsign] form_packets.signing_panel is missing — falling back to built-in packet panels; apply migrations/0043_form_packet_signing_panel.sql')
      ;({ data, error } = await fetchSendableFormPackets(BASE_COLUMNS))
    }
    if (error) {
      const missingColumn = error.code === '42703' || error.code === 'PGRST204' || /boldsign_template_id|form_packets/.test(error.message || '')
      setTemplateErr(missingColumn
        ? 'Template sending is not set up on this database yet — the Form Library e-signature columns are missing. Ask your admin to run migrations/production/2026-07-31_boldsign_hardening.sql in Supabase.'
        : `Could not load templates: ${error.message}`)
      setTemplates([])
      return
    }
    setTemplateErr('')
    setTemplates(data || [])
  }

  // The field arrangements remembered for this deal, one per template. Read
  // directly (RLS-scoped) rather than through the API — it's a plain per-deal read
  // and the agent already has permission to see their own deal's rows.
  //
  // Errors are swallowed on purpose: on a database where migration 0026 hasn't been
  // applied this table doesn't exist, and the whole feature should degrade to "no
  // saved layouts" rather than break the Signatures tab.
  const loadLayouts = async () => {
    const { data, error } = await fetchDealFieldLayouts(deal.id)
    if (error) { setLayouts([]); return }
    setLayouts((data || []).filter(l => l.field_count > 0))
  }

  const loadDealFiles = async () => {
    const { data } = await listDealFolder(deal.id)
    // Same folder filter as the Documents tab — a `print/` entry is not a sendable
    // document and must not appear in the "pick from deal documents" list.
    setDealFiles((data || []).filter(f => f.name !== '.emptyFolderPlaceholder' && f.id))
  }

  // Co-agents who are paid participants on the deal. Commissions are admin-only
  // under RLS, so this quietly yields nothing for a regular agent — who then
  // sees owner + co_agent_ids, exactly what the deal page shows them.
  const loadParticipants = async () => {
    const { data } = await fetchDealCommissionParticipants(deal.id)
    const ids = (Array.isArray(data?.participants) ? data.participants : [])
      .map(p => p?.agent_id).filter(Boolean)
    setParticipantIds(ids)
  }

  // The agents on this deal, ordered exactly like the "Agents on deal" card:
  // primary first, then co-agents. Used to seed agent signer roles so a
  // co-listing agent doesn't have to be typed in on every send.
  const dealAgents = React.useMemo(
    () => dealAgentList({ deal, agents, participantAgentIds: participantIds }),
    [deal, agents, participantIds]
  )

  const refreshStatus = async (env) => {
    let data
    try { data = await getDocStatus(env.document_id) }
    catch (err) { pushToast(err.message, 'error'); return }
    // A status BoldSign reports but this app does not store comes back as null.
    // Show it, never write it: an unknown string in this column takes the
    // document out of the portal, the reminder sweep and the closing gate, all
    // of which filter on the known set.
    if (!data.status) {
      pushToast(`BoldSign reports "${data.rawStatus || 'an unrecognized status'}" — left unchanged here.`, 'info')
      return
    }
    // Only write completed_at when there IS one — assigning `|| null`
    // unconditionally wiped a known signing date whenever a status read came
    // back without it, losing the "Signed on …" record permanently.
    const patch = { status: data.status }
    if (data.completedDateTime) patch.completed_at = data.completedDateTime
    // Per-signer state comes back with every status read, and this is the one
    // moment an agent has explicitly asked "where is this?" — so it is stored,
    // not just shown. A document sent before per-signer state existed gets its
    // recipient list filled in the first time anyone refreshes it.
    if (Array.isArray(data.signers) && data.signers.length) patch.signers = data.signers
    await updateBoldsignDocument(env.id, patch)
    setEnvelopes(prev => prev.map(e => e.id === env.id ? { ...e, ...patch } : e))
    const rows = signerRows({ ...env, ...patch })
    const left = outstandingSigners(rows).length
    pushToast(left ? `${waitingOnLabel(rows)} · ${data.status}` : `Status: ${data.status}`, 'info')
  }

  // Fetch the signed PDF (or audit trail) for THIS document.
  //
  // Two bugs lived in the old version of this. It matched files by scanning the
  // deal's whole storage folder for a name containing "signed-", and since the
  // archived filename never contained the document id, the id-specific predicate
  // could never match — so on a deal with several signed documents every row
  // handed back the SAME (first) PDF. And the fallback returned the file as
  // base64 through the API, which a 4.5 MB response cap made impossible for a
  // large packet.
  //
  // Now the API resolves the row's own recorded archive path and returns a
  // short-lived signed storage URL, archiving from BoldSign first if needed.
  const fetchDocumentPdf = async (env, kind) => {
    const key = kind === 'audit' ? `audit-${env.id}` : env.id
    setDownloading(p => ({ ...p, [key]: true }))
    try {
      const data = kind === 'audit'
        ? await apiDownloadAudit(env.document_id)
        : await apiDownloadSigned(env.document_id)
      if (!data?.url) { pushToast('That file is not available yet — try again shortly.', 'error'); return }
      const a = document.createElement('a')
      a.href = data.url
      a.download = data.filename || `${kind}-${(env.document_name || 'document').replace(/\.pdf$/i, '')}.pdf`
      a.target = '_blank'
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      a.remove()
    } catch (err) {
      pushToast(err.message, 'error')
    } finally {
      setDownloading(p => ({ ...p, [key]: false }))
    }
  }
  const downloadSigned     = (env) => fetchDocumentPdf(env, 'signed')
  const downloadAuditTrail = (env) => fetchDocumentPdf(env, 'audit')

  // Nudge whoever still owes a signature. The API refuses when there's nobody
  // left to remind and records the nudge, so the nightly auto-reminder sweep
  // doesn't immediately chase the same signer again.
  // `only` names one signer; without it the API reminds whoever the row still
  // shows as outstanding — which, on a sequential send, is not everybody.
  const remind = async (env, only = null) => {
    const key = only ? `${env.id}:${only.email}` : env.id
    setReminding(p => ({ ...p, [key]: true }))
    try {
      const res = await apiRemindDocument(env.document_id, only ? [only.email] : null)
      const patch = { last_reminded_at: new Date().toISOString(), reminder_count: (env.reminder_count || 0) + 1 }
      setEnvelopes(prev => prev.map(e => e.id === env.id ? { ...e, ...patch } : e))
      const who = only
        ? (only.name || only.email)
        : (res?.remindedEmails?.length ? `${res.remindedEmails.length} outstanding signer${res.remindedEmails.length === 1 ? '' : 's'}` : 'the signers')
      pushToast(`Reminder sent to ${who}`, 'success')
    } catch (err) {
      pushToast(err.message, 'error')
    } finally {
      setReminding(p => ({ ...p, [key]: false }))
    }
  }

  // Reopen an unsent draft in BoldSign, at the point the agent left it — same
  // signers, same field placement. This is the way out of the trap where an agent
  // switched screens mid-prep: the document became a draft they could see and
  // could not touch, so finishing a started send meant deleting it and redoing the
  // whole thing.
  //
  // A failure here usually means the document is no longer a draft (a missed Sent
  // webhook left the row stale). The API corrects the row when it detects that, so
  // reload afterwards — the agent sees the real status instead of an Edit button
  // that keeps failing.
  const openDraft = async (env) => {
    setOpening(p => ({ ...p, [env.id]: true }))
    try {
      const data = await documentEditUrl({ documentId: env.document_id, redirectUrl: boldSignReturnUrl() })
      if (!data?.url) { pushToast('This draft could not be reopened right now. Try again in a moment — nothing has been sent.', 'error'); return }
      setEditDraft({ url: data.url, env })
    } catch (err) {
      pushToast(err.message, 'error')
      loadEnvelopes()
    } finally {
      setOpening(p => ({ ...p, [env.id]: false }))
    }
  }

  // Save a filled copy from the row — reachable without opening the editor, which
  // matters for the common case: an agent who wants the packet as a file before
  // deciding whether it is ready to go out at all.
  const savePdf = async (env) => {
    setSavingPdf(p => ({ ...p, [env.id]: true }))
    try {
      const res = await saveBoldSignDocumentPdf(env.document_id)
      pushToast(res.fieldCount
        ? `PDF saved — ${res.fieldCount} field${res.fieldCount === 1 ? '' : 's'} included.`
        : 'PDF saved.', 'success')
    } catch (err) {
      pushToast(`Could not save the PDF: ${err.message}`, 'error')
    } finally {
      setSavingPdf(p => ({ ...p, [env.id]: false }))
    }
  }

  // Print a filled copy from the row. The tab is opened before the await for the
  // same reason it is in the editor — see openPrintTab in src/lib/savePdf.js.
  const printPdf = async (env) => {
    const tab = openPrintTab()
    setPrintingPdf(p => ({ ...p, [env.id]: true }))
    try {
      await printBoldSignDocument(env.document_id, tab)
    } catch (err) {
      closePrintTab(tab)
      pushToast(`Could not open a printable copy \u2014 ${err.message}.`, 'error')
    } finally {
      setPrintingPdf(p => ({ ...p, [env.id]: false }))
    }
  }

  // File a copy onto the deal from the row. Available at every status, not just
  // draft: filing the version that actually went out — or the one that came back
  // signed — is the point of a filing cabinet, and a signed document filed here
  // sits beside the rest of the deal's paperwork instead of only inside BoldSign.
  const fileToDeal = async (env) => {
    setFiling(p => ({ ...p, [env.id]: true }))
    try {
      const res = await fileDocumentToDeal(env.document_id)
      pushToast(res.fieldCount
        ? `Filed on this deal — ${res.fieldCount} field${res.fieldCount === 1 ? '' : 's'} included. Find it in the Documents tab.`
        : 'Filed on this deal — find it in the Documents tab.', 'success')
    } catch (err) {
      pushToast(`Could not file it on the deal: ${err.message}`, 'error')
    } finally {
      setFiling(p => ({ ...p, [env.id]: false }))
    }
  }

  // Release a prepared draft to its signers — BoldSign's draftSend. The last step
  // of prepare-and-print, and the ONLY button on this page that puts a document in
  // front of a client.
  //
  // Behind a confirm on purpose. Every other draft action is reversible; this one
  // emails a binding agreement, and the whole point of the draft workflow is that
  // an agent can prepare, print and review without that ever happening by
  // accident. `sendAsk` holds the row being confirmed.
  // The dialog stays up, busy, until BoldSign answers — closing it first would
  // leave the agent looking at a row that hasn't changed yet, with no way to tell
  // whether the send is in flight or silently failed.
  const sendDraftNow = async (env) => {
    setSendingDraft(p => ({ ...p, [env.id]: true }))
    try {
      await apiSendDraft(env.document_id)
      pushToast('Sent for signature — the signers have been notified.', 'success')
    } catch (err) {
      // The API refuses (409) when BoldSign says the document already went out,
      // and corrects the row when it does — so reload either way rather than
      // leaving a Send button that keeps failing.
      pushToast(err.message, 'error')
    } finally {
      setSendingDraft(p => ({ ...p, [env.id]: false }))
      setSendAsk(null)
      loadEnvelopes()
      loadLayouts()
    }
  }

  // ── Signature packets ──────────────────────────────────────────────────────

  // FIX PACKET — reopen a packet that is out for signature (or still a draft) in
  // BoldSign's editor.
  //
  // The button only renders when canFixPacket() says so, but the API is asked
  // again anyway: the CRM's row can be a missed webhook behind the truth, and a
  // packet the client finished signing two minutes ago must not be reopened just
  // because this tab has not heard yet. A refusal corrects the row, so reload.
  const fixPacket = async (env) => {
    setFixing(p => ({ ...p, [env.id]: true }))
    try {
      const data = await packetEditUrl({ documentId: env.document_id, redirectUrl: boldSignReturnUrl() })
      if (!data?.url) { pushToast('This packet could not be reopened right now. Try again in a moment — nothing has been sent.', 'error'); return }
      setFixFrame({ url: data.url, env })
    } catch (err) {
      pushToast(err.message, 'error')
      loadEnvelopes()
    } finally {
      setFixing(p => ({ ...p, [env.id]: false }))
    }
  }

  // ADD ACKNOWLEDGEMENT + INITIALS — the correction that does not need the
  // designer. One call: a label saying a change was made and a required Initial
  // beside it, for whoever has not finished signing.
  const addAcknowledgement = async (env, pageNumber) => {
    setFixing(p => ({ ...p, [env.id]: true }))
    try {
      const res = await packetAddInitials({ documentId: env.document_id, pageNumber })
      pushToast(
        res.queued
          ? `Acknowledgement added for ${res.signer?.name || res.signer?.email || 'the outstanding signer'}. BoldSign is still applying it — the packet will be ready in a moment.`
          : `Acknowledgement and initials added for ${res.signer?.name || res.signer?.email || 'the outstanding signer'}.`,
        res.queued ? 'info' : 'success',
      )
      if (res.warning) pushToast(res.warning, 'info')
      setAckFor(null)
      loadEnvelopes()
    } catch (err) {
      pushToast(err.message, 'error')
      loadEnvelopes()
    } finally {
      setFixing(p => ({ ...p, [env.id]: false }))
    }
  }

  // SEND CORRECTION PACKET — the only thing that can be done to a signed packet.
  // A clone, prefilled with everything already agreed; the original signed PDF is
  // untouched and stays on the deal, because that is the file MLS receives.
  const startCorrection = async (env) => {
    setCorrecting(p => ({ ...p, [env.id]: true }))
    try {
      const data = await packetCloneUrl({ documentId: env.document_id, redirectUrl: boldSignReturnUrl() })
      if (!data?.url) { pushToast('BoldSign did not return a screen for the correction packet. Try again in a moment.', 'error'); return }
      setCorrectAsk(null)
      setCloneFrame({ url: data.url, env })
    } catch (err) {
      pushToast(err.message, 'error')
      loadEnvelopes()
    } finally {
      setCorrecting(p => ({ ...p, [env.id]: false }))
    }
  }

  // RECALL — pull a packet back from its signers. Keeps the row and its
  // timeline: a recall is a thing that happened on the deal, and the correction
  // that follows should read as a sequence rather than appearing from nowhere.
  const revokePacket = async (env) => {
    setRevoking(p => ({ ...p, [env.id]: true }))
    try {
      await apiRevokeDocument(env.document_id)
      pushToast('Packet recalled — the signers can no longer open it.', 'info')
    } catch (err) {
      pushToast(err.message, 'error')
    } finally {
      setRevoking(p => ({ ...p, [env.id]: false }))
      setRevokeAsk(null)
      loadEnvelopes()
    }
  }

  // Replace a recipient who has not signed. The API re-checks against BoldSign's
  // own properties before it writes — this tab's row can be a missed webhook
  // behind, and swapping out someone who signed in the last two minutes is the
  // one thing this must never do.
  const changeSigner = async ({ env, signer }, next) => {
    setSwapping(true)
    try {
      const res = await packetChangeSigner({
        documentId: env.document_id, signerId: signer.id, name: next.name, email: next.email,
      })
      pushToast(`${res.replaced?.name || res.replaced?.email || 'That signer'} replaced with ${next.name}.`, 'success')
      setSignerSwap(null)
    } catch (err) {
      pushToast(err.message, 'error')
    } finally {
      setSwapping(false)
      loadEnvelopes()
    }
  }

  // Ask BoldSign what this packet actually is and write it down — the file list,
  // the download option, and whether a queued file edit has settled. Distinct
  // from Refresh status, which only reads the lifecycle.
  const syncPacket = async (env) => {
    try {
      const res = await packetSync(env.document_id)
      loadEnvelopes()
      pushToast(
        res.queued
          ? 'BoldSign is still applying a file change to this packet.'
          : `Up to date — ${res.status}${res.files?.length ? ` · ${res.files.length} file${res.files.length === 1 ? '' : 's'}` : ''}.`,
        res.queued ? 'info' : 'info',
      )
    } catch (err) {
      pushToast(err.message, 'error')
    }
  }

  // The packet's own history, read straight from the timeline table (RLS-scoped,
  // like the layouts read above). Loaded on demand: most rows are never expanded
  // and a deal can carry a lot of events.
  //
  // Errors are swallowed for the same reason loadLayouts swallows its own: on a
  // database without migration 0046 the table does not exist, and a signing tab
  // that breaks over a missing timeline is worse than one with no timeline.
  const loadTimeline = async (env) => {
    if (timelineFor === env.id) { setTimelineFor(null); return }
    setTimelineFor(env.id)
    if (timeline[env.id]) return
    const { data, error } = await fetchPacketTimeline(env.document_id)
    setTimeline(t => ({ ...t, [env.id]: error ? [] : (data || []) }))
  }

  // Remove a draft/unsigned/expired document to keep this tab tidy. The API
  // refuses to delete a completed record (that's the signed legal record), so
  // this action is only ever offered for non-completed statuses (see render).
  const deleteEnvelope = async (env) => {
    if (!window.confirm(`Remove "${env.document_name || 'this document'}"? This cannot be undone.`)) return
    setDeleting(p => ({ ...p, [env.id]: true }))
    try {
      await apiDeleteDocument(env.document_id)
      setEnvelopes(prev => prev.filter(e => e.id !== env.id))
      pushToast('Document removed', 'info')
    } catch (err) {
      pushToast(err.message, 'error')
    } finally {
      setDeleting(p => ({ ...p, [env.id]: false }))
    }
  }

  // WHAT THE LIST SHOWS, AND IN WHAT ORDER — signaturesView.js decides both.
  //
  // The old "Active (hide completed)" dropdown existed because finished work was
  // in the way. Grouping puts it away structurally: Signed and Recalled arrive
  // collapsed, one click from open, and the filter that used to hide them is
  // gone along with the reason for it.
  const groups  = groupPackets(envelopes)
  const summary = summaryLine(envelopes)

  if (!tableReady) return (
    <div style={{ padding:20 }}>
      <div style={{ background:'#fff8ec', border:'1px solid var(--gw-amber)', borderRadius:'var(--radius)', padding:16, fontSize:13, lineHeight:1.7 }}>
        <strong>Run this SQL in your Supabase dashboard:</strong>
        <pre style={{ background:'var(--gw-slate)', color:'#e2e8f0', padding:10, borderRadius:6, fontSize:11, marginTop:8, overflowX:'auto' }}>
{`create table if not exists boldsign_documents (
  id            uuid primary key default gen_random_uuid(),
  deal_id       uuid references deals(id) on delete cascade,
  document_id   text not null,
  signer_name   text,
  signer_email  text,
  document_name text,
  subject       text,
  status        text default 'sent',
  sent_at       timestamptz default now(),
  completed_at  timestamptz,
  created_at    timestamptz default now()
);
alter table boldsign_documents enable row level security;
create policy "agents_boldsign_documents" on boldsign_documents
  for all to authenticated using (true) with check (true);

-- Also run this for agent notifications:
create table if not exists agent_notifications (
  id           uuid primary key default gen_random_uuid(),
  agent_id     uuid references agents(id) on delete cascade,
  deal_id      uuid references deals(id) on delete set null,
  envelope_id  text,
  title        text,
  message      text,
  type         text default 'document_signed',
  read         boolean default false,
  created_at   timestamptz default now()
);
alter table agent_notifications enable row level security;
create policy "agent_notifications_policy" on agent_notifications
  for all to authenticated using (true) with check (true);`}
        </pre>
        <button className="btn btn--secondary btn--sm" style={{ marginTop:8 }} onClick={() => { setTableReady(true); loadEnvelopes() }}>
          <Icon name="refresh" size={12}/> Retry
        </button>
      </div>
    </div>
  )

  const hasTemplates = templates.length > 0
  const canCompose   = templates.length > 1   // a packet needs at least two forms

  return (
    <div style={{ padding:16, overflowY:'auto', flex:1 }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16, flexWrap:'wrap', gap:8 }}>
        {/* The tab in one sentence: how many need this agent, and how late the
            worst one is. It replaces a count and a filter dropdown that between
            them said how many rows were on screen — never what to do about any
            of them. */}
        <div style={{ display:'flex', alignItems:'baseline', gap:8, flexWrap:'wrap', minWidth:200 }}>
          <span style={{ fontSize:13, fontWeight:600, color: summary && /need/.test(summary) ? 'var(--gw-ink)' : 'var(--gw-mist)' }}>
            {summary || `${envelopes.length} document${envelopes.length === 1 ? '' : 's'}`}
          </span>
          {summary && <span style={{ fontSize:12, color:'var(--gw-mist)' }}>{envelopes.length} in all</span>}
        </div>
        {/* TEMPLATE FIRST. Nearly every send starts from a state e-sign
            template, so that is the primary button whenever one exists.
            It used to sit behind "More" as "Prepare from template…" — a name
            that read as drafting, not sending — while the primary "Send for
            Signature" was the upload-your-own-PDF path, so a new agent's first
            click put them in front of a blank PDF picker. Both doors now say
            what they start from; the rarer jobs stay one click down. */}
        <div style={{ display:'flex', gap:8, flexWrap:'wrap', alignItems:'center' }}>
          <MenuButton
            className="btn btn--secondary btn--sm"
            label={<><Icon name="more" size={13}/> More</>}
            title="Send several forms at once, or build an MLS upload"
            items={[
              canCompose && {
                label: 'Send several forms together…',
                title: 'Send several forms to the same signers — together as one document, or separately',
                onClick: () => setComposeOpen(true),
              },
              canCompose && { divider: true },
              {
                label: 'Pack for MLS…',
                title: "Build an MLS upload from this deal's signed forms — separate files or one merged PDF. Assembled here; nothing is re-sent through BoldSign.",
                onClick: () => setMlsOpen(true),
              },
            ]}
          />
          <button
            className={`btn ${hasTemplates ? 'btn--secondary' : 'btn--primary'} btn--sm`}
            onClick={() => setSendOpen(true)}
            title="Upload a PDF you already have (or pick one from this deal's Documents) and place the signature fields yourself"
          >
            <Icon name="upload" size={13}/> Upload Your Own PDF
          </button>
          {hasTemplates && (
            <button
              className="btn btn--primary btn--sm"
              onClick={() => setTplOpen(true)}
              title="Pick your state's e-sign form — it fills in from this deal, you review it, then send"
            >
              <Icon name="send" size={13}/> Send from Template
            </button>
          )}
        </div>
      </div>

      {/* Why "Send from Template" isn't here — never fail silently. */}
      {templateErr && (
        <div style={{ background:'#fff8ec', border:'1px solid var(--gw-amber)', borderRadius:'var(--radius)', padding:'10px 12px', fontSize:12, lineHeight:1.6, marginBottom:12 }}>
          <strong>Template sending unavailable.</strong> {templateErr}
        </div>
      )}

      {loading
        ? <div style={{ fontSize:13, color:'var(--gw-mist)' }}>Loading…</div>
        : groups.length === 0
          ? <SignaturesGettingStarted
              hasTemplates={hasTemplates}
              templatesBroken={Boolean(templateErr)}
              onTemplate={() => setTplOpen(true)}
              onUpload={() => setSendOpen(true)}
            />
          : groups.map(group => {
              const open  = groupOpen[group.id] ?? group.open
              const tone  = GROUP_TONE[group.tone] || 'var(--gw-border)'
              return (
                <div key={group.id} style={{ marginBottom:14 }}>
                  {/* GROUP HEADER. The count is the point of it: "Needs you 2"
                      answers the question the tab is opened with before a single
                      row is read. Signed and Recalled arrive closed, which is
                      what the old "hide completed" filter was for. */}
                  <button
                    type="button"
                    onClick={() => setGroupOpen(g => ({ ...g, [group.id]: !open }))}
                    aria-expanded={open}
                    style={{
                      display:'flex', alignItems:'center', gap:8, width:'100%', textAlign:'left',
                      background:'transparent', border:0, borderBottom:'1px solid var(--gw-border)',
                      padding:'4px 2px 6px', marginBottom:6, cursor:'pointer', fontFamily:'var(--font-body)',
                    }}
                  >
                    <span style={{ width:7, height:7, borderRadius:'50%', background:tone, flexShrink:0 }} />
                    <span style={{ fontSize:11, fontWeight:700, letterSpacing:'0.07em', textTransform:'uppercase', color:'var(--gw-ink)' }}>
                      {group.label}
                    </span>
                    <span style={{ fontSize:11, color:'var(--gw-mist)' }}>{group.packets.length}</span>
                    <span style={{ marginLeft:'auto', color:'var(--gw-mist)', fontSize:10 }}>{open ? '\u25be' : '\u25b8'}</span>
                  </button>

                  {open && group.packets.map(env => {
              const sc        = DS_STATUS[env.status] || DS_STATUS.sent
              const completed = env.status === 'completed'
              const isDraft   = env.status === 'draft'
              // TWO FLAGS, because they answer different questions.
              //
              // `inFlight` — out with signers and not finished, which now
              // includes `needs_attention`. Everything about WHERE the packet
              // has got to hangs off this: how long it has been out, who is
              // holding it up, and the Fix packet / acknowledgement actions.
              //
              // `awaiting` — the narrower set the REMIND button belongs to.
              // Reminding a signer whose link will not open, or whose address
              // bounced, teaches a client to ignore the next email and fixes
              // nothing. That is a recipient problem, not a nudge problem.
              const inFlight  = isInFlight(env)
              const daysOut   = inFlight ? packetDaysOut(env) : null
              // Who is on this document, and where each of them has got to.
              const people   = signerRows(env)
              const pending  = outstandingSigners(people)
              const progress = signerProgress(people)
              // The row is closed until asked. Opening the history opens the row
              // with it — a timeline rendered inside a collapsed row is a button
              // that appears to do nothing.
              const showAll  = Boolean(expandedRows[env.id]) || timelineFor === env.id
              const step     = nextStep(env)
              const quiet    = group.id === 'signed' || group.id === 'stalled'
              return (
                <div key={env.id} style={{ border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', marginBottom:6, background: quiet && !showAll ? '#fbfaf8' : '#fff', overflow:'hidden', display:'flex' }}>
                  {/* THE STATUS, SAID ONCE. A colour down the left edge carries
                      the state that used to be repeated in a chip, a grey meta
                      line and a coloured strip under every card. */}
                  <div style={{ width:3, background:tone, flexShrink:0 }} />
                  <div style={{ flex:1, minWidth:0 }}>
                    <div
                      role="button" tabIndex={0}
                      aria-expanded={showAll}
                      onClick={() => setExpandedRows(r => ({ ...r, [env.id]: !showAll }))}
                      onKeyDown={e => {
                        // Only the row itself. Space on the Remind button inside it
                        // is that button's, and must not also fold the row away.
                        if (e.target !== e.currentTarget) return
                        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpandedRows(r => ({ ...r, [env.id]: !showAll })) }
                      }}
                      style={{ display:'flex', alignItems:'center', gap:8, padding:'9px 10px', cursor:'pointer' }}
                      title={showAll ? 'Hide the detail' : 'Show signers and everything else on this packet'}
                    >
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ fontSize:13, fontWeight:600, display:'flex', alignItems:'center', gap:6, minWidth:0, color: quiet ? 'var(--gw-mist)' : 'var(--gw-ink)' }}>
                          <span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                            {env.document_name || 'Document'}
                          </span>
                          {/* A correction is a separate envelope that only makes
                              sense next to the thing it corrects — say so on the
                              row, or it reads as a duplicate send. */}
                          {env.correction_of_document_id && (
                            <span
                              style={{ fontSize:10, fontWeight:700, color:'var(--gw-amber)', textTransform:'uppercase', flexShrink:0 }}
                              title="An acknowledgement packet correcting an earlier signed document. Both stay on the deal."
                            >correction</span>
                          )}
                          {env.mode === 'merged' && (
                            <span
                              style={{ fontSize:10, fontWeight:700, color:'var(--gw-mist)', textTransform:'uppercase', flexShrink:0 }}
                              title={env.download_option === 'Individually'
                                ? 'Several forms in one document. Each form can be downloaded on its own for MLS.'
                                : 'Several forms in one combined document. MLS gets one PDF — BoldSign cannot split a signed combined file afterwards.'}
                            >{env.download_option === 'Individually' ? 'packet \u00b7 per-form' : 'packet \u00b7 combined'}</span>
                          )}
                          {/* The word only where the colour cannot say it. */}
                          {showsStatusChip(env) && (
                            <span style={{ padding:'1px 7px', borderRadius:10, fontSize:10, fontWeight:700, background:sc.bg, color:sc.color, flexShrink:0 }}>{packetState(env)}</span>
                          )}
                        </div>
                        <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                          {/* The sentence the old comma-joined string could never
                              say. On a four-party packet "waiting on John Doe" is
                              the only fact that decides what the agent does next. */}
                          {inFlight ? waitingOnLabel(people) : `To: ${people.map(p => p.name || p.email).filter(Boolean).join(', ') || env.signer_name}`}
                          {progress.total > 1 && ` \u00b7 ${progress.signed}/${progress.total} signed`}
                          {' \u00b7 '}{new Date(env.sent_at || env.created_at).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })}
                          {completed && env.completed_at && (
                            <span> \u00b7 Signed {new Date(env.completed_at).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })}</span>
                          )}
                          {daysOut !== null && daysOut >= 2 && (
                            <span style={{ color: daysOut >= OVERDUE_DAYS ? 'var(--gw-red)' : 'var(--gw-amber)', fontWeight:600 }}>
                              {' \u00b7 waiting '}{daysOut}d
                              {env.reminder_count > 0 && ` \u00b7 ${env.reminder_count} reminder${env.reminder_count > 1 ? 's' : ''} sent`}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* THE ONE ACTION THAT MOVES THIS PACKET FORWARD. Which one
                          that is depends on the packet's state and is decided in
                          signaturesView.js, where it can be tested. Everything
                          else this row supports is a click away, in the menu
                          beside it — nothing was removed, it stopped shouting. */}
                      {step && (
                        <button
                          className={step.id === 'send' ? 'btn btn--primary btn--sm' : 'btn btn--secondary btn--sm'}
                          style={{ fontSize:11, flexShrink:0 }}
                          onClick={e => {
                            e.stopPropagation()
                            if (step.id === 'remind')     return remind(env)
                            if (step.id === 'send')       return setSendAsk(env)
                            if (step.id === 'download')   return downloadSigned(env)
                            if (step.id === 'fix')        return fixPacket(env)
                            if (step.id === 'correction') return setCorrectAsk(env)
                          }}
                          disabled={
                            (step.id === 'remind'     && reminding[env.id]) ||
                            (step.id === 'send'       && sendingDraft[env.id]) ||
                            (step.id === 'download'   && downloading[env.id]) ||
                            (step.id === 'fix'        && (fixing[env.id] || !canFixPacket(env))) ||
                            (step.id === 'correction' && correcting[env.id])
                          }
                          title={
                            step.id === 'remind'
                              ? [
                                  pending.length
                                    ? `Emails ${pending.map(p => p.name || p.email).join(', ')} — nobody who has already signed`
                                    : 'Emails whoever still owes a signature',
                                  env.last_reminded_at
                                    ? `Last reminded ${new Date(env.last_reminded_at).toLocaleDateString('en-US', { month:'short', day:'numeric' })}`
                                    : null,
                                ].filter(Boolean).join('. ')
                              : step.id === 'send'       ? 'Email this document to its signers for e-signature'
                              : step.id === 'download'   ? 'Download the signed PDF'
                              : step.id === 'fix'        ? (fixPacketBlockedReason(env) || 'Reopen this packet in BoldSign — anyone who has already signed is untouched')
                              : 'Send a corrected copy, keeping everything already filled in'
                          }
                        >
                          {(step.id === 'remind' && reminding[env.id]) ? 'Sending\u2026'
                            : (step.id === 'send' && sendingDraft[env.id]) ? 'Sending\u2026'
                            : (step.id === 'download' && downloading[env.id]) ? 'Downloading\u2026'
                            : (step.id === 'fix' && fixing[env.id]) ? 'Opening\u2026'
                            : (step.id === 'correction' && correcting[env.id]) ? 'Preparing\u2026'
                            : step.label}
                        </button>
                      )}

                      <MenuButton
                        title="Everything else on this packet"
                        items={[
                          { label: 'Save a PDF copy', title: 'Pages with their filled values, plus a summary of who signs what', onClick: () => savePdf(env), disabled: savingPdf[env.id] },
                          { label: 'Refresh status',  title: 'Ask BoldSign where this packet has got to', onClick: () => refreshStatus(env) },
                          { label: showAll && timelineFor === env.id ? 'Hide history' : 'History\u2026', title: 'What has happened to this packet — sent, viewed, signed, edited, recalled', onClick: () => loadTimeline(env) },
                          !completed && { divider: true },
                          !completed && { label: 'Remove document', danger: true, onClick: () => deleteEnvelope(env), disabled: deleting[env.id] },
                        ]}
                      />
                    </div>

                    {/* EVERYTHING ELSE, ONE CLICK DOWN. Signers, the advisory
                        for this state and its actions used to be stacked under
                        every row at once; they are the same markup, shown when
                        the agent asks for this packet rather than for all of
                        them. */}
                    {showAll && (
                      <>
                    {/* WHO STILL OWES A SIGNATURE. One row per recipient, in
                        signing order, each with its own state and its own nudge.
                        Shown only while the document is in flight: once everyone
                        has signed, the completed strip below says all there is to
                        say, and a list of green ticks is just noise on the row.

                        A per-signer Remind is not a convenience. Reminding the
                        whole document emails people who have already signed, and
                        on a sequential send it emails people BoldSign has not
                        asked yet — both of which teach a client to ignore the
                        next one. */}
                    {inFlight && people.length > 1 && (
                      <div style={{ borderTop:'1px solid var(--gw-border)', padding:'6px 12px 8px', background:'var(--gw-bone)' }}>
                        {people.map(p => {
                          const done = p.status === 'signed'
                          const bad  = ['declined', 'expired', 'revoked'].includes(p.status)
                          const busy = Boolean(reminding[`${env.id}:${p.email}`])
                          return (
                            <div key={`${p.email || p.name}-${p.order}`} style={{ display:'flex', alignItems:'center', gap:8, padding:'3px 0' }}>
                              <span style={{
                                width:16, height:16, borderRadius:'50%', flexShrink:0, display:'inline-flex',
                                alignItems:'center', justifyContent:'center', fontSize:9, fontWeight:700,
                                background: done ? 'var(--gw-green)' : bad ? 'var(--gw-red)' : p.status === 'viewed' ? 'var(--gw-amber)' : 'var(--gw-border)',
                                color: done || bad || p.status === 'viewed' ? '#fff' : 'var(--gw-mist)',
                              }}>
                                {done ? '\u2713' : bad ? '!' : p.order}
                              </span>
                              <span style={{ fontSize:12, flex:1, minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                                {p.name || p.email}
                                {p.role && <span style={{ color:'var(--gw-mist)' }}> · {p.role}</span>}
                              </span>
                              <span style={{ fontSize:11, color: done ? 'var(--gw-green)' : bad ? 'var(--gw-red)' : 'var(--gw-mist)', flexShrink:0 }}>
                                {describeSignerState(p)}
                              </span>
                              {/* Only someone who can actually act right now gets
                                  a nudge. Queued signers have not been emailed. */}
                              {p.status !== 'signed' && p.status !== 'queued' && !bad && p.email && (
                                <button
                                  className="btn btn--ghost btn--sm"
                                  style={{ fontSize:10, flexShrink:0, padding:'2px 6px' }}
                                  onClick={() => remind(env, p)}
                                  disabled={busy}
                                  title={`Email only ${p.name || p.email}`}
                                >
                                  {busy ? '…' : 'Nudge'}
                                </button>
                              )}
                              {/* CHANGE SIGNER. Offered only for someone who has
                                  not finished — a signature already made is a
                                  legal act and the person who made it is not
                                  swapped out from under it. `p.id` is BoldSign's
                                  own recipient id; a packet sent before per-signer
                                  ids were recorded has none, and there is nothing
                                  honest to do but leave the button off. */}
                              {canChangeSigner(env, p) && p.id && (
                                <button
                                  className="btn btn--ghost btn--sm"
                                  style={{ fontSize:10, flexShrink:0, padding:'2px 6px' }}
                                  onClick={() => setSignerSwap({ env, signer: p })}
                                  title={`Send this one to someone else instead of ${p.name || p.email}`}
                                >
                                  Change
                                </button>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                    {/* A draft is unfinished work, not a sent document — say so, and
                        give the agent the doors back into it. Before this the row
                        showed a "Draft" chip and nothing else, so a send interrupted
                        by a screen change could only be restarted from scratch.

                        The three things an agent can do with a draft are genuinely
                        different acts: read it on paper,
                        change it, or put it in front of the client. They get three
                        separate buttons for that reason — the printed review copy is
                        the whole point of preparing a draft rather than sending one,
                        and it must never be one mis-click away from a real send. */}
                    {isDraft && (
                      <div style={{ borderTop:'1px solid var(--gw-border)', padding:'8px 12px', background:'#fff8ec', display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
                        <Icon name="alert" size={13} style={{ color:'var(--gw-amber)', flexShrink:0 }}/>
                        <span style={{ fontSize:12, flex:1, minWidth:180, color:'var(--gw-ink)' }}>
                          <strong>Draft — nothing sent.</strong> Print a filled copy for the client, keep editing, or send it when they’re happy.
                        </span>
                        <button
                          className="btn btn--secondary btn--sm"
                          style={{ fontSize:11, flexShrink:0 }}
                          onClick={() => savePdf(env)}
                          disabled={savingPdf[env.id]}
                          title="Download this draft as a PDF with every value you filled in — for printing and taking to the client. Not a signed document."
                        >
                          <Icon name="document" size={12}/> {savingPdf[env.id] ? 'Preparing…' : 'Download Filled PDF'}
                        </button>
                        <button
                          className="btn btn--secondary btn--sm"
                          style={{ fontSize:11, flexShrink:0 }}
                          onClick={() => printPdf(env)}
                          disabled={printingPdf[env.id]}
                          title="Open this draft in a new tab and print it from there \u2014 filled values included, no draft watermark"
                        >
                          <Icon name="document" size={12}/> {printingPdf[env.id] ? 'Opening\u2026' : 'Print'}
                        </button>
                        <button
                          className="btn btn--secondary btn--sm"
                          style={{ fontSize:11, flexShrink:0 }}
                          onClick={() => fileToDeal(env)}
                          disabled={filing[env.id]}
                          title="File this document on the deal — it appears in the deal's Documents tab, filled values included"
                        >
                          <Icon name="upload" size={12}/> {filing[env.id] ? 'Filing…' : 'Save to Deal'}
                        </button>
                        <button
                          className="btn btn--secondary btn--sm"
                          style={{ fontSize:11, flexShrink:0 }}
                          onClick={() => openDraft(env)}
                          disabled={opening[env.id]}
                          title="Reopen this draft in BoldSign to change values, signers or field placement"
                        >
                          <Icon name="edit" size={12}/> {opening[env.id] ? 'Opening…' : 'Edit Fields'}
                        </button>
                        <button
                          className="btn btn--primary btn--sm"
                          style={{ fontSize:11, flexShrink:0 }}
                          onClick={() => setSendAsk(env)}
                          disabled={sendingDraft[env.id]}
                          title="Email this document to its signers for e-signature"
                        >
                          <Icon name="send" size={12}/> {sendingDraft[env.id] ? 'Sending…' : 'Send for Signature'}
                        </button>
                      </div>
                    )}
                    {/* A PACKET THAT IS OUT FOR SIGNATURE, and the two things that
                        can be done to one.

                        "Fix packet" is the whole point of this strip: before it,
                        a packet the client had started signing was untouchable
                        from here, and the only route to a correction was recalling
                        it and rebuilding the whole thing. It is NOT offered on a
                        settled packet — BoldSign will not edit one and it is right
                        not to — and the tooltip there names the alternative rather
                        than leaving a greyed button with no explanation.

                        There is deliberately no strike-through tool. A drawing
                        over the old text says nothing about who agreed to the
                        change or when; an acknowledgement plus initials says
                        exactly that, and is what the second button places. */}
                    {inFlight && (
                      <div style={{ borderTop:'1px solid var(--gw-border)', padding:'8px 12px', background:'var(--gw-bone)', display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
                        <span style={{ fontSize:12, flex:1, minWidth:180, color:'var(--gw-mist)' }}>
                          {isEditPending(env)
                            ? <>
                                <strong>Applying a change.</strong> BoldSign is still updating this packet's files — it is not
                                safe to send or edit until that lands
                                {/* How long, once it has been long enough to be worth
                                    wondering about. A spinner with no elapsed time
                                    leaves an agent unable to tell "in progress" from
                                    "stuck", and the answer to the second is Check now. */}
                                {editPendingMs(env) > 60_000 && ` (${Math.round(editPendingMs(env) / 60_000)} min so far)`}.
                              </>
                            : <>Out for signature. A change the client has asked for goes on as an acknowledgement they initial.</>}
                        </span>
                        {isEditPending(env) && (
                          <button
                            className="btn btn--secondary btn--sm"
                            style={{ fontSize:11, flexShrink:0 }}
                            onClick={() => syncPacket(env)}
                            title="Ask BoldSign whether the file change has landed yet"
                          >
                            <Icon name="refresh" size={12}/> Check now
                          </button>
                        )}
                        <button
                          className="btn btn--secondary btn--sm"
                          style={{ fontSize:11, flexShrink:0 }}
                          onClick={() => setAckFor(env)}
                          disabled={!canFixPacket(env) || fixing[env.id]}
                          title={fixPacketBlockedReason(env) || 'Add a line saying what changed, plus a required Initial box for whoever has not signed yet'}
                        >
                          <Icon name="edit" size={12}/> {fixing[env.id] ? 'Working…' : 'Add acknowledgement'}
                        </button>
                        <button
                          className="btn btn--secondary btn--sm"
                          style={{ fontSize:11, flexShrink:0 }}
                          onClick={() => fixPacket(env)}
                          disabled={!canFixPacket(env) || fixing[env.id]}
                          title={fixPacketBlockedReason(env) || 'Reopen this packet in BoldSign to change fields or placement. Anyone who has already signed is untouched.'}
                        >
                          <Icon name="edit" size={12}/> {fixing[env.id] ? 'Opening…' : 'Fix packet'}
                        </button>
                        {canRevoke(env) && (
                          <button
                            className="btn btn--ghost btn--sm"
                            style={{ fontSize:11, flexShrink:0 }}
                            onClick={() => setRevokeAsk(env)}
                            disabled={revoking[env.id]}
                            title="Recall this packet so the signers can no longer open it. It stays on the deal as a recalled packet."
                          >
                            {revoking[env.id] ? 'Recalling…' : 'Recall'}
                          </button>
                        )}
                      </div>
                    )}
                    {/* Declined, recalled or expired: nothing to fix, but the deal
                        still needs the document. A correction packet clones it with
                        every agreed value intact, which is far less work than
                        rebuilding from the template. */}
                    {!completed && !isDraft && !inFlight && canSendCorrection(env) && (
                      <div style={{ borderTop:'1px solid var(--gw-border)', padding:'8px 12px', background:'#fff8ec', display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
                        <Icon name="alert" size={13} style={{ color:'var(--gw-amber)', flexShrink:0 }}/>
                        <span style={{ fontSize:12, flex:1, minWidth:180, color:'var(--gw-ink)' }}>
                          <strong>{packetState(env)}.</strong> This packet can no longer be edited. Send a corrected copy instead — it keeps everything that was already filled in.
                        </span>
                        <button
                          className="btn btn--primary btn--sm"
                          style={{ fontSize:11, flexShrink:0 }}
                          onClick={() => setCorrectAsk(env)}
                          disabled={correcting[env.id]}
                        >
                          <Icon name="send" size={12}/> {correcting[env.id] ? 'Preparing…' : 'Send correction packet'}
                        </button>
                      </div>
                    )}
                    {/* THE PACKET'S OWN HISTORY. `audit_log` records what an agent
                        did; this records what happened to the document, which is
                        the record a compliance question asks for. */}
                    {timelineFor === env.id && (
                      <div style={{ borderTop:'1px solid var(--gw-border)', padding:'8px 12px', background:'var(--gw-bone)' }}>
                        {!timeline[env.id] && <div style={{ fontSize:12, color:'var(--gw-mist)' }}>Loading…</div>}
                        {timeline[env.id]?.length === 0 && (
                          <div style={{ fontSize:12, color:'var(--gw-mist)', lineHeight:1.6 }}>
                            No events recorded for this packet yet. BoldSign's webhook writes them as they happen; a packet
                            sent before this deal's CRM was updated has none.
                          </div>
                        )}
                        {timeline[env.id]?.map(ev => (
                          <div key={ev.id} style={{ display:'flex', gap:8, fontSize:12, padding:'2px 0' }}>
                            <span style={{ color:'var(--gw-mist)', minWidth:130, flexShrink:0 }}>
                              {ev.occurred_at ? new Date(ev.occurred_at).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }) : '—'}
                            </span>
                            <span style={{ fontWeight:600 }}>{ev.event}</span>
                            {(ev.signer_name || ev.signer_email) && (
                              <span style={{ color:'var(--gw-mist)' }}>· {ev.signer_name || ev.signer_email}</span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                    {completed && (
                      <div style={{ borderTop:'1px solid var(--gw-border)', padding:'8px 12px', background:'var(--gw-green-light)', display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
                        <Icon name="check" size={13} style={{ color:'var(--gw-green)', flexShrink:0 }}/>
                        <span style={{ fontSize:12, color:'var(--gw-green)', flex:1, fontWeight:600, minWidth:160 }}>Fully signed — copy saved to Documents tab</span>
                        <button
                          className="btn btn--sm"
                          style={{ background:'var(--gw-green)', color:'#fff', border:'none', fontSize:11 }}
                          onClick={() => downloadSigned(env)}
                          disabled={downloading[env.id]}
                        >
                          {downloading[env.id] ? 'Downloading…' : 'Download Signed PDF'}
                        </button>
                        <button
                          className="btn btn--sm btn--secondary"
                          style={{ fontSize:11 }}
                          onClick={() => downloadAuditTrail(env)}
                          disabled={downloading[`audit-${env.id}`]}
                          title="Compliance audit trail — who signed, when, IP, and a tamper hash"
                        >
                          {downloading[`audit-${env.id}`] ? 'Fetching…' : 'Audit Trail'}
                        </button>
                        <button
                          className="btn btn--sm btn--secondary"
                          style={{ fontSize:11 }}
                          onClick={() => setMlsOpen(true)}
                          title="Build the MLS upload from this deal's signed forms — separate files or one merged PDF"
                        >
                          Pack for MLS
                        </button>
                        {/* THE ONLY THING THAT CAN BE DONE TO A SIGNED PACKET.
                            Not "Edit signed document", which is not a thing:
                            BoldSign will not change a completed envelope and this
                            app does not pretend it can. A correction is a new
                            request, and the modal says so before anything is
                            created. */}
                        <button
                          className="btn btn--sm btn--secondary"
                          style={{ fontSize:11 }}
                          onClick={() => setCorrectAsk(env)}
                          disabled={correcting[env.id]}
                          title="Creates a new signature request with everything already filled in, plus an acknowledgement to initial. The original signed PDF stays on the deal."
                        >
                          {correcting[env.id] ? 'Preparing…' : 'Send correction packet'}
                        </button>
                      </div>
                    )}
                      </>
                    )}
                  </div>
                </div>
              )
                  })}
                </div>
              )
            })
      }

      {/* WHAT THIS DEAL REMEMBERS — a footnote, not a banner.
          Field placement is invisible work: the agent who arranged a packet last
          month has no way to know it was kept unless the tab says so. But it is
          reassurance, not work, and it sat above the documents in five lines on
          every visit. One line, at the end of the list, expandable for the
          detail — said once, where it is read rather than stepped over. */}
      {layouts.length > 0 && (
        <div style={{ marginTop:10, fontSize:11, color:'var(--gw-mist)', lineHeight:1.7 }}>
          <button
            type="button"
            onClick={() => setLayoutsOpen(o => !o)}
            style={{ background:'none', border:0, padding:0, cursor:'pointer', color:'var(--gw-mist)', fontFamily:'var(--font-body)', fontSize:11, display:'inline-flex', alignItems:'center', gap:5 }}
            aria-expanded={layoutsOpen}
          >
            <Icon name="check" size={11} style={{ color:'var(--gw-green)' }}/>
            Field layout remembered for {layouts.length} form{layouts.length === 1 ? '' : 's'}
            <span style={{ textDecoration:'underline' }}>{layoutsOpen ? 'hide' : "what's kept"}</span>
          </button>
          {layoutsOpen && (
            <div style={{ marginTop:4, paddingLeft:16 }}>
              {layouts.map((l, i) => {
                const tpl = templates.find(t => t.template_id === l.template_id)
                const name = tpl?.name || l.document_name || (l.template_id ? 'a template' : 'an uploaded PDF')
                return (
                  <span key={l.template_id || 'adhoc'}>
                    {i > 0 && ' \u00b7 '}
                    {name} ({l.field_count} field{l.field_count === 1 ? '' : 's'})
                  </span>
                )
              })}
              <div>Signature, initial and label placements are restored automatically the next time you send this form for this deal.</div>
            </div>
          )}
        </div>
      )}

      {/* Both send modals reload on CLOSE as well as on send: the draft row is
          written server-side the moment BoldSign hands back a prepare URL, so an
          agent who backs out mid-prep has to see that draft here to reopen it. */}
      {sendOpen && (
        <SendSignatureModal
          deal={deal} contacts={contacts} properties={properties} dealFiles={dealFiles} activeAgent={activeAgent}
          onClose={() => { setSendOpen(false); loadEnvelopes(); loadLayouts() }}
          onSent={() => { setSendOpen(false); loadEnvelopes(); loadLayouts() }}
        />
      )}

      {/* A reopened draft — the same BoldSign prepare screen the send started in. */}
      {editDraft && (
        <BoldSignStepModal
          url={editDraft.url}
          documentId={editDraft.env.document_id}
          eyebrow="BoldSign · Edit Draft"
          heading={editDraft.env.document_name || 'Edit draft'}
          onLayoutSaved={loadLayouts}
          onClose={() => { setEditDraft(null); loadEnvelopes(); loadLayouts() }}
          onDone={() => { pushToast('Sent for signature', 'success'); setEditDraft(null); loadEnvelopes(); loadLayouts() }}
          // Reload the rows too: the draft the agent just saved is what this tab
          // lists, and leaving the list stale is how "it didn't save" gets
          // reported for a save that worked.
          onDraft={() => { pushToast('Draft saved — nothing sent. Reopen it here any time to finish.', 'info'); loadEnvelopes() }}
        />
      )}

      {tplOpen && (
        <SendFromTemplateModal
          deal={deal} contacts={contacts} properties={properties} extraContacts={extraContacts} sideClients={sideClients} dealAgents={dealAgents} templates={templates} activeAgent={activeAgent}
          onClose={() => { setTplOpen(false); loadEnvelopes(); loadLayouts() }}
          onSent={() => { setTplOpen(false); loadEnvelopes(); loadLayouts() }}
          onSaved={() => { setTplOpen(false); loadEnvelopes(); loadLayouts() }}
        />
      )}

      {/* ── Signature packets ─────────────────────────────────────────────── */}

      {composeOpen && (
        <ComposePacketModal
          deal={deal} contacts={contacts} properties={properties} extraContacts={extraContacts}
          sideClients={sideClients} dealAgents={dealAgents} templates={templates} activeAgent={activeAgent}
          onClose={() => { setComposeOpen(false); loadEnvelopes() }}
          onSent={() => { setComposeOpen(false); loadEnvelopes(); loadLayouts() }}
        />
      )}

      {mlsOpen && (
        <MlsPackModal
          dealId={deal.id}
          address={propertyLabel(properties.find(p => p.id === deal?.property_id)) || deal?.title || ''}
          onClose={() => setMlsOpen(false)}
        />
      )}

      {/* A packet reopened mid-signature. The same BoldSign editor the draft
          flow uses — reopening a live document is the same screen, and giving it
          a different one would be a second thing to keep working. */}
      {fixFrame && (
        <BoldSignStepModal
          url={fixFrame.url}
          documentId={fixFrame.env.document_id}
          eyebrow="BoldSign · Fix packet"
          heading={fixFrame.env.document_name || 'Fix packet'}
          onLayoutSaved={loadLayouts}
          onClose={() => { setFixFrame(null); loadEnvelopes(); loadLayouts() }}
          onDone={() => { pushToast('Packet updated.', 'success'); setFixFrame(null); loadEnvelopes(); loadLayouts() }}
          onDraft={() => { pushToast('Change saved in BoldSign.', 'info'); loadEnvelopes() }}
        />
      )}

      {/* The correction packet being prepared. A different heading from Fix
          packet on purpose: this frame is building a SECOND document, and an
          agent who thinks they are editing the original will send it without
          reading it. */}
      {cloneFrame && (
        <BoldSignStepModal
          url={cloneFrame.url}
          documentId={cloneFrame.env.document_id}
          eyebrow="BoldSign · Correction packet"
          heading={`Correction of ${cloneFrame.env.document_name || 'Document'}`}
          onClose={() => { setCloneFrame(null); loadEnvelopes() }}
          onDone={() => { pushToast('Correction packet sent. The original signed PDF is still on the deal.', 'success'); setCloneFrame(null); loadEnvelopes() }}
          onDraft={() => { pushToast('Correction saved as a draft — nothing sent.', 'info'); loadEnvelopes() }}
        />
      )}

      {/* Explains the correction BEFORE it exists, because the thing agents get
          wrong here is thinking a correction replaces the original. It does not:
          both stay on the deal, and the original is what MLS receives. */}
      {correctAsk && (
        <ConfirmDialog
          eyebrow="BoldSign · Correction packet"
          title="Send a correction packet?"
          confirmLabel="Prepare correction"
          busyLabel="Preparing…"
          confirmVariant="btn--primary"
          busy={Boolean(correcting[correctAsk.id])}
          onCancel={() => setCorrectAsk(null)}
          onConfirm={() => startCorrection(correctAsk)}
          message={
            <>
              <p style={{ margin:'0 0 10px', color:'var(--gw-ink)' }}>
                Creates a <strong>new signature request</strong>. The original signed PDF stays on the deal for MLS.
              </p>
              <p style={{ margin:'0 0 10px' }}>
                <strong>{correctAsk.document_name || 'This packet'}</strong> is {packetState(correctAsk).toLowerCase()} and cannot be
                changed — BoldSign will not edit a settled document. The copy opens with every value already filled in,
                so all you add is the change itself.
              </p>
              <p style={{ margin:'0 0 6px', color:'var(--gw-ink)', fontWeight:600 }}>In the screen that opens:</p>
              <ul style={{ margin:'0 0 10px 18px', padding:0 }}>
                <li>leave <strong>Keep filled values</strong> on</li>
                <li>add a <strong>Label</strong> reading “Acknowledged change”</li>
                <li>add a required <strong>Initials</strong> box beside it</li>
                <li>Send</li>
              </ul>
              <p style={{ margin:0 }}>Nothing is sent until you click Send inside BoldSign.</p>
            </>
          }
        />
      )}

      {/* The acknowledgement, placed without opening the designer. Asks only for
          the page, because that is the one thing the CRM cannot know and the one
          thing that is wrong if guessed. */}
      {ackFor && (
        <AcknowledgementDialog
          env={ackFor}
          busy={Boolean(fixing[ackFor.id])}
          onCancel={() => setAckFor(null)}
          onConfirm={(page) => addAcknowledgement(ackFor, page)}
        />
      )}

      {signerSwap && (
        <ChangeSignerDialog
          env={signerSwap.env}
          signer={signerSwap.signer}
          candidates={buildCandidates({
            dealContacts: [contacts.find(c => c.id === deal?.contact_id), ...extraContacts].filter(Boolean),
            dealAgents,
          })}
          busy={swapping}
          onCancel={() => setSignerSwap(null)}
          onConfirm={(next) => changeSigner(signerSwap, next)}
        />
      )}

      {revokeAsk && (
        <ConfirmDialog
          eyebrow="BoldSign · Recall"
          title="Recall this packet from its signers?"
          confirmLabel="Recall"
          busyLabel="Recalling…"
          busy={Boolean(revoking[revokeAsk.id])}
          onCancel={() => setRevokeAsk(null)}
          onConfirm={() => revokePacket(revokeAsk)}
          message={
            <>
              <p style={{ margin:'0 0 10px', color:'var(--gw-ink)' }}>
                <strong>{revokeAsk.document_name || 'This packet'}</strong> will stop working for everyone who has not
                finished, including anyone who has already opened it.
              </p>
              <p style={{ margin:0 }}>
                Signatures already collected are not undone — they stay in BoldSign's record. The packet stays on this
                deal, marked Revoked, and you can send a corrected copy from it.
              </p>
            </>
          }
        />
      )}

      {/* The one irreversible step in the draft workflow. It names the actual
          recipients rather than asking "are you sure?", because the mistake this
          catches is sending the RIGHT document to the WRONG people — a confirm
          that doesn't show who is about to be emailed cannot catch that. */}
      {sendAsk && (
        <ConfirmDialog
          eyebrow="BoldSign · Send for Signature"
          title="Send this document to its signers?"
          confirmLabel="Send for Signature"
          busyLabel="Sending…"
          confirmVariant="btn--primary"
          busy={Boolean(sendingDraft[sendAsk.id])}
          onCancel={() => setSendAsk(null)}
          onConfirm={() => sendDraftNow(sendAsk)}
          message={
            <>
              <p style={{ margin:'0 0 10px', color:'var(--gw-ink)' }}>
                <strong>{sendAsk.document_name || 'This document'}</strong> will be emailed for e-signature to:
              </p>
              {/* IN SIGNING ORDER, one per line, with the address. The mistake
                  this dialog exists to catch is sending the RIGHT document to
                  the WRONG people, and a comma-joined run-on line is exactly
                  what a person skims past. */}
              {(() => {
                const rows = signerRows(sendAsk)
                if (!rows.length) return <p style={{ margin:'0 0 10px' }}>{sendAsk.signer_email || sendAsk.signer_name || 'its signers'}</p>
                return (
                  <ul style={{ margin:'0 0 10px', padding:0, listStyle:'none' }}>
                    {rows.map(r => (
                      <li key={`${r.email || r.name}-${r.order}`} style={{ display:'flex', gap:8, padding:'2px 0', color:'var(--gw-ink)' }}>
                        <span style={{ color:'var(--gw-mist)', minWidth:16 }}>{r.order}.</span>
                        <span><strong>{r.name || r.email}</strong>{r.name && r.email ? ` — ${r.email}` : ''}{r.role ? ` (${r.role})` : ''}</span>
                      </li>
                    ))}
                  </ul>
                )
              })()}
              <p style={{ margin:0 }}>
                It stops being a draft, so it can no longer be edited here. If the client still has changes,
                cancel and use <strong>Edit Fields</strong> instead.
              </p>
            </>
          }
        />
      )}
    </div>
  )
}
