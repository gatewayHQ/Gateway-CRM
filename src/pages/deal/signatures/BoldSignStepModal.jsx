import React from 'react'
import { captureLayout, fileDocumentToDeal } from '../../../lib/services/boldsign.js'
import BoldSignFrame from '../../../components/BoldSignFrame.jsx'
import { openPrintTab, closePrintTab } from '../../../lib/savePdf.js'
import { Icon, Modal, ConfirmDialog, pushToast } from '../../../components/UI.jsx'
import { printBoldSignDocument, saveBoldSignDocumentPdf } from './boldsignDocs.js'

// ── Embedded BoldSign step (prepare a new send, or edit an existing draft) ───
// One shell for every in-app BoldSign screen, because they all share the same
// failure mode: the iframe holds field placement the agent is part-way through,
// and Modal closes on a backdrop click or Escape with no warning. A click a few
// pixels outside the frame threw that work away, and the resulting draft had no
// way back into it. So closing always asks first, and always says where the work
// went — and the frame stays mounted through a draft save, since saving a draft
// mid-prep means the agent is still working.
//
// It is also where a deal's FIELD LAYOUT gets saved. Placement happens inside
// BoldSign's iframe, on another origin, so the app cannot watch the agent drag a
// field — it can only ask BoldSign afterwards what the document ended up holding.
// Every way an editing session can end (saved, sent, closed) therefore triggers a
// capture, which stores the arrangement against the deal so the NEXT packet built
// from the same template opens already arranged. See captureFieldLayout() in
// api/boldsign.js.
export function BoldSignStepModal({ url, documentId, eyebrow, heading, onClose, onDone, onDraft, onLayoutSaved, returnUrlMarker = 'boldsign-return' }) {
  const [savingLayout, setSavingLayout] = React.useState(false)
  const [savingPdf,    setSavingPdf]    = React.useState(false)
  const [printing,     setPrinting]     = React.useState(false)
  const [filing,       setFiling]       = React.useState(false)
  const [leaveAsk,     setLeaveAsk]     = React.useState(false)
  // Work may exist that BoldSign hasn't been told to save. Set when focus enters the
  // editor (see BoldSignFrame's onInteract — the only honest cross-origin signal),
  // cleared when BoldSign reports a save, because at that instant nothing is
  // outstanding. This is what keeps the leave prompt meaningful: an agent who opened
  // the editor and immediately closed it is not warned about losing nothing.
  //
  // IT UNDER-REPORTS AFTER THE FIRST SAVE. `onInteract` rides our window's BLUR,
  // which fires when focus moves INTO the frame — once. Keep typing in there after
  // a save and focus never leaves, so no second blur fires and this flag stays
  // false while real work piles up.
  //
  // That is tolerable for what it is still used for — the leave prompt and
  // beforeunload, where a false negative means one missing warning — and it is
  // exactly why it must NOT gate Save PDF, Print or Save to Deal. A flag that
  // cannot see the work it is guarding can only block honest presses; see the note
  // below on the confirm that used to sit in front of them.
  const [unsaved,      setUnsaved]      = React.useState(false)
  const [lastSavedAt,  setLastSavedAt]  = React.useState(null)
  // WHAT USED TO BE HERE, AND WHY IT IS GONE. `everFocused` (has focus ever
  // entered the editor?) gated a "Saved everything inside BoldSign?" confirm in
  // front of Save PDF, Print and Save to Deal, and `unsaved` blocked them
  // outright with an error toast telling the agent to click Save inside BoldSign
  // first.
  //
  // Both assumed a Save button was there to click. In BoldSign's PREVIEW there is
  // not one: the agent has to Exit preview, go back to field placement, save, and
  // come back — so the guard's advice was to start over, in front of the button
  // they had just pressed. `everFocused` was never cleared either, so from the
  // second interaction onward the confirm fired unconditionally and asked a
  // question nobody could answer: what is inside a cross-origin frame is not
  // observable from here, by the agent or by us.
  //
  // A guard that fires every time and cannot be answered is not a safety feature,
  // it is a wall. The copy is built and the TRUTH IS REPORTED instead — the field
  // count that actually came back, and the time of BoldSign's last save. An agent
  // who sees "9 fields included" on a packet they filled with thirty knows to save
  // and rebuild, which is the judgement the confirm was asking them to make blind.
  //
  // `unsaved` stays, for the two places it is still honest: the leave prompt and
  // beforeunload, where the question is "might work be lost" rather than "is this
  // copy current".
  // Set before an async close so a late unmount can't push state into a dead
  // component (React logs that as a leak, and it hides real errors).
  const alive = React.useRef(true)
  React.useEffect(() => () => { alive.current = false }, [])

  // Closing the TAB, reloading, or navigating away entirely bypasses every in-app
  // guard — the modal's confirm never runs and the work is simply gone. Only
  // beforeunload reaches that path. The browser shows its own generic wording (all
  // of them ignore a custom message now), which is fine: the point is the pause.
  // Registered only while work is plausibly outstanding, so an agent who has saved
  // isn't nagged for closing their browser.
  React.useEffect(() => {
    if (!unsaved) return
    const warn = (e) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [unsaved])

  // Ask BoldSign what this document now holds and store it on the deal.
  // `silent` suppresses the "nothing to save" chatter for automatic captures —
  // an agent who placed no fields doesn't need to be told about a subsystem.
  const saveLayout = async ({ silent = false } = {}) => {
    if (!documentId) return
    if (alive.current) setSavingLayout(true)
    try {
      const res = await captureLayout(documentId)
      // The client half of the save-path log (the server logs the same documentId
      // — see boldsign.layout-capture in api/boldsign.js). Between the two, a
      // "nothing was saved" report can be traced without reproducing it.
      console.info('[boldsign] layout capture', { documentId, silent, ...(res || {}) })
      if (res?.saved) { setLastSavedAt(new Date()) }
      if (res?.saved && res.fieldCount) {
        pushToast(`Field layout saved for this deal — ${res.fieldCount} field${res.fieldCount === 1 ? '' : 's'} will come back next time.`, 'success')
        onLayoutSaved?.(res)
      } else if (res?.unavailable) {
        // Provisioning, not a failure — but the agent should know why this deal
        // will not remember anything, and who can fix it.
        pushToast(`Field layouts are not stored yet — ${res.reason}`, 'info')
      } else if (!silent) {
        pushToast(res?.reason
          ? `Field layout not saved: ${res.reason}`
          : 'No fields to save yet — place fields in BoldSign and they will be remembered for this deal.', 'info')
      }
    } catch (err) {
      // Never fatal: the document itself is fine, only the convenience of
      // remembering its layout is lost, and the agent should know that.
      pushToast(`Could not save this deal's field layout: ${err.message}`, 'error')
    } finally {
      if (alive.current) setSavingLayout(false)
    }
  }

  // Deliberately available the whole time the editor is open — including while
  // BoldSign's own Preview is showing — because "let me take this to the client on
  // paper" is a step BEFORE deciding to send, not after.
  //
  // The copy is built from what BOLDSIGN holds, which is what its Save button has
  // written — values typed in the frame and not yet saved there cannot reach the
  // server. So an agent with outstanding work is told, rather than handed a PDF
  // that quietly misses the last thing they typed.
  // Every one of the three actions below composes from BoldSign's SAVED copy, and
  // none of them can see whether the agent has typed since. So each says what it
  // actually got. A field count that looks too low, or a save time from before the
  // last ten minutes of work, is the signal to save in BoldSign and do it again —
  // and it is a signal the agent can act on, unlike a confirm dialog asking them to
  // certify something they cannot check.
  const asOf = () => lastSavedAt
    ? ` (as of BoldSign's save at ${lastSavedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })})`
    : ''

  const savePdf = async () => {
    if (!documentId) { pushToast('This document has to exist in BoldSign before it can be saved as a PDF.', 'info'); return }
    setSavingPdf(true)
    try {
      console.info('[boldsign] save PDF: composing from BoldSign\u2019s saved copy', { documentId, lastSavedAt })
      const res = await saveBoldSignDocumentPdf(documentId)
      console.info('[boldsign] save PDF: composed', { documentId, fieldCount: res.fieldCount })
      pushToast(res.fieldCount
        ? `PDF saved \u2014 ${res.fieldCount} field${res.fieldCount === 1 ? '' : 's'} included${asOf()}.`
        : `PDF saved \u2014 no filled fields came back${asOf()}. If that looks wrong, save inside BoldSign and try again.`,
        res.fieldCount ? 'success' : 'info')
    } catch (err) {
      pushToast(`Could not save the PDF: ${err.message}`, 'error')
    } finally {
      setSavingPdf(false)
    }
  }

  // PRINT — the same composed copy, opened in a tab the agent can print from.
  const printPdf = async () => {
    if (!documentId) { pushToast('This document has to exist in BoldSign before it can be printed.', 'info'); return }
    // OPENED HERE, synchronously, while this is still the click the agent made.
    // Everything below is asynchronous, and a tab opened after an await is a
    // pop-up as far as the browser is concerned.
    const tab = openPrintTab()
    setPrinting(true)
    try {
      console.info('[boldsign] print: opening the composed copy', { documentId, lastSavedAt })
      await printBoldSignDocument(documentId, tab)
    } catch (err) {
      closePrintTab(tab)
      pushToast(`Could not open a printable copy \u2014 ${err.message}.`, 'error')
    } finally {
      setPrinting(false)
    }
  }

  // SAVE TO THE DEAL — the same composed copy, filed in the CRM instead of
  // downloaded. Save PDF puts the packet on the agent's own machine and leaves the
  // deal with no record of a document the CRM itself built; this is the half that
  // was missing.
  const fileToDeal = async () => {
    if (!documentId) { pushToast('This document has to exist in BoldSign before it can be filed on the deal.', 'info'); return }
    setFiling(true)
    try {
      console.info('[boldsign] save to deal: filing BoldSign\u2019s saved copy as a draft', { documentId, lastSavedAt })
      const res = await fileDocumentToDeal(documentId)
      // The final draft written to the deal, named. Pairs with the server's
      // boldsign.file line (same documentId) for the whole picture.
      console.info('[boldsign] save to deal: filed', { documentId, path: res.path, filename: res.filename, fieldCount: res.fieldCount })
      pushToast(res.fieldCount
        ? `Filed on this deal \u2014 ${res.fieldCount} field${res.fieldCount === 1 ? '' : 's'} included${asOf()}. Find it in the Documents tab.`
        : `Filed on this deal \u2014 no filled fields came back${asOf()}. If that looks wrong, save inside BoldSign and file it again.`,
        res.fieldCount ? 'success' : 'info')
    } catch (err) {
      pushToast(`Could not file it on the deal: ${err.message}`, 'error')
    } finally {
      setFiling(false)
    }
  }

  // Escape, the backdrop and the X all land here. With nothing outstanding this just
  // closes — the draft is safe in BoldSign either way, and a confirm on every close
  // is a confirm nobody reads. With work outstanding it asks, in the words the
  // situation deserves.
  const requestClose = () => {
    if (leaveAsk) return          // already asking; a second Escape must not re-ask
    if (!unsaved) { leaveNow({ silent: true }); return }
    setLeaveAsk(true)
  }

  // Capture BEFORE unmounting the frame: once the modal is gone the agent has no way
  // to trigger this, and the arrangement they just built is the thing worth keeping.
  // This is the "persist what can be persisted" half of leaving — whatever BoldSign
  // reports as placed is stored against the deal on the way out.
  const leaveNow = async ({ silent = false } = {}) => {
    setSavingLayout(true)
    await saveLayout({ silent })
    setLeaveAsk(false)
    onClose()
  }

  return (
    // Workspace-sized (see .modal--workspace): ~95% of the viewport, because this is
    // a document being read and arranged, not a form being filled in. The old 900 ×
    // 640 box rendered a US Letter page small enough that agents were zooming
    // BoldSign in and then scrolling a page they could only see a third of at a
    // time. `width={null}` hands sizing to CSS — an inline width would override the
    // class and its phone fallback.
    <Modal open={true} onClose={requestClose} width={null} className="modal--workspace">
      <div className="modal__head">
        <div style={{ minWidth: 0 }}>
          <div className="eyebrow-label">{eyebrow}</div>
          <h3 style={{ margin:0, fontFamily:'var(--font-display)', fontSize:20, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{heading}</h3>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:8, flexShrink:0 }}>
          <button
            className="btn btn--secondary btn--sm"
            onClick={savePdf}
            disabled={savingPdf || !documentId}
            title="Download this document as a PDF — every filled value, plus a summary of who signs what"
          >
            <Icon name="document" size={13}/> {savingPdf ? 'Preparing…' : 'Save PDF'}
          </button>
          <button
            className="btn btn--secondary btn--sm"
            onClick={printPdf}
            disabled={printing || !documentId}
            title="Open this document in a new tab and print it from there \u2014 every filled value, no draft watermark"
          >
            <Icon name="document" size={13}/> {printing ? 'Opening\u2026' : 'Print'}
          </button>
          <button
            className="btn btn--secondary btn--sm"
            onClick={fileToDeal}
            disabled={filing || !documentId}
            title="File this document on the deal — it appears in the deal's Documents tab, filled values included"
          >
            <Icon name="upload" size={13}/> {filing ? 'Filing…' : 'Save to Deal'}
          </button>
          <button
            className="drawer__close"
            onClick={requestClose}
            disabled={savingLayout}
            title={savingLayout ? 'Saving this deal’s field layout…' : 'Close BoldSign'}
          >
            <Icon name="x" size={18}/>
          </button>
        </div>
      </div>
      <div className="modal__body">
        <BoldSignFrame
          fill
          url={url}
          onInteract={() => setUnsaved(true)}
          onDone={(e) => { setUnsaved(false); saveLayout({ silent: true }); onDone?.(e) }}
          // Saved-as-draft is NOT sent. Reporting it as sent (which is what
          // happened when both events shared one handler) left the agent
          // believing the client had the document. It IS the natural moment to
          // record the layout, though — the agent explicitly saved their work.
          // A BoldSign save means nothing is outstanding as of THIS INSTANT — and
          // only this instant. It cannot tell us about the next keystroke, because
          // focus is already inside the frame and our blur will not fire again.
          // That uncertainty is now REPORTED (the save time rides along with every
          // toast, and shows in the footer) rather than used to block a button.
          onDraft={(e) => {
            // BoldSign has confirmed a save. This is the only moment the CRM can
            // be certain its saved copy matches what the agent typed, so it is
            // worth a log line: it is what "Save to Deal filed an empty document"
            // is diagnosed against.
            console.info('[boldsign] BoldSign reported a save', { documentId, event: e })
            setUnsaved(false); setLastSavedAt(new Date()); saveLayout(); onDraft?.(e)
          }}
          onError={() => pushToast('BoldSign reported the send was cancelled — the draft is still on this deal.', 'info')}
          returnUrlMarker={returnUrlMarker}
        />
      </div>
      {/* flexShrink:0 — the body is flex:1 and would otherwise squeeze this hint
          (and its saving state) down to nothing on a short viewport. */}
      {/* NOTE: rendered inside the workspace Modal so it stacks above it. Modal's
          own Escape handling means Escape here cancels the leave — the safe
          direction — and requestClose() ignores a repeat while this is open. */}
      <div style={{ padding:'8px 12px', borderTop:'1px solid var(--gw-border)', fontSize:11, color:'var(--gw-mist)', lineHeight:1.5, flexShrink:0 }}>
        {savingLayout
          ? <span aria-live="polite">Saving this deal’s field layout…</span>
          : <>
              {/* THE FACT THE OLD CONFIRM DIALOG WAS ASKING FOR, shown instead of
                  asked for. Save PDF, Print and Save to Deal all build from
                  BoldSign's saved copy, so "when did BoldSign last save" is the
                  one thing worth knowing before pressing them — and it belongs on
                  screen, not behind a modal that interrupts the press. */}
              <span aria-live="polite" style={{ color: lastSavedAt ? 'var(--gw-green)' : 'var(--gw-amber)', fontWeight: 600 }}>
                {lastSavedAt
                  ? `BoldSign saved at ${lastSavedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
                  : 'BoldSign hasn’t reported a save yet'}
              </span>
              {' — '}
              <strong>Save PDF</strong>, <strong>Print</strong> and <strong>Save to Deal</strong> all build from that saved copy, so save in BoldSign first if you have just typed something. Nothing goes out until you click Send. Fields you place are remembered for this deal.
            </>}
      </div>

      {leaveAsk && (
        <ConfirmDialog
          eyebrow="BoldSign"
          title="Leave the editor?"
          confirmLabel="Leave"
          confirmVariant="btn--danger"
          busy={savingLayout}
          onCancel={() => setLeaveAsk(false)}
          onConfirm={() => leaveNow()}
          message={
            <>
              <p style={{ margin:'0 0 10px' }}>Are you sure you want to leave? Unsaved changes will be lost.</p>
              {/* Precision is the point. "Unsaved changes" alone leaves an agent
                  guessing whether the whole packet is about to disappear; naming
                  what survives is what makes Leave a safe button to press. */}
              <p style={{ margin:'0 0 6px', color:'var(--gw-ink)' }}><strong>What is kept:</strong> the document stays on this deal as a draft, and the field layout is saved for next time as you leave.</p>
              <p style={{ margin:0 }}>
                <strong style={{ color:'var(--gw-ink)' }}>What may be lost:</strong> anything placed in BoldSign since
                {lastSavedAt
                  ? ` your last save at ${lastSavedAt.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' })}`
                  : ' you opened the editor'}
                {' '}that BoldSign hasn’t saved. To keep it, choose Cancel and click <strong>Save</strong> inside BoldSign first.
              </p>
            </>
          }
        />
      )}
    </Modal>
  )
}
