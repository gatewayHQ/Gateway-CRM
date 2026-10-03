// Send from Template: pick a state form, fill it from the deal, review, send.

import React from 'react'
import { createSignerContact, linkContactToDeal } from '../../../lib/services/dealContacts.js'
import { OPERATING_STATES } from '../../../lib/constants.js'
import { streetLine } from '../../../lib/address.js'
import {
  documentEditUrl, deleteDocument as apiDeleteDocument, saveTemplateDraft, templateDetails, crmTokenValues, isFillableField, isTickableField, isPrefillableField, isSharedField, isSignerBoundField, isUnconfiguredField, isDateField, usDateToIso, isoDateToUs, signerBoundPrefillFields, buildPrefillFields, conditionalFieldsToRemove, emptyLabelsToRemove, partyNameGaps, describeFieldMapping, fieldTokenValue, fieldTokenKey, resolvePanel, seedPanelState, panelTickValues, panelMissing, panelFieldIds, revealedTokens, describePanelProblem, selectionRows, seedSelectionValues, applySelection, normalizeTokenKey, appointedAgent, orderAgentSigners, normalizeState, seedSignersFromDeal, buildTemplateRoles,
} from '../../../lib/services/boldsign.js'
import {
  readTemplateWork, saveTemplateWork, clearTemplateWork, isUnsentDraft, applySavedTemplateWork, templateWorkEdits, describeTemplateWorkEdits, countFilledWork,
} from '../../../lib/services/templateWork.js'
import SignerPicker, { buildCandidates, isValidEmail } from '../../../components/SignerPicker.jsx'
import { Icon, Modal, ConfirmDialog, pushToast } from '../../../components/UI.jsx'
import { boldSignReturnUrl, fetchDraftPreview } from './boldsignDocs.js'
import { fieldInfo, groupFields, prettyLabel } from './templateFields.js'
import { BoldSignStepModal } from './BoldSignStepModal.jsx'
import { DraftReviewStep } from './DraftReviewStep.jsx'
import { SIGNER_COLORS, templateStep } from './signatureSteps.js'

export function SendFromTemplateModal({ deal, contacts, properties, extraContacts = [], sideClients = null, dealAgents = [], templates, activeAgent, onClose, onSent, onSaved }) {
  const contact  = contacts?.find(c => c.id === deal?.contact_id)
  const property = properties?.find(p => p.id === deal?.property_id)

  // Filter templates to the deal's state (comp_data.state preferred, else the
  // normalized property state) PLUS the general / other forms — a packet filed
  // as "General / Other", or under no operating state, is usable on any deal.
  // Other states' forms stay hidden. With no deal state, show everything.
  const dealState = normalizeState(deal?.comp_data?.state || property?.state || '')
  const isGeneral = t => !t.state || t.transaction_type === 'general'
    || !OPERATING_STATES.some(s => s.code === normalizeState(t.state))
  const visible   = dealState
    ? templates.filter(t => isGeneral(t) || normalizeState(t.state) === dealState)
    : templates
  // How many of those are this state's own forms, for the line under the picker.
  // It once read a `matched` list that no longer existed, which threw on every
  // deal with a state and crashed the screen the moment it opened.
  const stateFormCount = dealState ? visible.filter(t => !isGeneral(t)).length : 0

  // The defaults live in constants because they are also the BASELINE the
  // "has this agent changed anything?" comparison runs against (see `seeded`
  // below). Inlining them in useState and re-typing them in the baseline is how
  // a screen reports itself as edited before anybody has touched it.
  const defaultSubject = `Please sign: ${deal?.title || 'Document'}`
  const defaultMessage = 'Please review and sign.'

  const [templateId, setTemplateId] = React.useState(visible[0]?.template_id || '')
  const [subject,    setSubject]    = React.useState(defaultSubject)
  const [embedUrl,   setEmbedUrl]   = React.useState(null)   // BoldSign prepare/send iframe URL
  const [embedDocId, setEmbedDocId] = React.useState(null)   // its document id — needed to capture the field layout
  const [sending,    setSending]    = React.useState(false)
  const [savingDraft, setSavingDraft] = React.useState(false)
  // The created draft, being looked at. Set by createDraft(); cleared only by
  // closing, because the draft outlives this modal either way.
  const [review,     setReview]     = React.useState(null)

  // ── Send options ──────────────────────────────────────────────────────────
  // BoldSign fixes these when the document is CREATED and refuses to change
  // them afterwards, which is why they are asked for here and not on the send
  // confirmation: by the time an agent is looking at a Send button it is
  // already too late to set an expiry or add a copy recipient.
  //
  // Deliberately NOT here: BoldSign's own auto-reminders. The CRM already owns
  // chasing — the nightly sweep decides when, and since F-03 it targets only
  // the signers who still owe something. Turning BoldSign's on as well would
  // mean two systems emailing the same client on two schedules, which is how a
  // client learns to filter you out. One reminder authority, and it is ours.
  const [showOptions, setShowOptions] = React.useState(false)
  const [message,     setMessage]     = React.useState(defaultMessage)
  const [ccInput,     setCcInput]     = React.useState('')
  const [cc,          setCc]          = React.useState([])
  const [expiryDays,  setExpiryDays]  = React.useState('')

  const addCc = (raw) => {
    const email = String(raw || '').trim().replace(/[,;]$/, '')
    if (!email) return
    if (!isValidEmail(email)) { pushToast(`"${email}" is not a valid email address.`, 'error'); return }
    if (cc.some(e => e.toLowerCase() === email.toLowerCase())) { setCcInput(''); return }
    setCc(p => [...p, email])
    setCcInput('')
  }

  // The deal's own agents, for the one-click CC below. Typing a colleague's
  // address by hand on every send is how the box stayed empty — but this is
  // deliberately a BUTTON and not a default: the CRM emails the signed PDF to
  // everyone on the deal by itself now (api/_lib/signedCopyMail.js), and a
  // BoldSign CC puts those addresses in front of every signer. Worth having for
  // an agent who wants BoldSign's own copy as well; not worth doing silently.
  const agentsNotCopied = React.useMemo(
    () => (dealAgents || [])
      .filter(a => a?.email && !cc.some(e => e.toLowerCase() === a.email.toLowerCase())),
    [dealAgents, cc],
  )
  const [details,    setDetails]    = React.useState(null)   // { roles, fields }
  const [loadingDet, setLoadingDet] = React.useState(false)
  const [detailsErr, setDetailsErr] = React.useState('')     // why the roles/fields could not be read
  const [reloadKey,  setReloadKey]  = React.useState(0)      // bumped by Retry
  const [signers,    setSigners]    = React.useState({})     // roleIndex → { name, email }
  // Signing order. SEQUENTIAL is the default, and that is a deliberate
  // reversal — it was parallel, so that two co-buyers sitting at the same table
  // could sign together instead of the second one waiting on the first.
  //
  // What changed is that BoldSign scopes FIELD VISIBILITY by role: a field
  // assigned to a signer is invisible to every other recipient until that signer
  // completes. Our packets carry the deal's own details — the agency type, the
  // appointed agent, the property, the price — on fields assigned to a signer,
  // and on a parallel send the other parties open the document and find those
  // lines blank. On an Appointed Agency form that means a client being asked to
  // sign an agreement without seeing which agent is being appointed.
  //
  // In order, with the client first, every later signer sees everything the
  // earlier ones did. The cost is real and accepted: co-buyers can no longer
  // sign simultaneously, they go one after the other. The box below still turns
  // it off for a packet that genuinely has nothing prefilled to share.
  const [inOrder,    setInOrder]    = React.useState(true)
  const [values,     setValues]     = React.useState({})     // fieldId → value

  // ── WORK IN PROGRESS ──────────────────────────────────────────────────────
  // Everything above used to exist only for as long as this modal was mounted.
  // An agent who ticked the boxes and corrected the buyer's name, then closed
  // the screen — the X, Escape, the backdrop, Cancel — lost all of it, silently,
  // and reopening the template re-seeded from the deal as if they had never been
  // there. Preparing a packet that is not needed until next week is a normal
  // thing to do, so it has to survive leaving.
  //
  // `seeded` is what SEEDING put on the screen, kept so "what did the agent
  // change" is answerable — the seeded values are the deal's, not their work, and
  // a close prompt that fires on those is a prompt that fires every time.
  // `savedWork` is the row this screen was restored from, if there was one.
  const [seeded,     setSeeded]     = React.useState(null)
  const [savedWork,  setSavedWork]  = React.useState(null)
  const [restored,   setRestored]   = React.useState(null)
  const [savingWork, setSavingWork] = React.useState(false)
  const [closeAsk,   setCloseAsk]   = React.useState(false)

  const tpl = templates.find(t => t.template_id === templateId)

  // Load the template's roles + fields whenever the selection changes, and seed
  // signer/field inputs from the deal.
  React.useEffect(() => {
    if (!templateId) { setDetails(null); setDetailsErr(''); return }
    let cancelled = false
    setLoadingDet(true)
    setDetailsErr('')
    // The template AND this deal's saved work on it, together: the merge below
    // needs both, and reading them in sequence would flash a freshly seeded
    // screen before replacing it with the agent's own answers.
    // readTemplateWork() never rejects — a database that has not run migration
    // 0044 logs and returns null — so this cannot turn a missing table into a
    // template that "could not be read".
    Promise.all([templateDetails(templateId), readTemplateWork({ dealId: deal?.id, templateId })])
      .then(([det, savedRow]) => {
        if (cancelled) return
        const roles  = det.roles?.length ? det.roles : [{ index: 1, name: 'Signer' }]
        const fields = (det.fields || []).filter(f => isPrefillableField(f.type))
        setDetails({ roles, fields })

        // Seed signer name/email from the deal's linked contact (+ spouse for a
        // second client role) and the acting agent. See seedSignersFromDeal.
        //
        // The token values follow the SAME people: every client on the deal (so
        // `client_names` prints "Jane Doe and John Doe" on a two-buyer packet),
        // and the deal's own agent rather than whoever happens to be sending —
        // an admin sending on an agent's behalf must not have their own name
        // printed as the appointed agent. See appointedAgent().
        // `agents` is the same ordered list seedSignersFromDeal() fills the
        // agent signature rows from, so a template's second agent LINE and its
        // second agent ROW name the same person.
        const tokenVals = crmTokenValues({
          deal, property, contact,
          additionalContacts: extraContacts,
          ...(sideClients || {}),
          agent:  appointedAgent({ activeAgent, dealAgents }),
          agents: orderAgentSigners({ activeAgent, dealAgents }),
          today:  new Date().toISOString().slice(0, 10),
        })
        // On a both-sided deal the per-side lists decide which party fills a row
        // captioned "Buyer" and which fills "Seller" — see seedSignersFromDeal.
        const seededSigners = seedSignersFromDeal({ roles, contact, additionalContacts: extraContacts, ...(sideClients || {}), activeAgent, dealAgents })

        const seededValues = {}
        for (const f of fields) {
          // A Name field is left empty on purpose. BoldSign prints the assigned
          // signer's own name in it and discards whatever we send, so seeding
          // `agent_name` here would show the agent a value the document will
          // never carry — the field is reported below instead of filled.
          if (isSignerBoundField(f.type)) { seededValues[f.id] = ''; continue }
          // Tick boxes start as null — "leave it to the signer" — rather than
          // false, so an untouched box isn't sent out locked as a deliberate no.
          // fieldTokenValue matches on the field's id, name OR label, normalized
          // for case and separators — BoldSign auto-assigns the id (`Label1`), so
          // a hand-typed token usually lives in the name or the label.
          // A tick box is the SENDER's decision, not the signer's: it starts at
          // whatever the template itself already carries (a box the packet was
          // authored with stays ticked) and goes out locked either way. It used
          // to start null — "leave it to the signer" — which is not what this
          // panel is for: these boxes are terms of the agreement.
          // A tick box the panel owns is a sender decision and is filled in
          // below from the panel's state. Any other box is NOT a sender
          // decision: it keeps whatever the template carries and no value is
          // sent for it, so this panel can never flip a box it does not show.
          seededValues[f.id] = isTickableField(f.type) ? null : fieldTokenValue(tokenVals, f)
        }

        // WHICH DECISIONS THIS PACKET ASKS FOR. Resolved from the packet row —
        // never from a map that applies to every template. `resolvePanel`
        // returns a declared panel (an admin said these ids mean these things
        // here) or a built-in one that validated cleanly against this exact
        // template, or nothing at all. See boldsignPacketPanel.js.
        const resolved = resolvePanel({ packet: tpl, fields })
        setPanelInfo(resolved)
        const seededPanelState = seedPanelState({ panel: resolved.panel, fields })

        // Any tick box the panel does NOT own stays available to the sender as
        // a plain selection, named by the words printed beside it on the page.
        // Every one starts at "leave it as the form is set up" and sends no
        // value, so opening this screen can never change a box by itself.
        const owned = panelFieldIds(resolved.panel)
        const rows  = selectionRows({ fields: fields.filter(f => isTickableField(f.type) && !owned.has(f.id)) })
        setSelectionList(rows)
        const seededSelections = seedSelectionValues(rows, { inherit: true })

        // ── THE SEED, AND THEN THE AGENT'S OWN WORK ON TOP OF IT ────────────
        // Everything above is what this deal says. `seedState` is kept as the
        // baseline the close prompt compares against, so opening this screen and
        // closing it again closes — silently, because nothing on it was theirs.
        const seedState = {
          signers:    seededSigners,
          values:     seededValues,
          selections: seededSelections,
          panelState: seededPanelState,
          inOrder:    true,
          subject:    defaultSubject,
          message:    defaultMessage,
          cc:         [],
          expiryDays: '',
        }
        setSeeded(seedState)

        // A MERGE onto that seed, never a replacement of it: the template can
        // have been edited since the save, and a value for a field BoldSign no
        // longer has would be rejected outright when the draft is created. See
        // applySavedTemplateWork.
        const merged = applySavedTemplateWork({ saved: savedRow?.work, seeded: seedState, fields, roles })
        setSavedWork(savedRow || null)
        setRestored(savedRow ? merged.restored : null)

        setSigners(merged.state.signers)
        setValues(merged.state.values)
        setSelections(merged.state.selections)
        setPanelState(merged.state.panelState)
        setInOrder(merged.state.inOrder)
        setSubject(merged.state.subject)
        setMessage(merged.state.message)
        setCc(merged.state.cc)
        setExpiryDays(merged.state.expiryDays)
        if (savedRow && merged.dropped.length) {
          console.info('[boldsign] saved template work: dropped keys the template no longer has', merged.dropped)
        }
        // OPEN WHEN THERE IS NO PANEL, and this is not cosmetic — it was a
        // regression. With a panel, these genuinely are the "other" boxes: the
        // panel presents the decisions the packet declares and this list is the
        // long tail, so collapsed is right. With NO panel (the common case until
        // a packet declares one — a built-in that cannot be verified is
        // deliberately not applied) this list is the ONLY way to tick anything,
        // and leaving it collapsed read as "the checkboxes are gone".
        // …and open it regardless when a save brought ticks back, so the agent
        // can SEE their own answers rather than take a banner's word for it.
        setShowSelections((!resolved.panel && rows.length > 0) || merged.restored.selections > 0)
      })
      // A FAILED LOAD MUST NOT LOOK LIKE A LOADED TEMPLATE. This used to fall back to
      // a single generic "Signer" row — which, next to "Roles left blank are removed
      // from this send", reads as a one-signer packet and sends as one. A listing
      // agreement that reaches only the seller because a network call failed is far
      // worse than a modal that refuses to continue and says why.
      .catch(err => {
        if (cancelled) return
        setDetails(null)
        setDetailsErr(err.message || 'The template’s roles and fields could not be read.')
        pushToast(`Couldn't load template fields: ${err.message}`, 'error')
      })
      .finally(() => { if (!cancelled) setLoadingDet(false) })
    return () => { cancelled = true }
  }, [templateId, reloadKey])

  // The panel's decisions. Kept apart from `values` because they are choices,
  // not field contents — panelTickValues() turns them into field values at send
  // time, which is what makes the radios the only place a mutex lives.
  //
  // `panelInfo` carries the panel itself, where it came from, and how it
  // validated against this template. A declared panel that no longer matches
  // its form BLOCKS the send: it was going to write a term of an agreement onto
  // a box that means something else, and there is no version of that worth
  // shipping to a client.
  const [panelInfo,  setPanelInfo]  = React.useState({ panel: null, source: null, validation: { ok: true, blocking: [], warnings: [] } })
  const [panelState, setPanelState] = React.useState({})
  const [openGroups, setOpenGroups] = React.useState({})
  // Tick boxes the panel doesn't own — tri-state, defaulting to "as the form is".
  const [selectionList, setSelectionList] = React.useState([])
  const [selections,    setSelections]    = React.useState({})
  const [showSelections, setShowSelections] = React.useState(false)

  const panel        = panelInfo.panel
  const panelBlocked = (panelInfo.validation?.blocking || []).length > 0

  // WHO SEES THE PLUMBING. This screen used to show every agent the field ids
  // and BoldSign types behind each box — `Label7 · textbox`, `CheckBox2 →
  // agent_name` — plus a button offering to reveal "12 unnamed template
  // fields". None of that is a decision an agent makes; all of it is what an
  // admin needs when a template is wrong. No agent on a competing system has
  // ever seen a field id, and "Label" is a BoldSign implementation detail that
  // had leaked as far as the person trying to send a listing agreement.
  //
  // The information is not wrong, and F-05 put it behind an admin gate on the
  // reasoning that only an admin can fix a template. REVERTED, because the gate
  // cost more than it saved: a real Appointed Agency Agreement went out with the
  // word "Label" on both client-name lines, and the readout below — the field's
  // id, its type, and the CRM token it matched — is the only thing on any screen
  // that shows a Label carrying an id nothing matched. Gating it left the agent
  // who hit the problem with no way to see it and no way to describe it, which is
  // worse than a line of jargon they can ignore.

  // WHO CAN SIGN. The deal's own people first — on a listing agreement the
  // signer is nearly always already on the deal — then agents, then the rest of
  // the address book. Everyone else is still typeable; this only stops an agent
  // retyping somebody the CRM already knows, and catches the address typo that
  // otherwise looks like a client ignoring them.
  const signerCandidates = React.useMemo(() => buildCandidates({
    dealContacts: [contact, ...(extraContacts || []), ...(sideClients?.buyerClients || []), ...(sideClients?.sellerClients || [])].filter(Boolean),
    dealAgents,
    contacts,
    agents: [],
  }), [contact, extraContacts, sideClients, dealAgents, contacts])

  const [savingContact, setSavingContact] = React.useState(false)
  // A signer who is real but not in the CRM. Offered on the row, never
  // automatic: an address book that fills itself with every one-off signer is
  // worse than one you have to click.
  const saveSignerAsContact = async ({ name, email }) => {
    setSavingContact(true)
    try {
      const parts = name.split(/\s+/)
      const { data, error } = await createSignerContact({
        first_name: parts[0] || name,
        last_name:  parts.slice(1).join(' ') || '',
        email,
        assigned_agent_id: activeAgent?.id || null,
      })
      if (error) throw error
      // Link them to the deal too — a signer who is not on the deal is a
      // contact you will have to find again by search.
      const { error: linkErr } = await linkContactToDeal(deal.id, data.id)
      if (linkErr && !/duplicate|unique/i.test(linkErr.message || '')) {
        pushToast(`Saved ${name} to contacts, but they could not be added to this deal: ${linkErr.message}`, 'info')
      } else {
        pushToast(`${name} saved to contacts and added to this deal.`, 'success')
      }
    } catch (err) {
      pushToast(`Could not save that contact: ${err.message}`, 'error')
    } finally {
      setSavingContact(false)
    }
  }

  const [showAllFields, setShowAllFields] = React.useState(false)
  const [showShared, setShowShared] = React.useState(false)
  const setValue  = (id, v)     => setValues(p => ({ ...p, [id]: v }))

  // The payload both actions below send. Returns null (having said why) when the
  // modal isn't ready — the two buttons must agree exactly on what is valid, so
  // this is built once rather than duplicated per action.
  // `quiet` suppresses the toasts and returns null instead. Save-for-later needs
  // that: a half-prepared packet with no signer yet is not an error to shout
  // about, it is the whole reason the agent is saving it for later — and the work
  // is still stored either way. `reason` names what stopped it so the one toast
  // that IS shown can say so.
  const buildArgs = ({ quiet = false, reason = null } = {}) => {
    const stop = (msg, code) => { if (reason) reason.code = code; if (!quiet) pushToast(msg, 'error'); return null }
    if (!templateId) return stop('Pick a template', 'no-template')
    const roleList = details?.roles || []
    const filled   = roleList.filter(r => (signers[r.index]?.name || '').trim() && (signers[r.index]?.email || '').trim())
    if (!filled.length) return stop('At least one signer needs a name and email', 'no-signer')
    // Caught here rather than at the API, because a malformed address is the
    // one send failure nobody ever sees: BoldSign accepts it, delivers nowhere,
    // and the document sits at "waiting" looking exactly like a client who is
    // ignoring you.
    const badEmail = filled.find(r => !isValidEmail(signers[r.index]?.email))
    if (badEmail) {
      return stop(`"${signers[badEmail.index].email}" is not a valid email address — check the ${badEmail.name} row.`, 'bad-email')
    }
    // A declared panel that no longer matches its form stops here rather than
    // writing a term onto the wrong box. The on-screen error names the field;
    // this is the belt to that braces, so neither button can slip past it.
    if (panelBlocked) {
      return stop('This form no longer matches the terms panel set up for it — see the message above. Nothing was created.', 'panel-blocked')
    }
    const missing = panelMissing({ panel, state: panelState })
    if (missing.length) return stop(`Choose ${missing.join(' and ')} first`, 'panel-missing')

    // Split the prefilled values in two — this is the whole point of Label
    // fields. `sharedFormFields` (the template's Labels) go out as ONE common,
    // read-only set that every signer sees the instant the document lands, no
    // matter who signs first; `byRole` holds the role-scoped fields, which
    // BoldSign keeps private to their own signer until that signer is done.
    // Keyed by ORIGINAL role index — buildTemplateRoles handles the index shift.
    const { sharedFormFields, byRole } = buildPrefillFields({
      fields: details.fields || [],
      // Three layers, narrowest last. `values` is everything typed;
      // `selections` is the tri-state tick boxes the panel doesn't own (a null
      // there means no value is sent and the form's own setting stands, which
      // prefillFieldEntry already understands); `panelTickValues` is the
      // packet's own declared decisions, which win. Merged at the one place
      // BOTH DOORS out of this screen build their payload from, so Review Draft
      // and Place Fields cannot disagree about what the packet says.
      values: { ...values, ...selections, ...panelTickValues({ panel, state: panelState }) },
      filledRoleIndices: filled.map(r => r.index),
    })
    // Roles + removals, with BoldSign's post-removal index shift applied — see
    // buildTemplateRoles. Leaving a middle role blank (e.g. Co-seller, with a
    // co-listing agent filled below it) used to send an index past the end of
    // the remaining list, which BoldSign rejected as a role with no signer.
    const { roles, roleRemovalIndices } = buildTemplateRoles({
      roleList, signers, fieldsByRole: byRole, inOrder,
    })

    const docName = [tpl?.name || deal?.title, streetLine(property)].filter(Boolean).join(' — ')
    const labels  = [tpl?.state, tpl?.doc_type, `deal:${deal.id}`].filter(Boolean)
    // Fields that only mean something for a co-buyer or an additional agent this
    // deal doesn't have — left blank above, and removed from the draft outright
    // so the template doesn't show them as unfilled "Label" placeholders. See
    // conditionalFieldsToRemove in boldsignFields.js.
    // Two reasons a field is removed rather than sent, and both end as one list:
    //   • it names a co-buyer or second agent this deal doesn't have
    //     (conditionalFieldsToRemove), and
    //   • it is a Label with nothing in it, which BoldSign would otherwise print
    //     on the page as the literal word "Label" (emptyLabelsToRemove).
    // The second subsumes most of the first, but the first is kept: it says WHY
    // in the code for the three fields the CRM has a token for, and a Set makes
    // the overlap free.
    // WHAT IS ACTUALLY GOING TO BOLDSIGN, in one place, before it goes. The
    // label→value step is the only part of a send that fails invisibly: a Label
    // whose id matches no CRM token looks exactly like a Label meant to be
    // blank, right up until it reaches the client as the word "Label". Grep
    // `matched: false` for an id nothing recognised, and `filled: false` for a
    // token that resolved to nothing.
    const mapping = describeFieldMapping({ fields: details.fields || [], values })
    const unmatched = mapping.filter(r => !r.matched)
    const unfilled  = mapping.filter(r => r.matched && !r.filled)
    console.info(
      `[boldsign] prepare "${tpl?.name || templateId}" — ${mapping.length} prefillable field(s): `
      + `${mapping.filter(r => r.filled).length} filled, ${unfilled.length} matched-but-empty, `
      + `${unmatched.length} matched no CRM token`,
    )
    if (mapping.length) console.table?.(mapping)
    if (unmatched.length) {
      console.warn('[boldsign] these fields matched no CRM token — they go out blank:',
        unmatched.map(r => `${r.id}${r.shared ? ' (Label)' : ''}`).join(', '))
    }
    if (unfilled.length) {
      console.warn('[boldsign] these fields matched a token that resolved to nothing:',
        unfilled.map(r => `${r.id} → ${r.token}`).join(', '))
    }

    const fieldRemovalIds = [...new Set([
      ...conditionalFieldsToRemove({ fields: details.fields || [], values }),
      ...emptyLabelsToRemove({ fields: details.fields || [], values }),
    ])]
    return {
      templateId, deal_id: deal.id, roles, roleRemovalIndices, sharedFormFields, fieldRemovalIds,
      emailSubject: subject, documentName: docName, labels,
      // Set at creation because BoldSign will not accept them later. The brand
      // is applied server-side on every send and is not the agent's to choose.
      message: message.trim() || 'Please review and sign.',
      cc,
      ...(String(expiryDays).trim() ? { expiryDays: Number(expiryDays) } : {}),
    }
  }

  // This deal's remembered arrangement was restored over the template's defaults —
  // say so, because the document will not match the blank template and that should
  // read as intentional. A partial restore reports BOTH what came back and what
  // didn't; only a total failure is an error, since a form that is mostly right is
  // worth saying out loud but is not a broken document.
  const reportLayout = (data) => {
    // BoldSign refused the locks and the send went through unlocked. Worth a
    // toast: every value is still filled in, but the guarantee the agent was
    // told about on this screen ("none can change them") no longer holds.
    if (data.readOnlyWarning) pushToast(data.readOnlyWarning, 'info')
    if (data.layoutApplied) {
      pushToast(`Restored this deal's saved field layout — ${data.layoutFieldCount} field${data.layoutFieldCount === 1 ? '' : 's'}.`, 'success')
    }
    // Never an error toast. The draft exists, is filled, and is sendable; all a
    // failed restore means is that it opened with the template's own field
    // placement, which is what every send did before layouts existed. Shown red,
    // it read as a failed send and sent the agent looking for a problem that was
    // not there.
    if (data.layoutWarning) pushToast(data.layoutWarning, 'info')
  }

  // ── SAVING WORK THAT IS NOT READY TO SEND ─────────────────────────────────
  // The screen as it stands right now, in the shape templateWork.js stores.
  const currentWork = { signers, values, selections, panelState, inOrder, subject, message, cc, expiryDays }

  // What the agent has changed since the screen seeded itself. This is what
  // decides whether closing asks — see requestClose. `seeded` is null until the
  // template has loaded, and nothing typed before that is possible.
  const edits = React.useMemo(
    () => templateWorkEdits({ current: currentWork, seeded }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signers, values, selections, panelState, inOrder, subject, message, cc, expiryDays, seeded],
  )
  const dirty = Boolean(seeded) && edits.count > 0

  // Closing the TAB or reloading bypasses every in-app guard — requestClose
  // never runs and the work is simply gone. Only beforeunload reaches that path.
  // Registered only while there is real work outstanding, so an agent who has
  // saved isn't nagged for closing their browser. (The browser shows its own
  // generic wording; the point is the pause.)
  React.useEffect(() => {
    if (!dirty) return
    const warn = (e) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  // The draft SAVE FOR LATER left on the Signatures tab, if any. A REF, not
  // state: it has to survive "start fresh" clearing the saved row, or the next
  // save would leave a second half-finished draft on the tab beside the first.
  // Never cleared by a reload — only ever pointed at a newer save.
  //
  // ONLY save-for-later drafts are tracked here, and that is the whole reason
  // this is narrower than "the last document this screen created". A draft made
  // by Review Draft or Place Fields is a document the agent deliberately asked
  // for — two of them on one deal can be two real packets for two different
  // signers — and nothing here may delete one. A save-for-later copy is by
  // definition the single latest state of one piece of unfinished work.
  const priorDocRef = React.useRef(null)
  React.useEffect(() => {
    if (savedWork?.document_id) priorDocRef.current = savedWork.document_id
  }, [savedWork])

  // ONE WORK-IN-PROGRESS DRAFT PER PACKET, not one per save. An agent who saves
  // four times over a week must not find four near-identical unsent drafts on
  // the Signatures tab — the newest is the only one that reflects what they have
  // typed, and the older ones are traps to send by mistake.
  //
  // Only ever removes a draft THIS work row created and that is still 'draft' in
  // the CRM (see isUnsentDraft): anything a signer has been told about is not
  // ours to remove on the way to saving a newer copy. Best-effort — a failure
  // leaves an extra draft, which is untidy, never lost work.
  const supersedePriorSave = async (newDocumentId) => {
    const prior = priorDocRef.current
    if (!prior || prior === newDocumentId) return
    try {
      if (!await isUnsentDraft({ dealId: deal.id, documentId: prior })) return
      await apiDeleteDocument(prior)
      console.info('[boldsign] save for later: superseded the previous saved draft', { prior, now: newDocumentId })
    } catch (err) {
      console.warn(`[boldsign] could not remove the superseded draft ${prior}: ${err.message}`)
    }
  }

  // Store the screen's own state against (deal, template). Rebaselines `seeded`
  // to what was just saved, because at that instant nothing is outstanding and
  // the close prompt must not fire on work that is safely stored.
  const persistWork = async ({ documentId = null } = {}) => {
    const row = await saveTemplateWork({
      dealId:       deal.id,
      templateId,
      templateName: tpl?.name || null,
      work:         currentWork,
      documentId:   documentId || priorDocRef.current || null,
      agentId:      activeAgent?.id || null,
    })
    if (documentId) priorDocRef.current = documentId
    setSavedWork(prev => ({ ...(prev || {}), ...(row || {}), template_id: templateId, work: currentWork }))
    setSeeded({ ...currentWork })
    setRestored(null)
    return row
  }

  // SAVE FOR LATER — the button this screen did not have.
  //
  // Two saves, in the order that matters. The agent's own answers go to the CRM
  // FIRST and unconditionally: they are the thing that was being lost, and they
  // must survive a packet too incomplete to become a document (no signer yet, a
  // term still unanswered) as well as a BoldSign outage. Then, when the packet IS
  // complete enough, the filled draft goes onto the Signatures tab — because
  // "saved" has to mean a document somebody else can find, not just a screen this
  // agent can reopen.
  const saveForLater = async () => {
    if (!templateId) { pushToast('Pick a template first.', 'error'); return false }
    setSavingWork(true)
    try {
      const reason = {}
      const args   = buildArgs({ quiet: true, reason })
      const filled = countFilledWork(currentWork)

      try { await persistWork() }
      catch (err) {
        // Nothing else is worth attempting: the typing is the point of this
        // button, and a draft saved without it would look like a success.
        pushToast(`Could not save your work on this form: ${err.message}`, 'error')
        return false
      }

      if (!args) {
        // Stored, and honest about what is missing. Named per cause, because
        // "add a signer" and "answer the term" are different next actions.
        const why = reason.code === 'no-signer'
          ? 'Add a signer and save again to put a draft on the Signatures tab.'
          : reason.code === 'bad-email'
          ? 'Fix the signer’s email address and save again to put a draft on the Signatures tab.'
          : reason.code === 'panel-missing'
          ? 'Answer the terms above and save again to put a draft on the Signatures tab.'
          : 'It is not complete enough to put a draft on the Signatures tab yet.'
        pushToast(`Saved your work on this form — reopen this template on this deal any time. ${why}`, 'success')
        onSaved()
        return true
      }

      try {
        const data = await saveTemplateDraft(args)
        reportLayout(data)
        if (data.documentId) {
          await supersedePriorSave(data.documentId)
          await persistWork({ documentId: data.documentId })
        }
        pushToast(
          'Saved — your work is kept on this template, and the filled draft is on the Signatures tab'
          + `${filled ? ` with ${filled} field${filled === 1 ? '' : 's'} filled in` : ''}. Nothing was sent.`,
          'success',
        )
        onSaved()
        return true
      } catch (err) {
        // The half that matters is already stored, so this is a warning and not
        // a failure — and it says which half went where, so an agent does not go
        // looking on the Signatures tab for something that is not there.
        pushToast(`Your work on this form is saved, but the draft could not be put on the Signatures tab: ${err.message}`, 'error')
        return false
      }
    } finally {
      setSavingWork(false)
    }
  }

  // A SENT PACKET IS NOT WORK IN PROGRESS ANY MORE. Left behind, the saved row
  // would restore last week's answers onto the next packet built from the same
  // template on this deal — and its `document_id` would point at a document that
  // has gone out, which supersedePriorSave must never touch (it wouldn't: the
  // status is no longer 'draft'). Cleared instead, on the way out.
  const finishSent = async () => {
    await clearTemplateWork({ dealId: deal.id, templateId })
    onSent()
  }

  // Closing. Silent when nothing on the screen is the agent's — the seeded
  // values are the deal's, and a confirm on every close is a confirm nobody
  // reads. With real work outstanding it asks, and offers all three answers
  // rather than folding "throw it away" into Cancel.
  const requestClose = () => {
    if (savingWork || savingDraft) return
    if (!dirty) { onClose(); return }
    setCloseAsk(true)
  }

  // Forget the save and reseed from the deal. The draft it may already have put
  // on the Signatures tab is left alone — it is a real document the agent asked
  // for — but `priorDocRef` still points at it, so the next save supersedes it
  // rather than leaving two.
  const startFresh = async () => {
    setSavingWork(true)
    try {
      await clearTemplateWork({ dealId: deal.id, templateId })
      setSavedWork(null)
      setRestored(null)
      setReloadKey(k => k + 1)
      pushToast('Started fresh — this form is filled in from the deal again.', 'info')
    } finally {
      setSavingWork(false)
    }
  }

  // REVIEW DRAFT — the one action this screen has, and a sequence rather than a
  // fork. It creates the document with every value above already written into
  // it, and then SHOWS IT: the composed packet, on screen, with adjust /
  // download / send available beside it.
  //
  // Nothing is sent. The draft is real and lives on the deal, so closing the
  // review loses nothing — the row is on the Signatures tab with the same three
  // actions. That is the whole prepare-and-print workflow, except the agent no
  // longer has to leave the screen and go find a download to see what the
  // packet says.
  // ONE STEP, TWO DESTINATIONS. Both buttons do the same first thing — create
  // the draft with every value above written into it — and then differ only in
  // where the agent lands:
  //
  //   Review Draft         → the composed packet on screen (the common case:
  //                          the form already has its fields, so the question
  //                          is "does this say the right thing")
  //   Place Fields         → straight into the embedded editor (the case where
  //                          the agent already KNOWS this deal needs a box
  //                          moved, and a review first is a detour)
  //
  // Neither sends. Both leave a real draft on the deal reachable from the
  // Signatures tab, so whichever door they pick, nothing is lost by closing.
  //
  // Kept as one function because the two paths must never disagree about what
  // gets created: same payload, same layout restore, same tracking, same send
  // options. Only the last line differs.
  const createDraft = async (destination) => {
    const args = buildArgs()
    if (!args) return
    setSavingDraft(true)
    try {
      const data = await saveTemplateDraft(args)
      reportLayout(data)
      // THE SCREEN'S OWN STATE IS SAVED HERE TOO, not just by Save for Later.
      // Reviewing a draft and closing the review used to lose the radio buttons
      // and tick boxes that produced it — the document survived, the decisions
      // behind it did not, so reopening the template to change one thing meant
      // making every choice again. Best-effort: a draft that exists must not be
      // reported as a failure because remembering the screen failed.
      //
      // The new document is deliberately NOT recorded as the supersedable
      // work-in-progress copy (see priorDocRef): the agent asked for this one,
      // and a later Save for Later must not quietly delete it.
      try { await persistWork() }
      catch (err) {
        console.warn(`[boldsign] the draft was created but this screen's state could not be saved: ${err.message}`)
      }
      if (!data.documentId) {
        pushToast('The draft was created but could not be opened — it is on the Signatures tab.', 'info')
        onSaved()
        return
      }

      if (destination === 'place') {
        // Into the editor on the draft that now exists. Reopening it (rather
        // than creating a second document through the embed path) is what keeps
        // the two routes producing identical drafts.
        const edit = await documentEditUrl({ documentId: data.documentId, redirectUrl: boldSignReturnUrl() })
        if (!edit?.url) {
          // The draft is safe. Fall through to the review rather than dead-end.
          pushToast('The draft was saved but the field editor would not open — showing it for review instead.', 'info')
        } else {
          setReview({ documentId: data.documentId, documentName: args.documentName, signers: args.roles })
          setEmbedDocId(data.documentId)
          setEmbedUrl(edit.url)
          return
        }
      }

      // The composed copy: BoldSign's own bytes with every filled value drawn
      // on and a signing summary appended (api/boldsign.js → buildPrintablePdf).
      // A failure here is NOT a failed send — the draft exists either way — so
      // the review opens regardless and says so if the pages are not ready.
      let pdf = {}
      try { pdf = await fetchDraftPreview(data.documentId) }
      catch (err) { console.warn('[boldsign] review: preview unavailable —', err.message) }
      setReview({
        documentId:   data.documentId,
        documentName: args.documentName,
        previewUrl:   pdf.previewUrl || null,
        downloadUrl:  pdf.url || null,
        fieldCount:   pdf.fieldCount || 0,
        signers:      args.roles,
      })
    } catch (err) {
      pushToast(err.message, 'error')
    } finally {
      setSavingDraft(false)
    }
  }

  // ADJUST FIELD PLACEMENT — the same draft the agent is looking at, reopened
  // in the embedded editor. Needed when the form's own placement has to change
  // for this deal (an extra initial box, a label only this county wants).
  //
  // Reached from the REVIEW step, on a draft that already exists, rather than
  // as a second button competing with "save" before anything has been created.
  // Still a draft on the other side: it sends only if the agent clicks Send in
  // there.
  // Leaving the editor: back to the review of the draft that was just adjusted.
  // The preview is re-fetched because the whole point of having been in there is
  // that the placement changed — showing the copy from before would be a lie
  // about work the agent just did. A failed re-fetch keeps the review open with
  // no preview rather than dropping them out of the flow.
  const backToReview = async () => {
    const documentId = review?.documentId || embedDocId
    setEmbedUrl(null)
    setEmbedDocId(null)
    if (!documentId) { onSaved(); return }
    let pdf = {}
    try { pdf = await fetchDraftPreview(documentId) }
    catch (err) { console.warn('[boldsign] review: preview unavailable after placement —', err.message) }
    setReview(prev => ({
      ...(prev || { documentId }),
      documentId,
      previewUrl:  pdf.previewUrl || null,
      downloadUrl: pdf.url || null,
      fieldCount:  pdf.fieldCount || prev?.fieldCount || 0,
    }))
  }

  const adjustFields = async () => {
    if (!review?.documentId) return
    setSending(true)
    try {
      const data = await documentEditUrl({ documentId: review.documentId, redirectUrl: boldSignReturnUrl() })
      if (!data?.url) { pushToast('This draft could not be reopened right now — it is safe on the Signatures tab.', 'error'); return }
      setEmbedDocId(review.documentId)
      setEmbedUrl(data.url)
    } catch (err) {
      pushToast(err.message, 'error')
    } finally {
      setSending(false)
    }
  }

  const fields     = details?.fields || []
  const textFields = fields.filter(f => isFillableField(f.type))

  // Shared (Label) fields vs signer-specific ones. The difference is not
  // cosmetic: a Label is common to the document and every signer reads it the
  // moment it arrives, while a role-scoped field stays invisible to everyone but
  // its own signer until that signer has finished. The two groups are shown
  // apart, and labelled, so nobody has to guess which one a value lands in.
  // Fields the admin never named, whose ids are BoldSign's own auto-counters
  // (`Label1`, `Checkbox2`), are folded away by default. One live agency packet
  // renders 27 such Labels and 14 such tick boxes, which buries the three fields
  // that actually matter and turns a review step into something to scroll past.
  // They are hidden, never dropped: the toggle brings every one of them back,
  // because an unnamed checkbox is still a term somebody may need to tick.
  const shown = (list) => (showAllFields ? list : list.filter(f => !isUnconfiguredField(f)))

  const sharedTextFields = shown(textFields.filter(f => isSharedField(f.type)))
  const signerTextFields = shown(textFields.filter(f => !isSharedField(f.type)))
  // The panel asks for the packet's decisions directly (Representation, Term,
  // Policy) rather than listing every tick box on the template, so there is no
  // per-box row list here any more. boldsignSelections.js still backs the
  // generic naming used elsewhere; boldsignPacketPanel.js owns this panel.
  // Only the shared fields that actually carry a value. An empty one has nothing
  // to show in a summary, and listing it as blank would invite the agent to go
  // hunting for something to type where the template simply has a spare box.
  const sharedFilled = sharedTextFields.filter(f => String(values[f.id] ?? '').trim())
  const hiddenCount = showAllFields ? 0 : textFields.filter(isUnconfiguredField).length
  // A role-scoped field can name no role at all, in which case it rides on the
  // first signer — either way it is one signer's, which is what the warning below
  // needs to say.
  const roleNameFor = (idx) => details?.roles?.find(r => r.index === Number(idx))?.name || (idx ? `Signer ${idx}` : 'one signer only')

  // Deal data sitting on a role-scoped field — the template needs fixing, and no
  // send-time payload can work around it. Named here because the agent about to
  // send is the person who will hear about the blank from the client.
  // Name fields the template is using for somebody other than their own signer.
  // Worse than the gap above and not fixable from here at all: BoldSign prints
  // the assigned signer's name and silently drops whatever we send, so the
  // document goes out with the WRONG name rather than a blank one.
  const nameMisuse = signerBoundPrefillFields({ fields, values })

  // THE ONE GAP THAT IS NEVER OK TO SHIP QUIETLY: an agreement whose client-name
  // lines are blank. The brokerage name and the appointed agent fill from a
  // constant and from the agent record, so they come through even when the deal
  // has no contact linked — which is why a page can look half-filled and leave
  // the agent concluding the CRM stopped pulling data over. Says which of the two
  // causes it is, because they have different fixes.
  const nameGaps = partyNameGaps({ fields, values })

  // Recomputed for the warning above, which names the value each misused Name
  // field was SUPPOSED to print — that is what tells an admin which Label to
  // put in its place. Same inputs as the seeding effect, and pure.
  const tokenVals = React.useMemo(() => crmTokenValues({
    deal, property, contact,
    additionalContacts: extraContacts,
    ...(sideClients || {}),
    agent:  appointedAgent({ activeAgent, dealAgents }),
    agents: orderAgentSigners({ activeAgent, dealAgents }),
    today:  new Date().toISOString().slice(0, 10),
  }), [deal, property, contact, extraContacts, sideClients, activeAgent, dealAgents])

  // Some answers make a field relevant that otherwise isn't — the fixed-date
  // term is the only one with an end date to fill in. The panel names the token
  // rather than the field, so this stays generic: a new panel adds a
  // `revealToken` and needs no code change here.
  const revealedFields = React.useMemo(() => {
    const tokens = new Set(revealedTokens({ panel, state: panelState }))
    if (!tokens.size) return []
    return (fields || []).filter(f => tokens.has(fieldTokenKey(f)))
  }, [fields, panel, panelState])

  // A declared panel whose ids no longer match the page is reported here, on
  // screen, and blocks both buttons. It used to be a console.warn nobody was
  // watching — which meant the one safety net against a template edit writing a
  // term onto the wrong box existed but never reached a person.
  React.useEffect(() => {
    for (const p of (panelInfo.validation?.blocking || [])) {
      console.error(`[boldsign] packet panel ${panelInfo.panel?.key}: ${describePanelProblem(p)}`)
    }
  }, [panelInfo])

  // What BoldSign actually calls this field, and whether it matched a CRM token.
  // A blank box used to be unreadable — "did the deal have no value, or is the
  // field named something the CRM doesn't recognise?" — and the answer lived in
  // an API response nobody could see. It is on screen now: the field's real id,
  // and the token it resolved to when it resolved to one.
  const fieldOrigin = (f) => {
    const token = fieldTokenKey(f)
    return token && normalizeTokenKey(f.id) !== token ? `${f.id} → ${token}` : String(f.id || '')
  }

  // The field's BoldSign TYPE, shown next to its id. Without this the screen
  // names fields `Label1` and `Name3` and there is no way to tell a TextBox from
  // a Company or a Name — which is exactly the distinction that decides whether
  // a value can be prefilled, whether it can be locked, and whether every signer
  // can read it. Two send-breaking bugs were diagnosed blind for want of it.
  const fieldType = (f) => String(f?.type || 'unknown')

  const renderTextField = (f) => {
    // The heading an agent actually reads: the canonical token's human name
    // first (Buyer1NameLabel → "Primary buyer's name"), since that's true for
    // every template using the account-wide convention regardless of what the
    // admin happened to type as the field's own name; then whatever the
    // template author actually captioned it; then, only for a field neither of
    // those resolves, the raw PascalCase id — which is what every one of these
    // used to show, unreadable id and all.
    const info = fieldInfo(f)
    // …and ahead of that raw id, the caption read off the PDF itself — the words
    // printed beside the field on the page (see api/_lib/pdfText.js). A template
    // nobody labelled still names its own fields this way.
    //
    // `f.name` only counts as a name when it differs from the id: BoldSign fills
    // `name` with the auto id when nobody typed one, so trusting it blindly puts
    // "Label7" ahead of the caption the page itself supplies — the exact thing
    // the caption exists to replace.
    const authored = String(f.name || '').trim()
    const named = authored && authored.toLowerCase() !== String(f.id || '').trim().toLowerCase() ? authored : ''
    const heading = info?.text || f.label || named || f.caption || prettyLabel(f.id)
    return (
    <div key={f.id} style={{ marginBottom:8 }}>
      <div style={{ fontSize:11, color:'var(--gw-mist)', marginBottom:2, display:'flex', gap:8, alignItems:'baseline' }}>
        <span style={{ flex:1 }}>
          {heading}
          {info?.optional && (
            <span style={{ marginLeft:6, fontSize:10, fontWeight:600, color:'#d4a017', border:'1px solid #d4a017', borderRadius:10, padding:'1px 6px' }}>
              optional
            </span>
          )}
        </span>
        {/* The field's id, type and matched token. Shown to everyone: it is how
            anybody notices a Label whose name matches no CRM value, which is
            exactly the failure that put the word "Label" on a signed-ready
            agreement. */}
        <span style={{ fontFamily:'var(--font-mono, monospace)', fontSize:10, opacity:0.7 }} title="The field id BoldSign uses, its type, and the CRM token it matched">
          {fieldOrigin(f)} · {fieldType(f)}
        </span>
      </div>
      {info?.optional && (
        <div style={{ fontSize:10, color:'var(--gw-mist)', marginBottom:3 }}>
          {info.optional.replace(/^./, c => c.toUpperCase())}
        </div>
      )}
      {isDateField(f)
        ? (
          <input
            className="form-control"
            type="date"
            value={usDateToIso(values[f.id] || '')}
            onChange={e => setValue(f.id, isoDateToUs(e.target.value))}
          />
        )
        : f.options?.length
        ? (
          <select className="form-control" value={values[f.id] || ''} onChange={e => setValue(f.id, e.target.value)}>
            <option value="">— signer chooses —</option>
            {f.options.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        )
        : <input className="form-control" value={values[f.id] || ''} onChange={e => setValue(f.id, e.target.value)}/>}
    </div>
    )
  }

  // A flat list of 15+ fields is what agents said was hard to read here — this
  // renders the same fields as small labelled sections instead (Buyer names,
  // Agent names, Dates, Additional Agent, …), in a fixed reading order, so
  // "which value goes where" is a sub-heading away rather than a scroll.
  const renderGroupedFields = (list) => groupFields(list).map(({ group, fields: groupedFields }) => (
    <div key={group} style={{ marginBottom:10 }}>
      <div style={{ fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.03em', color:'var(--gw-mist)', marginBottom:4 }}>
        {group}
      </div>
      {groupedFields.map(renderTextField)}
    </div>
  ))

  // The embedded placement editor. Reached either straight from the prepare
  // screen ("Place Fields") or from the review.
  //
  // CLOSING IT RETURNS TO THE REVIEW, not out of the modal: the agent has just
  // moved boxes, and seeing the result is the obvious next thing. The preview is
  // re-fetched on the way back so it shows the placement they just made rather
  // than the copy from before they opened the editor.
  if (embedUrl) {
    return (
      <BoldSignStepModal
        url={embedUrl}
        documentId={embedDocId}
        eyebrow="Adjust field placement"
        heading={review?.documentName || 'Place fields'}
        onClose={backToReview}
        onDone={() => { pushToast('Sent for signature', 'success'); finishSent() }}
        onDraft={() => pushToast('Saved — nothing has been sent yet. The draft is on this deal\u2019s Signatures tab.', 'info')}
      />
    )
  }

  // Step 2 — the packet, on screen, with every action available beside it.
  if (review) {
    return (
      <DraftReviewStep
        {...review}
        adjusting={sending}
        onAdjust={adjustFields}
        onSent={finishSent}
        onClose={onSaved}
      />
    )
  }

  return (
    // Escape and the backdrop go through requestClose for the same reason the X
    // does: they are the ways this screen was actually being closed when the
    // work went missing, and a guard only the X respects is not a guard.
    <Modal open={true} onClose={requestClose} width={520}>
      <div className="modal__head">
        <div>
          <div className="eyebrow-label">{templateStep(1)}</div>
          <h3 style={{ margin:0, fontFamily:'var(--font-display)', fontSize:20 }}>Pick &amp; Fill the Form</h3>
        </div>
        <button className="drawer__close" onClick={requestClose}><Icon name="x" size={18}/></button>
      </div>
      <div className="modal__body">
        {/* PICKED UP WHERE THEY LEFT OFF. Said out loud, with a way back to the
            deal's own values: a form that silently differs from the template is
            a form an agent cannot trust, and "why does this say that" is not a
            question to leave them holding. */}
        {restored && restored.count > 0 && (
          <div style={{ background:'var(--gw-bone)', border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', padding:'10px 12px', marginBottom:12, fontSize:12, lineHeight:1.6 }}>
            <div style={{ display:'flex', gap:8, alignItems:'baseline' }}>
              <Icon name="check" size={12} style={{ color:'var(--gw-green)', flexShrink:0 }}/>
              <span style={{ flex:1 }}>
                <strong>Picked up where you left off.</strong>{' '}
                Your saved work on this form is back
                {savedWork?.updated_at
                  ? <> — saved {new Date(savedWork.updated_at).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })}</>
                  : null}.
                {savedWork?.document_id ? ' The draft it created is on the Signatures tab.' : ''}
              </span>
            </div>
            <button type="button" className="btn btn--link btn--sm" style={{ padding:0, marginTop:4 }} onClick={startFresh} disabled={savingWork}>
              Start fresh from the deal instead
            </button>
          </div>
        )}
        <div className="form-group">
          <label className="form-label required">Template</label>
          <select className="form-control" value={templateId} onChange={e => setTemplateId(e.target.value)}>
            {visible.map(t => <option key={t.template_id} value={t.template_id}>{t.name}{t.state ? ` (${t.state})` : ''}</option>)}
          </select>
          {dealState && visible.length > 0 && (
            <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:6 }}>
              {stateFormCount
                ? `Showing ${dealState} forms and general forms.`
                : `No ${dealState} forms are set up yet — showing general forms only.`}
            </div>
          )}
          {visible.length === 0 && (
            <div style={{ fontSize:12, color:'var(--gw-ink)', marginTop:6, lineHeight:1.5 }} role="alert">
              <strong>No templates are set up for {dealState || 'this deal'} yet.</strong> Ask your admin to add one,
              or close this and use <strong>Upload Your Own PDF</strong>.
            </div>
          )}
          {/* Where this form's terms come from, and whether they still match the
              page. Small and quiet when everything is fine — but it is the line
              an admin reads before declaring a panel for a packet, and the line
              an agent reads when they wonder why a form is asking them nothing. */}
          {panel && !panelBlocked && (
            <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:4, display:'flex', alignItems:'center', gap:5 }}>
              <Icon name="check" size={11} style={{ color:'var(--gw-green)', flexShrink:0 }}/>
              <span>
                Terms below verified against this form
                {panelInfo.source === 'builtin' && ' (using Gateway\u2019s built-in setup for this packet)'}
                {(panelInfo.validation?.warnings || []).length > 0 && ` \u00b7 ${panelInfo.validation.warnings.length} box${panelInfo.validation.warnings.length === 1 ? '' : 'es'} could not be read off the page`}
              </span>
            </div>
          )}
        </div>

        <div className="form-group">
          <label className="form-label">Email Subject</label>
          <input className="form-control" value={subject} onChange={e => setSubject(e.target.value)}/>
        </div>

        {loadingDet && <div style={{ fontSize:13, color:'var(--gw-mist)', padding:'8px 0' }}>Loading template…</div>}

        {!loadingDet && detailsErr && (
          <div style={{ background:'#fff5f5', border:'1px solid var(--gw-red)', borderRadius:'var(--radius)', padding:'10px 12px', marginBottom:12, fontSize:12, lineHeight:1.6 }} role="alert">
            <strong>This template’s signers and fields could not be read, so it can’t be sent yet.</strong>
            <div style={{ color:'var(--gw-mist)', marginTop:4 }}>{detailsErr}</div>
            <button className="btn btn--secondary btn--sm" style={{ marginTop:8 }} onClick={() => setReloadKey(k => k + 1)}>
              <Icon name="refresh" size={12}/> Try again
            </button>
          </div>
        )}

        {!loadingDet && details && (
          <>
            {/* One signer input per template role; leave a role blank to omit it. */}
            <div className="form-group">
              <label className="form-label required">Signers</label>
              {details.roles.map((r, i) => (
                <SignerPicker
                  key={r.index}
                  order={r.index}
                  roleLabel={r.name}
                  color={SIGNER_COLORS[i] || '#6b7280'}
                  value={signers[r.index] || {}}
                  candidates={signerCandidates}
                  onChange={(next) => setSigners(p => ({ ...p, [r.index]: { ...(p[r.index] || {}), ...next } }))}
                  onSaveContact={saveSignerAsContact}
                  savingContact={savingContact}
                />
              ))}
              <div style={{ fontSize:11, color:'var(--gw-mist)' }}>Roles left blank are removed from this send.</div>

              <label style={{ display:'flex', alignItems:'center', gap:8, marginTop:10, padding:'8px 10px', border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', background:'var(--gw-bone)', cursor:'pointer' }}>
                <input type="checkbox" checked={inOrder} onChange={e => setInOrder(e.target.checked)} style={{ width:14, height:14, cursor:'pointer' }}/>
                <span style={{ fontSize:12, flex:1 }}>
                  <strong>Sign in this order</strong> — each signer waits for the one above.
                  <span style={{ color:'var(--gw-mist)' }}> Keep this on. Signers only see each other&rsquo;s entries
                    once the person ahead of them has signed, so sending to everyone at once means your client opens
                    the packet with the filled-in lines blank.</span>
                </span>
              </label>
            </div>

            {/* SHARED — the template's Label fields. One common copy, visible to
                every signer as soon as the document is sent (no waiting for the
                first signature) and editable by none of them. */}
            {sharedTextFields.length > 0 && (
              <div className="form-group">
                {/* COLLAPSED BY DEFAULT. These are filled from the deal and are
                    not the agent's job: presented as 30-odd open inputs they
                    read as 30 things to fill in, which is the opposite of the
                    truth and the single biggest source of confusion on this
                    screen. The summary says what will be carried, the count says
                    how much, and the detail is one click away for whoever wants
                    to check it before sending. */}
                <label className="form-label">
                  From this deal <span style={{ fontSize:11, fontWeight:400, color:'var(--gw-mist)' }}>— filled in automatically, every signer sees them straight away</span>
                </label>
                <div style={{ border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', background:'var(--gw-bone)', padding:'10px 12px' }}>
                  {sharedFilled.length === 0 && (
                    <div style={{ fontSize:12, color:'var(--gw-mist)' }}>
                      Nothing on this template matches the deal yet. Open it below to fill anything in by hand.
                    </div>
                  )}
                  {/* The deal, in the three facts worth checking before a send.
                      Everything else stays behind the link below. */}
                  {!showShared && (
                    <div style={{ fontSize:12, lineHeight:1.7 }}>
                      {[
                        ['Buyer',           tokenVals.client_names],
                        ['Appointed agent', tokenVals.agent_name],
                        ['Agreement date',  [tokenVals.agreement_month, tokenVals.agreement_day, tokenVals.agreement_year_full].filter(Boolean).join(' ')],
                      ].filter(([, v]) => String(v || '').trim()).map(([k, v]) => (
                        <div key={k} style={{ display:'flex', gap:8 }}>
                          <span style={{ color:'var(--gw-mist)', minWidth:130 }}>{k}</span>
                          <strong style={{ flex:1 }}>{v}</strong>
                        </div>
                      ))}
                    </div>
                  )}
                  {showShared && renderGroupedFields(sharedTextFields)}
                  <button
                    type="button"
                    className="btn btn--link btn--sm"
                    style={{ marginTop:6, padding:0 }}
                    onClick={() => setShowShared(v => !v)}
                  >
                    {showShared ? 'Done — hide these' : 'Review or edit shared fields'}
                  </button>
                </div>
              </div>
            )}

            {/* SIGNER-SPECIFIC — role-scoped fields. BoldSign shows each of these
                only to its own signer until that signer has finished, so anything
                the other parties need to read up front belongs above, as a Label
                in the template. */}
            {signerTextFields.length > 0 && (
              <div className="form-group">
                <label className="form-label">
                  Signer details <span style={{ fontSize:11, fontWeight:400, color:'var(--gw-mist)' }}>— each of these is visible only to the signer it belongs to until they sign</span>
                </label>
                {renderGroupedFields(signerTextFields)}
              </div>
            )}

            {/* A Name field being used for someone other than its own signer.
                This is the silent one — BoldSign accepts the value, ignores it,
                and prints the assigned signer's name instead — so it is stated
                as an outright defect in the template, with the fix. */}
            {/* A box the form fills with the SIGNER'S OWN name, being used for
                somebody else's. BoldSign accepts the value we send, ignores it,
                and prints the assigned signer's name instead — so the document
                goes out with the wrong name rather than a blank one.

                Two audiences, one defect. The agent is told what will be wrong
                on the paper, in those words, because they are the one the client
                will ask. Only an admin gets the fix, because only an admin can
                apply it — and to an agent "delete it and place a Label" is an
                instruction for a screen they have never opened. */}
            {/* Blank client-name lines. Two causes, one appearance on the page,
                different fixes — so the wording splits and only the admin half
                mentions the template. */}
            {(nameGaps.empty.length > 0 || nameGaps.noneNamed) && (
              <div style={{ background:'#fff5f5', border:'1px solid var(--gw-red)', borderRadius:'var(--radius)', padding:'10px 12px', marginBottom:12, fontSize:12, lineHeight:1.6 }} role="alert">
                {nameGaps.noneNamed ? (
                  <>
                    <strong>No box on this form is set up to print the client’s name.</strong>
                    <div style={{ marginTop:4 }}>
                      Whatever lines the form has for the client will go out blank — the CRM has the
                      name, but nothing on this template asks for it. You can still type it in below
                      if a box is offered.
                    </div>
                    <div style={{ marginTop:6, color:'var(--gw-mist)' }}>
                      To fix it: name a <strong>Label</strong> on the template <code>client_names</code>
                      {' '}(or <code>party_buyer_1</code> / <code>party_seller_1</code> for a single line each).
                    </div>
                  </>
                ) : (
                  <>
                    <strong>
                      The client’s name will be blank in {nameGaps.empty.length === 1 ? 'one place' : `${nameGaps.empty.length} places`}.
                    </strong>
                    <div style={{ marginTop:4 }}>
                      This form asks for the client’s name and this deal has nobody to put there —
                      link the client as a <strong>contact on the deal</strong> and reopen this
                      screen, or type the name into the box below. The brokerage and agent names
                      fill in from elsewhere, which is why the rest of the page looks complete.
                    </div>
                  </>
                )}
              </div>
            )}

            {nameMisuse.length > 0 && (
              <div style={{ background:'#fff5f5', border:'1px solid var(--gw-red)', borderRadius:'var(--radius)', padding:'10px 12px', marginBottom:12, fontSize:12, lineHeight:1.6 }} role="alert">
                <strong>This form will print the wrong name in {nameMisuse.length === 1 ? 'one place' : `${nameMisuse.length} places`}.</strong>
                <div style={{ color:'var(--gw-mist)', marginTop:4 }}>
                  {nameMisuse.length === 1 ? 'One box on this form' : `${nameMisuse.length} boxes on this form`} always print
                  the name of whoever signs there, so {nameMisuse.length === 1 ? 'it cannot' : 'they cannot'} be filled from
                  this deal:
                </div>
                <ul style={{ margin:'6px 0 0', paddingLeft:18, color:'var(--gw-mist)' }}>
                  {nameMisuse.map(f => {
                    const token = fieldTokenKey(f)
                    const want  = token ? tokenVals[token] : ''
                    return (
                      <li key={f.id}>
                        \u201c{f.caption || f.label || f.name || prettyLabel(f.id)}\u201d — will show {roleNameFor(f.roleIndex)}\u2019s name
                        {want ? <>, not \u201c{want}\u201d</> : ''}
                        {token ? <> <code style={{ fontSize:10 }}>{f.id} \u2192 {token}</code></> : ''}
                      </li>
                    )
                  })}
                </ul>
                <div style={{ color:'var(--gw-mist)', marginTop:6 }}>
                  {/* Both halves, to everyone. The workaround is what the agent
                      needs right now; the template fix is what stops it
                      recurring, and an agent who can read it is an agent who can
                      tell their admin precisely what to change. */}
                  <>You can still send this — just correct those lines by hand on the printed copy.
                     To fix it for good: delete each of these in the template and place a <strong>Label</strong> in
                     the same spot (BoldSign cannot change a placed field\u2019s type), naming the Label after the
                     token above so it fills automatically. A Label is also read by every signer immediately,
                     whatever the signing order.</>
                </div>
              </div>
            )}

            {/* The one problem this modal cannot fix from here: shared deal data
                the template put on a role's own field. Say which fields, and say
                what it means, rather than letting a client find the blank. */}
            {/* The role-visibility warning is deliberately not rendered here. It
                named signer roles ("Buyer's Agent") and described BoldSign's
                reveal order — true, and not a decision the sender makes on this
                screen. sharedGaps is still computed and still drives the
                template-defect reporting elsewhere. */}

            {/* THE PACKET'S OWN DECISIONS. Rendered from the panel declared
                for THIS packet (form_packets.signing_panel, migration 0043) —
                never from a map applied to every template. A choice group is
                radios, so the mutex is structural: picking one is picking
                against the other, and there is no state in which both or
                neither are set for the sender to reconcile. */}

            {/* A declared panel that no longer matches its form. Blocking, and
                said in the terms an agent can act on: which decision, which box,
                and what the page actually says there. The alternative is writing
                a term of an agreement onto a box that means something else. */}
            {panelBlocked && (
              <div style={{ background:'#fff5f5', border:'1px solid var(--gw-red)', borderRadius:'var(--radius)', padding:'10px 12px', marginBottom:12, fontSize:12, lineHeight:1.6 }} role="alert">
                <strong>This form no longer matches the terms set up for it, so it can&rsquo;t be sent.</strong>
                <div style={{ color:'var(--gw-mist)', marginTop:4 }}>
                  The boxes below are what this packet ticks when you choose a term. One of them has moved or changed
                  meaning in BoldSign, and sending now would lock the wrong term onto the agreement:
                </div>
                <ul style={{ margin:'6px 0 0', paddingLeft:18, color:'var(--gw-mist)' }}>
                  {panelInfo.validation.blocking.map((prob, i) => <li key={`${prob.fieldId}-${i}`}>{describePanelProblem(prob)}</li>)}
                </ul>
                <div style={{ color:'var(--gw-mist)', marginTop:6 }}>
                  Ask an admin to re-check this packet in the Form Library against the form in BoldSign. Nothing has been
                  created and nothing has been sent.
                </div>
              </div>
            )}

            {panel && !panelBlocked && panel.groups.filter(g => g.kind !== 'fixed').map(g => {
              // CHOICE — the decisions the packet cannot go out without.
              if (g.kind === 'choice') return (
                <div className="form-group" key={g.key}>
                  <label className={`form-label${g.required ? ' required' : ''}`}>{g.label}</label>
                  {g.help && <div style={{ fontSize:11, color:'var(--gw-mist)', marginBottom:4 }}>{g.help}</div>}
                  {g.options.map(o => (
                    <label key={o.key} style={{ display:'flex', alignItems:'center', gap:8, fontSize:13, marginBottom:4, fontWeight:400, cursor:'pointer' }}>
                      <input
                        type="radio"
                        name={`gw-panel-${g.key}`}
                        checked={panelState[g.key] === o.key}
                        onChange={() => setPanelState(p => ({ ...p, [g.key]: o.key }))}
                      />
                      {o.label}
                    </label>
                  ))}
                  {/* A field an answer makes relevant — the end date on a
                      fixed-date term — appears with the answer that needs it. */}
                  {revealedFields.length > 0 && g.options.some(o => o.revealToken && panelState[g.key] === o.key) && (
                    <div style={{ marginTop:6 }}>{revealedFields.map(renderTextField)}</div>
                  )}
                </div>
              )

              // TOGGLES — state, not a decision. Closed by default because the
              // packet is authored with these set and a sender changing them is
              // the exception; the values are still shown while closed, because
              // "what is this agreement saying" is worth reading at a glance.
              const open = Boolean(openGroups[g.key])
              const map  = panelState[g.key] || {}
              return (
                <div className="form-group" key={g.key}>
                  <button
                    type="button"
                    className="btn btn--link btn--sm"
                    style={{ padding:0 }}
                    onClick={() => setOpenGroups(p => ({ ...p, [g.key]: !p[g.key] }))}
                    aria-expanded={open}
                  >
                    {g.label} {open ? '▾' : '▸'}
                  </button>
                  {open && g.help && <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:4 }}>{g.help}</div>}
                  <div style={{ fontSize:12, lineHeight:1.7, marginTop:4 }}>
                    {g.options.map(o => {
                      const on = map[o.fieldId] == null ? o.default : Boolean(map[o.fieldId])
                      return (
                        <div key={o.fieldId} style={{ display:'flex', alignItems:'center', gap:8 }}>
                          <span style={{ color:'var(--gw-mist)', minWidth:130 }}>{o.label}</span>
                          {open
                            ? (
                              <label style={{ display:'flex', alignItems:'center', gap:6, fontWeight:400, cursor:'pointer' }}>
                                <input
                                  type="checkbox"
                                  checked={on}
                                  onChange={e => setPanelState(p => ({ ...p, [g.key]: { ...(p[g.key] || {}), [o.fieldId]: e.target.checked } }))}
                                />
                                {on ? 'on' : 'off'}
                              </label>
                            )
                            : <strong>{on ? 'on' : 'off'}</strong>}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}

            {/* EVERY TICK BOX THE PANEL DOES NOT OWN. Each starts at "as the form
                is set up" — sending no value, leaving the form's own setting
                alone — which is what makes opening this screen safe on a template
                nobody has configured: it cannot change a box by itself.
                Collapsed only when a panel is presenting the packet's declared
                decisions; with no panel these are the only boxes there are, and
                hiding them behind a disclosure read as losing them. */}
            {selectionList.length > 0 && (
              <div className="form-group">
                <button
                  type="button"
                  className="btn btn--link btn--sm"
                  style={{ padding:0 }}
                  onClick={() => setShowSelections(v => !v)}
                  aria-expanded={showSelections}
                >
                  {panel ? 'Other boxes' : 'Boxes'} on this form ({selectionList.length}) {showSelections ? '▾' : '▸'}
                </button>
                {showSelections && (
                  <div style={{ border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', background:'var(--gw-bone)', padding:'10px 12px', marginTop:6 }}>
                    <div style={{ fontSize:11, color:'var(--gw-mist)', marginBottom:8 }}>
                      Named from the words printed beside each box. Leave one alone and the form keeps whatever it was
                      built with; tick or clear one and it goes out that way, locked, for every signer.
                    </div>
                    {selectionList.map(row => (
                      <div key={row.id} style={{ display:'flex', alignItems:'center', gap:8, marginBottom:6 }}>
                        <span style={{ flex:1, fontSize:12.5, minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }} title={row.caption || row.id}>
                          {row.title}
                          <span style={{ color:'var(--gw-mist)' }}> · p{row.page}</span>
                        </span>
                        <select
                          className="form-control"
                          style={{ width:'auto', fontSize:12, padding:'3px 8px' }}
                          value={selections[row.id] === true ? 'yes' : selections[row.id] === false ? 'no' : ''}
                          onChange={e => {
                            const v = e.target.value === 'yes' ? true : e.target.value === 'no' ? false : null
                            setSelections(prev => applySelection(prev, selectionList, row.id, v))
                          }}
                        >
                          <option value="">As the form is</option>
                          <option value="yes">Checked</option>
                          <option value="no">Unchecked</option>
                        </select>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* The escape hatch stays for everyone — a box nobody named is still
                a box somebody may need to fill on the one deal that needs it —
                but the wording is the agent's, not the template author's. Only
                an admin is told WHY these are unnamed and what to do about it,
                because only an admin can go and name them. */}
            {hiddenCount > 0 && !showAllFields && (
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                style={{ width:'100%', marginBottom:12 }}
                onClick={() => setShowAllFields(true)}
              >
                Show {hiddenCount} more box{hiddenCount === 1 ? '' : 'es'} on this form
              </button>
            )}
            {showAllFields && (
              <div style={{ fontSize:11, color:'var(--gw-mist)', marginBottom:12 }}>
                Showing every box on this form, including the ones the page gives no name to.
                {' Name a field in BoldSign\u2019s template editor (a CRM token, or just a caption) and it will show here by default.'}{' '}
                <button type="button" className="btn btn--link btn--sm" onClick={() => setShowAllFields(false)}>Show fewer</button>
              </div>
            )}
          </>
        )}

        {/* SEND OPTIONS — collapsed, because the defaults are right for almost
            every packet. Open when this one is different: a lender who needs a
            copy, a term sheet that should lapse in a week, a note to the
            client. All three are fixed at creation by BoldSign and cannot be
            added later, which is why they are on this screen. */}
        <div className="form-group">
          <button
            type="button"
            className="btn btn--link btn--sm"
            style={{ padding:0 }}
            onClick={() => setShowOptions(v => !v)}
            aria-expanded={showOptions}
          >
            Send options {showOptions ? '▾' : '▸'}
          </button>
          {!showOptions && (
            <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:3 }}>
              Gateway branding{cc.length ? ` · copy to ${cc.length}` : ''}
              {String(expiryDays).trim() ? ` · expires in ${expiryDays} days` : ' · no expiry'}
            </div>
          )}
          {showOptions && (
            <div style={{ border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', background:'var(--gw-bone)', padding:'12px', marginTop:6 }}>
              <div style={{ marginBottom:12 }}>
                <label className="form-label">Note to the signers</label>
                <textarea
                  className="form-control"
                  rows={2}
                  value={message}
                  onChange={e => setMessage(e.target.value)}
                  placeholder="Please review and sign."
                />
                <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:3 }}>
                  Appears in the email your client receives.
                </div>
              </div>

              <div style={{ marginBottom:12 }}>
                <label className="form-label">Send a copy to</label>
                {cc.length > 0 && (
                  <div style={{ display:'flex', flexWrap:'wrap', gap:6, marginBottom:6 }}>
                    {cc.map(e => (
                      <span key={e} style={{ display:'inline-flex', alignItems:'center', gap:6, padding:'3px 8px', background:'#fff', border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', fontSize:12 }}>
                        {e}
                        <button type="button" onClick={() => setCc(p => p.filter(x => x !== e))} aria-label={`Remove ${e}`}
                          style={{ border:'none', background:'none', cursor:'pointer', padding:0, lineHeight:0, color:'var(--gw-mist)' }}>
                          <Icon name="x" size={10}/>
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <input
                  className="form-control"
                  placeholder="Transaction coordinator, attorney, lender…"
                  value={ccInput}
                  onChange={e => setCcInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addCc(ccInput) } }}
                  onBlur={() => addCc(ccInput)}
                />
                {agentsNotCopied.length > 0 && (
                  <button
                    type="button"
                    className="btn btn--link btn--sm"
                    style={{ padding:0, marginTop:6, fontSize:11 }}
                    onClick={() => setCc(p => [...p, ...agentsNotCopied.map(a => a.email)])}
                    title="Adds the deal's agents as BoldSign CC recipients, so BoldSign emails them the completed document directly."
                  >
                    + Copy the {agentsNotCopied.length === 1 ? 'agent' : 'agents'} on this deal
                    {' '}({agentsNotCopied.map(a => a.name || a.email).join(', ')})
                  </button>
                )}
                <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:3 }}>
                  They get the completed copy without being asked to sign. Press Enter after each address.
                  {' '}Copying the deal&rsquo;s own agents is optional — the CRM already emails them the signed
                  PDF the moment it completes, and a CC here is visible to every signer.
                </div>
              </div>

              <div>
                <label className="form-label">Expires after</label>
                <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                  <input
                    className="form-control"
                    style={{ width:90 }}
                    inputMode="numeric"
                    placeholder="—"
                    value={expiryDays}
                    onChange={e => setExpiryDays(e.target.value.replace(/[^\d]/g, ''))}
                  />
                  <span style={{ fontSize:12, color:'var(--gw-mist)' }}>days · leave blank for no expiry</span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* WHAT THE BUTTONS DO, as a list an agent can scan. It was one dense
            paragraph, and the line that matters most — nothing is sent from
            this screen — was the one new agents kept asking about. */}
        <div style={{ fontSize:12, color:'var(--gw-mist)', padding:'2px 2px', lineHeight:1.6 }}>
          <strong style={{ color:'var(--gw-ink)' }}>Nothing is sent from this screen.</strong> Next you will see the
          filled form and choose to send it.
          <ul style={{ margin:'6px 0 0', paddingLeft:18 }}>
            <li><strong>Next: Review Draft</strong> — see the filled form exactly as signers will (the usual next step).</li>
            <li><strong>Place Fields in BoldSign</strong> — only if you need to move or add signature boxes first.</li>
            <li><strong>Save for Later</strong> — keep everything on this screen and finish another time.</li>
          </ul>
          <div style={{ marginTop:6 }}>
            Fill values in <em>here</em>, not on the placement screen: anything typed there is a preview and never
            reaches the signers.
          </div>
        </div>
      </div>
      <div className="modal__foot">
        <button className="btn btn--secondary" onClick={requestClose} disabled={savingWork || savingDraft}>Cancel</button>
        {/* SAVE FOR LATER — a packet an agent is working on that is not needed
            yet. It was the missing third answer on this screen: every other
            button was a step toward sending, so "I'll finish this on Thursday"
            had no button and closing threw the work away. */}
        <button
          className="btn btn--secondary"
          onClick={saveForLater}
          disabled={savingWork || savingDraft || loadingDet || Boolean(detailsErr) || !details}
          title="Keep this form as it stands — the boxes you ticked and the values you filled in — and leave the filled draft on the Signatures tab. Nothing is sent."
        >
          {savingWork ? 'Saving…' : 'Save for Later'}
        </button>
        {/* TWO ROUTES INTO THE SAME DRAFT, not two ways to create one. Both
            buttons run the identical creation step and then land somewhere
            different — review the packet, or go straight to moving fields.
            Review is primary because most forms already have their fields and
            the question is whether the wording is right; placement is the
            detour an agent takes when they already know this deal needs a box
            moved. Sending is on the other side of either. */}
        <button
          className="btn btn--secondary"
          onClick={() => createDraft('place')}
          disabled={sending || savingDraft || loadingDet || Boolean(detailsErr) || !details || panelBlocked}
          title="Save the draft and open it in BoldSign to move, add or remove where people sign and fill — nothing is sent"
        >
          {savingDraft ? 'Preparing…' : 'Place Fields in BoldSign'}
        </button>
        <button
          className="btn btn--primary"
          onClick={() => createDraft('review')}
          disabled={sending || savingDraft || loadingDet || Boolean(detailsErr) || !details || panelBlocked}
          title="Fill this form in from the deal and show it to you — nothing is sent"
        >
          {savingDraft ? 'Preparing…' : 'Next: Review Draft'}
        </button>
      </div>

      {/* THREE ANSWERS, because there are three. Save the work, throw it away,
          or go back to it — and the one that used to happen on every X was the
          middle one, chosen by nobody. Naming what is at stake (a count of the
          agent's own changes, not "unsaved changes") is what makes Discard a
          button somebody can press deliberately. */}
      {closeAsk && (
        <ConfirmDialog
          eyebrow="Send from Template"
          title="Save what you have done on this form?"
          confirmLabel="Save for Later"
          busyLabel="Saving…"
          confirmVariant="btn--primary"
          cancelLabel="Keep editing"
          busy={savingWork}
          onCancel={() => setCloseAsk(false)}
          onConfirm={saveForLater}
          extraAction={{
            label: 'Discard changes',
            variant: 'btn--danger',
            onClick: () => { setCloseAsk(false); onClose() },
          }}
          message={
            <>
              <p style={{ margin:'0 0 10px', color:'var(--gw-ink)' }}>
                You have changed {describeTemplateWorkEdits(edits) || 'this form'} on this packet.
              </p>
              <p style={{ margin:'0 0 10px' }}>
                <strong style={{ color:'var(--gw-ink)' }}>Save for Later</strong> keeps this screen exactly as it is —
                reopen this template on this deal and it comes back — and leaves the filled draft on the Signatures
                tab. Nothing is sent either way.
              </p>
              <p style={{ margin:0 }}>
                <strong style={{ color:'var(--gw-ink)' }}>Discard changes</strong> throws away what you have changed
                here{savedWork ? ' since your last save' : ''}.
              </p>
            </>
          }
        />
      )}
    </Modal>
  )
}
