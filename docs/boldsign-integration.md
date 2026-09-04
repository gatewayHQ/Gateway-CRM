# BoldSign e-Signature Integration

How Gateway CRM sends documents for signature, prefills them from deal data,
signs them embedded in-app, and archives the signed record + audit trail.

Vendor history: **DocuSign → SignWell → BoldSign**. BoldSign is the current and
only e-signature provider.

---

## Architecture at a glance

```
Agent (CRM)                    /api/boldsign                 BoldSign (US)
  Send for Signature  ─────▶   send / document-embed-url ─▶  api.boldsign.com/v1
  Send from Template  ─────▶   template-send / -embed-url ─▶
  Prepare & Print:
    Review Draft      ─────▶   template-draft ────────────▶  (creates a DRAFT,
                            +  document-print (preview) ─▶   sends nothing)
    Download Filled   ─────▶   document-print ────────────▶
    Send for Signature ────▶   draft-send ────────────────▶  /v1-beta draftSend
        │                          │  (X-API-KEY, retry+idempotency)
        ▼                          ▼
   <BoldSignFrame> iframe  ◀──  sendUrl / signLink  (app.boldsign.com)

Client (Portal)                /api/portal?action=sign-link
  Documents to Sign   ─────▶   token-validated → getEmbeddedSignLink ─▶ iframe

BoldSign  ──webhook──▶  /api/boldsign (HMAC-verified, required)
                          → compare-and-set boldsign_documents.status
                            (forward-only; terminal states are final)
                          → on Completed: archive signed PDF + audit trail
                          → notify agent (once — only the delivery that won
                            the transition)

Nightly:  /api/cron?task=boldsign-sync
            → template-list → reconcile Form Library (form_packets) with what
              actually exists in BoldSign (deactivate orphans, draft new finds)
```

**Source of truth**
- **BoldSign** owns the document bytes, form fields, roles, text-tag layout, and template versions.
- **Form Library** (`form_packets`) is the CRM's single catalog for both plain downloadable forms and e-signature templates. An entry with `boldsign_template_id` set is sendable from a deal's Signatures tab. Never duplicate the document/field definitions in Postgres — only a pointer + prefill map.
- `boldsign_documents` records per-send state; `boldsign_sender_identities` records per-agent send-on-behalf approval (one org-wide `is_default` fallback).
- `document_versions` mirrors every archived signed PDF and audit trail (`source = 'boldsign'`) so completed signatures show up as first-class, metadata-carrying CRM documents — not bare storage objects.

## Key decisions
- **US region**, `X-API-KEY` auth. Sandbox vs Live is decided by *which key* is configured — no per-request test flag. Sandbox and Live are separate accounts, so **template IDs differ between them**.
- **Signers (multipart):** each signer is a **repeated `Signers` form field holding one JSON object** — never one field with a JSON array (that returns `{"Signers":["Value is invalid"]}`).
- **No coordinate guessing.** Field placement used to be auto-computed from page pixel/point math read via pdf-lib — this was a persistent source of drift bugs (BoldSign's `bounds` unit/origin couldn't be confirmed from the WAF-blocked docs) and was retired entirely. Fields now come from one of three places:
  1. **Text tags** — `{{fieldType|signerIndex|required|label|fieldId}}` baked into the source PDF; BoldSign scans and places fields itself on `UseTextTags: true`. Setting `fieldId` to a CRM token unifies prep with prefill. See "Templates — authoring" below.
  2. **Explicit `tabs`** — caller-supplied coordinates (not guessed), still honored for integrations that know exact placement.
  3. **Interactive placement** — for the embedded (PreparePage) send flow, the agent places fields visually in BoldSign; nothing is pre-placed. The non-interactive `send` action has no such step, so it rejects a request with neither text tags nor explicit tabs (`requiresExplicitFieldPlacement`) rather than silently guessing.
- **Prefill by field ID:** a template field whose ID matches a CRM token (`property_address`, `seller_name`, `agent_name`, `broker_name`, …) is auto-filled and sent **read-only**. See `crmTokenValues()`.
- **Embedded everywhere:** agents send via BoldSign's embedded prepare UI in-frame; clients sign via embedded signing in the portal. Requires **approved domains** in BoldSign + a paid tier.
- **Reliability:** the central `boldsign()` client does exponential backoff + jitter. **A GET is always retried; a write is not.** BoldSign does not document an `Idempotency-Key` header, so a retried `POST /document/send` after a lost response is a second legally binding document in the client's inbox and a second credit off the plan. A write retries only on **429/408** (both mean BoldSign never processed it) or when the caller passes `idempotent: true` (revoke, delete, cancelEditing, URL minting). A connection that dies mid-send throws an error that *says the outcome is unknown* rather than one that reads like nothing happened. The `Idempotency-Key` header is still sent — harmless if ignored, correct the day it isn't.
- **Rate limits are per ACCOUNT and shared:** Live 2,000 requests/hour, Sandbox 50/hour — the nightly sweep, every agent sending, and any AI agent polling all draw on the same budget. `getRateLimitState()` records what BoldSign reports on each response; the nightly cron logs and returns it.
- **Webhook events are forward-only.** Deliveries are unordered and BoldSign stops redelivering once we answer 200, so the status write is a compare-and-set: terminal states (completed/declined/expired/voided) are final and the lifecycle never rewinds. Without it a redelivered "Sent" landing after "Completed" put a signed agreement back in the client portal as unsigned, restarted reminder emails to someone who had already signed, and dropped it out of the closing compliance gate.
- **Document bytes never travel as base64.** A Vercel function caps request *and* response payloads at 4.5 MB and base64 inflates by ~33%, which silently limited every send to ~3.3 MB of PDF — under the size of a normal scanned disclosure packet. The browser puts the PDF in the deal's storage folder and passes a short-lived **signed URL**; the API streams it to BoldSign. Downloads work the same way in reverse (signed storage URL out). Nothing is size-limited except BoldSign's own 25 MB per-file ceiling, which is checked client-side with a real message.
- **Every send is tracked server-side before the agent gets a send URL.** An untracked document is worse than a failed one: it reaches the client and then never updates, archives, or appears in the CRM. If the row can't be written the draft is deleted and the send is refused.
- **Archive paths are deterministic and recorded on the row** (`signed_storage_path` / `audit_storage_path`), so a webhook redelivery overwrites instead of duplicating, and each document resolves to *its own* PDF rather than the first `signed-` file in the deal folder.

## Data model
| Table | Purpose |
|---|---|
| `boldsign_documents` | one row per send: `document_id`, `deal_id`, `agent_id`, `status`, `signer_*`, `signers` jsonb, `completed_at`, `audit_trail_saved`, `signed_storage_path`, `audit_storage_path`, `last_reminded_at`, `reminder_count` |
| `form_packets` | **the template/form catalog.** `state`, `transaction_type`, `name`, `storage_path` (plain downloadable forms) plus `boldsign_template_id`, `doc_type`, `field_tokens`, `active` (e-sign-ready entries) |
| `boldsign_sender_identities` | per-agent send-on-behalf: `agent_id`, `email`, `status` (pending/approved/declined) |
| `deal_field_layouts` | one row per (deal, template): the normalized placement of every field, captured out of BoldSign when an editing session ends and re-applied to the next draft built for that deal — where fields **sit** |
| `deal_template_drafts` | one row per (deal, template): the saved state of the prepare-from-template screen — signer rows, prefilled values, tri-state tick boxes, the packet's declared terms, send options — what the agent **answered**, before any document exists (migration 0044) |
| `boldsign_templates` | **superseded** by `form_packets` (0019 backfills it in) — kept, not dropped, for rollback safety. Don't write new rows here. |

Signed PDFs + audit-trail PDFs are archived to the `deal-documents` bucket.

## API surface — `POST /api/boldsign` (action-routed)
| Action | Auth | Purpose |
|---|---|---|
| `send` | agent | Ad-hoc immediate send (multipart). Requires `useTextTags: true` or per-signer `tabs` — no auto-placement. |
| `document-embed-url` | agent | Ad-hoc → embedded prepare/send URL (iframe). `useTextTags` optional; otherwise the agent places fields in BoldSign. Writes the tracking row **before** returning the URL. |
| `layout-capture` | agent (sender) / admin | Read a document's current field placement back from BoldSign and store it against the deal (`deal_field_layouts`). Answers 200 with `{ saved:false, reason }` when there is nothing to store — it rides along with the agent's real work and must never present as a failed send. See "Per-deal field layouts" below. |
| `draft-send` | agent (sender) / admin | **Send a document that is sitting in draft** — `POST /v1-beta/document/draftSend`. The only non-webhook action in this file that puts a document in front of a client. Verifies against BoldSign that it really is still a draft (409 + row correction if not), sends under the *draft's* `onBehalfOf`, advances the row to `sent` through the same compare-and-set the webhook uses, and captures the field layout. See "Prepare & Print" below. |
| `document-edit-url` | agent (sender) / admin | **Reopen an existing DRAFT** in the embedded prepare editor (`/document/createEmbeddedEditUrl`) — same signers, same field placement. Verifies against BoldSign that the document really is a draft (and self-heals a stale row if it isn't), then clears a stale edit lock and retries once if BoldSign refuses. See "Editing a draft" below. |
| `status` / `remind` | agent | Doc status; nudge outstanding signers (records `last_reminded_at` / `reminder_count`) |
| `download` / `audit-download` | agent | Returns `{ url, filename }` — a 5-minute signed **storage** URL, never base64 |
| `document-delete` | agent (sender) / admin | Remove a draft/unsigned/expired document — revokes if in-progress, then deletes in BoldSign, then removes the local row. Refuses `completed` records. |
| `template-list` / `template-details` | agent | List templates / read a template's roles + fields |
| `template-send` / `template-embed-url` | agent | Send from template (JSON) / embedded prepare from template |
| `template-draft` | agent | **Create a draft from a template — no editor, nothing sent.** Same payload as `template-embed-url` but `deal_id` is required. Returns `{ documentId, status:'draft', prepareUrl }`. Both share `createTemplateDraft()`. |
| `template-editor-url` | admin | Embedded template create/edit URL. Requires `roles` (defaults to Seller/Listing Agent) and a document title on create — see "Fixing 'Roles cannot be null or empty'" below. `useTextTags` + `textTagDefinitions` supported. |
| `identity-create` / `identity-details` / `identity-update` / `identity-delete` / `identity-set-default` / `identity-sync` / `identity-resend` | admin | Full sender-identity lifecycle — see "Sender Identity Management" below |
| _(no `action`)_ | webhook | BoldSign lifecycle events (HMAC-verified) |

`getEmbeddedSignLink` for clients is minted via `GET /api/portal?action=sign-link`.

## Client-portal signing — who may sign as whom
A portal link is a bearer credential for **one deal**, not for one person, and a
document's signer list normally also contains the listing agent (who
countersigns) and sometimes the other party. Two gates therefore apply, both in
`api/portal.js`:

- **Status allow-list** (`sent`/`delivered` only). A `draft` row exists the
  moment an agent opens the prepare screen — before fields are placed, before
  anything is sent — so the previous deny-list (`!completed && !voided`) exposed
  half-prepared documents, plus declined and expired ones, as "Documents to Sign".
- **`portalSignableEmails()`** intersects the document's signers with *this deal's
  own client contacts* (`deals.contact_id` + `deal_contacts`). Only that
  intersection is returned in the payload and only it is accepted by the
  sign-link minter. Authorizing on "is a signer" alone — which is what the code
  did — let anyone holding the portal link open a signing session **as the agent**
  and execute their signature block. Unit-tested in
  `api/__tests__/portal-signing.test.js`.

A client whose address isn't on the document simply doesn't see it in the portal;
BoldSign's own emailed link still authenticates them independently.

## Reliability: idempotency + retry (`boldsign()`)
- **Retryable:** network errors, `408/429/500/502/503/504`. Backoff `400·2^n ms + jitter`, honoring `Retry-After`, max 3 attempts.
- **Idempotency:** writes auto-get an `Idempotency-Key` header, reused across a call's retries so a retried send can't double-create (when BoldSign honors it). GETs never carry one.
- Tests: `api/__tests__/boldsign.test.js`.

## Webhooks
- Register in BoldSign → Settings → API → Webhooks → `https://<domain>/api/boldsign`; events: `Sent, Viewed, Signed, Completed, Declined, Revoked, Expired`.
- Set **`BOLDSIGN_WEBHOOK_SECRET`** — every event's `X-BoldSign-Signature` is HMAC-SHA256 verified over `t.<rawBody>` with a 5-minute replay window. Unverified events are ignored (200, not processed). Unset = verification skipped (dev only).
- On `Completed`: archive signed PDF + audit trail to `deal-documents` **and** record each as a `document_versions` row (`source: 'boldsign'`, the signed PDF pinned `'signed'`) — no manual download + re-upload step. `note` carries who signed and when; the signed PDF automatically shows up in the deal's Documents tab (which lists the same storage folder) with real metadata attached, not just a bare filename. `audit_trail_saved` is set so the UI can offer a manual fetch (`audit-download`) if the audit trail lagged the webhook.

## Sender Identity Management
Full CRUD, mapped to BoldSign's sender-identity API (`/v1/senderIdentities/*`):

| CRM action | BoldSign endpoint | UI |
|---|---|---|
| `identity-create` | `POST /senderIdentities/create` | Settings → BoldSign — **Register** button per agent |
| `identity-details` | `GET /senderIdentities/properties?email=` | used internally to refresh one row |
| `identity-update` | `POST /senderIdentities/update?email=` | pencil icon → inline rename |
| `identity-delete` | `DELETE /senderIdentities/delete?email=` | trash icon (confirms first) |
| `identity-sync` | `GET /senderIdentities/list` | **Sync statuses** button |
| `identity-resend` | `POST /senderIdentities/resendInvitation` | **Resend** button (Pending rows) |
| `identity-set-default` | *(CRM-only concept)* | **Make default** button (Approved rows) |

**Default sender identity:** `boldsign_sender_identities.is_default` (partial unique index — only one at a time) is the org-wide fallback. `resolveOnBehalfOf()` now checks the acting agent's own approved identity first, then falls back to the default identity, so admin- or system-triggered sends still go out under a real, recognizable sender instead of the raw API account.

**Using the identity when sending:** every send path already routes through `resolveOnBehalfOf()` and sets BoldSign's `OnBehalfOf` field — this was true before this change; what's new is the default-identity fallback.

## Fixing "Roles cannot be null or empty" / "Document title or document info is required"
This was a real bug in `template-editor-url`'s create path: BoldSign's `createEmbeddedTemplateUrl` **requires** a non-empty `Roles` array (multipart bracket notation — `Roles[0][name]`, `Roles[0][index]`, one indexed field pair per role) **and** a document title, sent as **both** `Title` (template name) and `DocumentTitle` (the document's own title). The old code sent neither `Roles` nor `DocumentTitle`.

Fixed by `normalizeTemplateRoles()` — defaults to a `Seller` / `Listing Agent` pair (our standing role convention) when the caller doesn't specify roles, and always emits 1-based indices. Form Library's "Build in BoldSign" now shows an editable role list (add/remove/rename) before opening the editor, and sends `documentTitle` alongside `title`.

## Form Library "Build in BoldSign" — modal UX + save-back
Two bugs made this flow unusable/unreliable, both fixed in `src/pages/FormLibrary.jsx`:

- **Popup wasn't scrollable.** `UploadModal` rendered its whole form as one plain `<div>` instead of using the `modal__head` / `modal__body` / `modal__foot` structure every other modal in the app uses (`.modal` caps at `max-height: 90vh; overflow: hidden` — only `.modal__body` scrolls, via `overflow-y: auto; flex: 1`). Content past the fold (roles, Field Tokens, Save/Cancel) was silently clipped with no scrollbar. Fixed by adopting the standard three-part layout; the dialog also gained a proper header/close button it never had (the old code passed an unused `title` prop straight to `<Modal>`, which doesn't render one).
- **The editor opened in a new browser tab (`window.open`), not embedded.** That broke the "opens embedded editor → saves back to CRM" promise: there was no reliable signal when the admin finished, and the packet still required a manual "Save Changes" click back in the (now stale) original tab. Fixed by rendering the editor in-modal via the same `<BoldSignFrame>` iframe component the send/sign flows already use (`onDone`/`onError` via `postMessage`, verified against the `https://app.boldsign.com` origin). The modal widens to 900px while the editor is open.
- **Auto-save on completion.** `onDone` now calls the existing `save()` function automatically — no separate click needed. State + Packet Name are validated *before* the editor opens (so a template is never built for an unnamed/unsaved packet), and the same PDF selected for "Build in BoldSign" now also backs the packet's own storage upload (previously that file only fed the BoldSign template and a *second*, separate file choice was needed to satisfy Save's "Upload a PDF file" check for a brand-new packet).
- **"Rebuild in BoldSign" now actually edits the existing template.** It previously re-ran the *create* path unconditionally — re-uploading the PDF and minting a brand-new BoldSign template id every time, silently orphaning the old one. It now calls `template-editor-url` with the existing `templateId`, which hits BoldSign's `getEmbeddedTemplateEditUrl` (already implemented server-side, just never called from here) and reopens the same template for editing.

## Editing a draft (the way back into an unfinished send)
An embedded send stays a **draft** in BoldSign until the agent clicks Send. Agents
routinely lose that screen — they switch tabs, click outside the modal, or hit
Escape — and before this the draft was a dead end: it showed in the Signatures tab
with a "Draft" chip, no way back in, and the only route forward was deleting it and
rebuilding the whole send.

- **`Edit & Send`** on any `draft` row (`SignaturesTab`, `Pipeline.jsx`) calls
  `document-edit-url` → `POST /v1/document/createEmbeddedEditUrl?documentId=…`
  (`{ editUrl }`) and reopens the same document with the toolbar, Preview and Send
  buttons on. Signers and placed fields are whatever the agent left behind.
- **`sendViewOption` is state-dependent — a draft needs `FillingPage`.** Asking for
  `PreparePage` on a draft is refused outright: *"The embedded editing link cannot
  be generated when SendViewOption is set to 'PreparePage' because the document is
  in the draft state."* `FillingPage` is the page we want anyway (the document with
  its recipients and fields, ready to adjust and send); `PreparePage` is for a
  document already in flight. `createDraftEditUrl()` doesn't hard-wire the mapping
  off that one message — a 400 that *names* `SendViewOption` retries with the other
  option, so neither state can dead-end. A 400 that doesn't name it is treated as an
  edit lock instead (below), so the two failure modes never get confused.
- **Sender identity.** The edit URL is minted with the `onBehalfOf` of the
  document's *recorded* `agent_id`, not the person clicking. An admin reopening an
  agent's draft must not change who the client hears from mid-send.
- **The edit lock.** A document opened for editing stays flagged in-edit-mode on
  BoldSign's side; an agent who closed the browser instead of saving leaves the
  flag set, and the next `createEmbeddedEditUrl` returns **400**. `createDraftEditUrl()`
  treats a 400 as a possible stale lock: it calls `/document/cancelEditing` and
  retries once. If the retry also fails, *its* error surfaces (so a genuinely
  un-editable document still says why). Unit-tested in `api/__tests__/boldsign.test.js`.
- **The CRM's status is not the gate.** A missed `Sent` webhook leaves a row reading
  `draft` for a document the client already has, and offering "Edit" for that is a
  lie. The action asks BoldSign for the live status first, writes the correction to
  the row, and refuses with a message naming the real status.
- **Accidental close is guarded.** Every embedded BoldSign step now renders through
  `BoldSignStepModal`, which confirms before closing (`Modal` closes on backdrop
  click *and* Escape) and says the work is kept as a draft. A draft-save event no
  longer tears the iframe down — the agent is mid-prep. And `Drawer` ignores Escape
  while a modal is open (`modalIsOpen()` in `UI.jsx`), so one keypress can't close
  the prep frame *and* the deal drawer behind it.

## Document quality — why template PDFs were blurry
**Nothing in this app ever compressed a PDF.** But `template-editor-url` used to
carry template sources as **base64 inside the JSON request body**, and a serverless
request is capped at 4.5 MB — base64 inflates by ~33%, so ~3.3 MB of PDF. A real
listing packet with scanned disclosures is bigger than that, so the only way to get
one in was to run it through a compressor until it fit. BoldSign then holds those
degraded bytes forever: the embedded editor, the preview, the sent document and the
signed PDF all render the same stored file. **No preview or DPI setting can recover
detail the stored file no longer has** — which is why the fix is upstream of
rendering, not in it.

- **Template sources now travel like send documents do.** The browser uploads the
  ORIGINAL to the `form-packets` bucket and passes a 10-minute **signed URL**; the
  API streams the bytes to BoldSign server-side, where the 4.5 MB cap doesn't apply.
  The honest ceiling becomes BoldSign's own **25 MB per file** — ~7× the headroom.
- `resolveDocumentBytes(req, { …, source: 'packet' })` reads from `form-packets`
  instead of `deal-documents`. The bucket is a coarse `'deal' | 'packet'` switch, not
  a caller-supplied bucket name, and `isOwnSignedStorageUrl()` takes an explicit
  allow-list — so widening this for templates cannot widen the SSRF surface for
  sends. Both directions are unit-tested.
- **Build uploads before opening the editor**, using the same path scheme `save()`
  writes, so the source is preserved even if the admin never clicks Save and no
  second copy is orphaned.
- **Oversized files are shrunk losslessly or refused — never re-compressed.**
  `fitForBoldSign()` only engages above 25 MB and only calls
  `optimizePdfLossless()` (pdf-lib re-serialize with object streams: structure and
  orphaned objects, images copied byte-for-byte, no resampling). Still too big → a
  400 naming both sizes and telling the admin to split the packet, because
  re-encoding page images is the operation that caused this bug.
- **Fixing an already-blurry packet:** selecting new PDFs on a packet that already
  has a template now **replaces the source** — it builds a new template from the
  better file and repoints the packet, behind an explicit confirm (the old template
  stays in BoldSign; sent documents are unaffected; fields must be placed again).
  Previously "Rebuild in BoldSign" reopened the old template and silently ignored
  the newly selected file, so there was no way to un-blur a packet at all.
- The **ad-hoc send** path already streamed from storage, so it was never subject to
  this; the pick-time check there is BoldSign's real 25 MB.
- The in-modal editor/preview is rendered by BoldSign server-side from the stored
  document — there is no client DPI knob. What's left on our side is viewport size,
  covered by the enlarged modal.

## Switching browser tabs must not close the editor
The reported symptom — "the agent clicked out of the tab and the form closed and went
as a draft" — was real, and the cause was three layers up from BoldSign:

1. Switching tabs makes Supabase refresh the auth token when the tab comes back.
2. `onAuthStateChange` handed `App` a **new session object** (same user, same token
   contents), and its loader depended on `[session]` — so it re-ran and called
   `setDb()` with freshly-built arrays. Same data, new identities.
3. `DealDrawer`'s seeding effect depended on the `deal` **object** and the
   `dealContacts` **array**. New identities read as a change, so it fired
   `setTab(initialTab)` — throwing the agent back to Details, unmounting the
   Signatures tab and destroying the open BoldSign editor with it. The draft survived
   in BoldSign; the agent's place in it did not.

Fixed at both layers, because either one alone would leave the other as a trap:

- **`DealDrawer`** now keys seeding on `deal?.id`, `open`, `initialTab` and a CONTENT
  key from `dealContactIdsFor()` (sorted ids joined) — not on object identity. A
  refetch that changes nothing changes nothing. Side effect worth having: a background
  refetch can no longer wipe an agent's half-typed edits, which was the same bug
  wearing different clothes. Unit-tested in
  `src/lib/__tests__/dealDrawerSeeding.test.js` — the key must be identical for a
  DIFFERENT array with the same contents, and for the same rows in a different order
  (Postgres promises no order without `ORDER BY`), while a genuine add or remove must
  still change it.
- **`App`** keys its data load on `session?.user?.id` rather than the session object,
  so a token refresh is invisible instead of triggering a full database refetch.
- **Focus comes back.** An iframe isn't reloaded for being backgrounded, but keyboard
  focus isn't restored to it either — an agent who was typing came back to a page that
  swallowed keystrokes. `BoldSignFrame` re-focuses the frame on `visibilitychange`,
  but only if the frame held focus when the tab was left: stealing it from someone who
  had deliberately clicked elsewhere would be its own small rudeness.

## Leaving the editor — confirm, and save what can be saved
- **`ConfirmDialog`** ("Leave the editor?" / Cancel / **Leave**) replaces the
  `window.confirm` on the close path. Escape, the backdrop and the X all route
  through it; Escape *inside* the dialog cancels the leave, which is the safe
  direction, and a repeat Escape can't re-open it.
- **The prompt only appears when work plausibly exists.** Nothing inside a
  cross-origin iframe is observable — not a click, not a drag, not a half-placed
  field. But when focus moves INTO the frame our window fires `blur` and
  `document.activeElement` becomes the iframe element (`frameTookFocus()`, unit
  tested). That flag sets on focus-in and clears whenever BoldSign reports a save,
  because at that instant nothing is outstanding. An agent who opens the editor and
  closes it immediately is not warned about losing nothing — a prompt that cries wolf
  is one agents dismiss without reading.
- **The dialog names what survives and what doesn't**, including the time of the last
  save: the draft stays on the deal, the field layout is captured on the way out, and
  what's at risk is only what BoldSign hasn't saved since then. "Unsaved changes will
  be lost" on its own leaves an agent guessing whether the whole packet is going.
- **Leave saves before closing** — `captureFieldLayout` runs on the way out (the
  "persist auto-saved state" half), with the confirm button showing a busy state.
- **`beforeunload`** covers tab close, reload and navigation away, which no in-app
  guard can reach. Registered only while work is outstanding. Browsers show their own
  generic wording — the point is the pause, not the words.

## Prepare & Print Draft Agreement (the paper-first workflow)

Agents rarely e-sign a listing agreement cold. They sit with the client, walk
through a **filled** copy on paper, take the client's changes, and only then send
it for signature. Everything below exists so the CRM can do that without a
document ever leaving the building by accident.

**The rule the whole flow rests on: nothing sends except `draft-send`.** Creating
a document, filling it, downloading it, printing it and reopening it are all
deliberately non-sending operations. There is exactly one code path that puts a
document in front of a client, it is behind a confirm dialog that names the
recipients, and it is never called implicitly.

### The flow

```
Signatures tab → Prepare from Template
   │
   ▼  pick template · signer rows seeded from the deal · every prefillable
      field rendered as an input, pre-filled from CRM tokens
   │
   ▼  ONE creation step, whichever door is clicked — template-draft
      /template/createEmbeddedRequestUrl
      → document EXISTS, is a DRAFT, values written
      → tracked on the deal + saved layout applied
   │
   ├── Review Draft ────────────▶ document-print (previewUrl)
   │      (the common case)        → the composed packet on screen, with
   │                                 Adjust Field Placement · Download PDF ·
   │                                 Send for Signature beside it
   │
   └── Place Fields in BoldSign ▶ document-edit-url  (the SAME draft, opened in
          (when the agent already    the embedded editor; leaving it lands on the
           knows a box must move)    review with the preview re-fetched)
   │
   ▼  the draft row on the Signatures tab, with four distinct actions:
       ┌───────────────────┬───────────────┬───────────────┬───────────────────┐
       │ Download Filled   │ Save to Deal  │ Edit Fields   │ Send for Signature│
       │ document-print    │ document-file │ document-edit │ draft-send        │
       │ → print, take to  │ → filed in    │ -url          │ → confirm →       │
       │   the client      │   the deal's  │ → keep as a   │   signers emailed │
       │ (NOT a signed doc)│   Documents   │   draft       │ (irreversible)    │
       └───────────────────┴───────────────┴───────────────┴───────────────────┘
```

The loop is deliberate: **print → client marks it up → Edit Fields → print
again**, as many times as it takes. The document stays a draft, on the same
`documentId`, the whole way through — so nothing is rebuilt, the deal's field
layout is preserved, and the audit trail is one document rather than five
abandoned ones.

### Save for Later — a packet an agent is working on that is not needed yet

Reported symptom: *"I had filled out the checkboxes and the buyer name on this
template. I then went to X out of it and save the template, but it didn't keep
those filled in."*

Preparing a packet is where an agent decides what the agreement **says** — who
signs it, which boxes are ticked (the representation, the term, the policy: these
are terms of a contract, not decoration), the client's name where the deal record
needs correcting, an expiry, a copy to the lender. Until migration 0044 none of
it was stored anywhere. It lived in React state and nowhere else, so closing the
prepare modal — the X, Escape, the backdrop, Cancel, a browser reload — discarded
every one of those decisions **silently**, and reopening the same template on the
same deal re-seeded from the deal as if the agent had never been there.

Every button on that screen was a step toward sending, so "I'll finish this
Thursday" had no button at all, and the only way out was the one that threw the
work away.

**Two things are saved now, and they are not the same thing.**

| | Where it lives | What it is for |
|---|---|---|
| The filled **draft** | BoldSign + `boldsign_documents` (status `draft`) | A real document on the Signatures tab, every value written into it. Anyone on the deal can find it, print it, send it. This already existed — it just only happened when one of the two send-ward buttons was pressed. |
| The **screen's own state** | `deal_template_drafts` (migration 0044) | The radio buttons, the tri-state tick boxes, the corrected names, the send options. Reopening the template brings them back. Without this half, "reopen the draft" means BoldSign's editor — where, as the modal itself says, anything typed is a preview that never reaches the signers. |

`Save for Later` writes both, **in that order and for that reason**: the agent's
own answers go to the CRM first and unconditionally, because they are the thing
that was being lost. They survive a packet too incomplete to become a document
(no signer yet, a term still unanswered) and they survive a BoldSign outage — the
toast then says the work is kept and names what is missing before a draft can
reach the Signatures tab. `Review Draft` and `Place Fields` save the screen state
too, so reviewing a packet and closing the review no longer loses the decisions
that produced it.

**Closing asks, and only when there is something to ask about.** `templateWorkEdits()`
compares the screen against what *seeding* put there, so opening the modal and
closing it again closes with no dialog — the seeded values are the deal's, not
the agent's work. With real changes outstanding the dialog offers all three
answers rather than folding "throw it away" into Cancel:

```
Save what you have done on this form?
  You have changed 1 filled-in value and 2 boxes or terms on this packet.
  [ Keep editing ]  [ Discard changes ]  [ Save for Later ]
```

`beforeunload` covers the path no in-app guard can reach (closing the tab,
reloading), registered only while work is outstanding.

**A restore is a MERGE, never a replacement.** A template can be edited between
the save and the reopen: fields renamed, boxes deleted, roles added. So
`applySavedTemplateWork()` overlays the save onto a freshly seeded screen —
anything the template no longer has is dropped (sending a value for a field
BoldSign no longer carries is rejected outright by `assertPayloadFieldsExist`),
and anything it has gained arrives seeded from the deal. The screen says it
restored, with the time and a **Start fresh from the deal** link, because a form
that silently differs from its template is a form an agent cannot trust.

**One work-in-progress draft per packet, not one per save.** An agent who saves
four times over a week must not find four near-identical unsent drafts on the
Signatures tab — the newest is the only one that reflects their answers, and the
older ones are traps to send by mistake. So a save supersedes the draft the
*previous save* left, and only ever that one: it must still be `draft` in the CRM
(`isUnsentDraft()`), and drafts created by `Review Draft` / `Place Fields` are
never touched, because two of those on one deal can be two real packets for two
different signers. Superseding is best-effort — a failure leaves an extra draft,
which is untidy, never lost work.

**Sending clears the save.** A sent packet is not work in progress; left behind,
the row would restore last week's answers onto the next packet built from the
same template on this deal.

Why not `deal_field_layouts`: that table records where fields **sit** on a
document, read back out of BoldSign after an editing session. This records what
the agent **answered** on the CRM's own screen, before any document exists —
different lifecycle, different writer. Why not `form_packets`: those rows are
brokerage-wide and compliance-relevant, and one agent's in-progress answers on
one deal must never rewrite the form every other deal sends from (same reasoning
as migration 0026).

Code: `src/lib/services/templateWork.js` (+ its tests),
`SendFromTemplateModal` in `src/pages/Pipeline.jsx`,
`migrations/0044_deal_template_drafts.sql`.

### Why creating the draft doesn't need the editor

`POST /template/createEmbeddedRequestUrl` is the API's draft-from-template door.
It mints the document **with the roles and their `existingFormFields` values
already written onto it**, and returns both a `documentId` and an embedded
prepare URL. **The document exists, and is a draft, whether or not anyone ever
opens that URL.** That single fact is what lets `template-draft` skip the editor
and still hand back a real, filled, downloadable document — and it is why both
doors out of the prepare screen share one `createDraft()` call rather than being
two different creation mechanisms that could drift. **Place Fields reopens the
draft that was just created** (`document-edit-url`) instead of creating its own
through the embed path, so the two routes cannot produce different documents.

Not opening the editor also means no **edit lock** is set (see "Editing a
draft"), so the very next action on that draft cannot hit a stale-lock 400.

### Why the downloaded PDF is filled and not blank

This is the part that is easy to get wrong and hard to notice. BoldSign hands
back the **original template file** for a document that hasn't been signed —
every ticked box and typed date lives in `/document/properties`, not in the PDF
bytes. A naive `/document/download` on a draft therefore prints a *blank form*,
which is the one thing the agent is actually checking.

`document-print` composes the copy instead: BoldSign's bytes, plus
`collectFilledFields()` → `drawFilledValues()` drawing each stored value onto the
page, plus an appended **SIGNING SUMMARY** listing every field by page, signer,
type, label and value. See "Save PDF before Send" below for the mechanics
(derived — never assumed — bounds scale, AcroForm flattening, signed storage URL
rather than base64).

**The downloaded PDF is a review copy, not a signed document.** It carries no
signatures and no audit trail; the button and its tooltip say so.

### Sending, and the two ways it can go wrong

`draft-send` → `POST /v1-beta/document/draftSend?documentId=…&onBehalfOf=…`.

- **`/v1-beta`, not `/v1`.** BoldSign has not promoted this endpoint; on `/v1` it
  answers a bare 404. `betaBase()` derives the beta host from the **configured**
  `BOLDSIGN_API_BASE` rather than hard-coding `api.boldsign.com`, because that
  base is also the region switch — a hard-coded host would route an EU account's
  documents through the US one, which is a data-residency break rather than just
  a wrong URL. Unit-tested.
- **Never retried.** A repeated `draftSend` after a lost response is a second
  binding agreement in the client's inbox, so it rides the default write policy
  (retry only on 429/408, which mean BoldSign never processed it). A connection
  that dies mid-send returns `{ indeterminate: true }` and tells the agent to
  **Refresh status** before trying again — it refuses to claim nothing was sent.
- **The CRM's status is not the gate.** A missed `Sent` webhook leaves a row
  reading `draft` for a document the client already has; sending that again is
  the exact double-send this guard exists to prevent. BoldSign is asked for the
  live status first, the row is corrected (forward-only, via `shouldApplyStatus`
  — a stale read must not rewind a completed document), and the action answers
  **409** naming the real status.
- **Sent as the identity the draft was created under**, not whoever clicks. An
  admin releasing an agent's prepared packet must not change who the client hears
  from between the printed copy and the email.
- **Refusals name a cause, not a status code.** `describeDraftSendFailure()`
  translates the ones agents actually hit — a signer role with no email, no
  signature field placed, a rate limit, a deleted draft — and keeps BoldSign's own
  validation text alongside, since that text says *which* role or field. Unit-tested.
- On success the row advances to `sent` optimistically through the same
  compare-and-set the webhook uses (so a `Sent` event that beat us is not
  rewritten), the field layout is captured for the deal's next packet, and the
  send is written to `audit_log`.

### UI states

| State | Row shows | Actions |
|---|---|---|
| No draft yet | — | **Prepare from Template** / Send for Signature (ad-hoc) |
| Modal, template loading | "Loading template…" | both buttons disabled |
| Modal, template unreadable | red panel + **Try again** | both buttons disabled — a failed load must never look like a loaded template |
| Modal, ready | signer rows + a control per prefillable field | **Review Draft** (primary) · **Place Fields in BoldSign** · **Save for Later** — all three create the same filled draft; the first two differ only in where the agent lands, the third just keeps it |
| Modal, restored from a save | "Picked up where you left off", with the save time and **Start fresh from the deal instead** | as above; the tick-box list opens itself when a save brought ticks back |
| Modal, closing with changes | three-way dialog naming what changed | **Keep editing** · **Discard changes** · **Save for Later** |
| Review | the composed packet in an iframe, field count, recipients in signing order | **Adjust Field Placement** · **Download PDF** · **Send for Signature** (confirmed) |
| Review, preview unavailable | "the pages are not ready yet" | the other actions still work — a missing preview is never a failed draft |
| `draft` | amber strip, "Draft — nothing sent." | **Download Filled PDF** · **Edit Fields** · **Send for Signature** |
| Sending | — | Send button busy; confirm dialog shows a busy state |
| `sent` / `delivered` | "waiting Nd", reminder count | Remind · Save PDF · Refresh · Delete |
| `completed` | green strip | Download Signed PDF · Audit Trail |

The Signatures-tab filter has a **Drafts only** option, which is this workflow's
"Drafts folder"; the embedded editor's own auto-save covers the Web-App-style
half. Both point at the same `boldsign_documents` rows.

### CRM field → BoldSign form field mapping

There is no second mapping table for this workflow — it reuses the one the send
paths already use, in two layers:

1. **By field id → CRM token.** A template field whose **id** matches a CRM token
   is auto-filled from the deal and carried read-only. The token list is under
   "CRM prefill tokens" below; `crmTokenValues()` resolves them from
   `{ deal, property, contact, agent }`. Set the id when authoring the template —
   either in the visual editor or as the fifth segment of a text tag
   (`{{fieldType|signerIndex|required|label|fieldId}}`).
   Make it a **Label** field whenever every party has to see the value straight
   away — see "Prefilled data every signer must see" below.
2. **By hand, in the modal.** Every remaining field the agent *can* fill is
   rendered as a control: `isFillableField()` → a text input (or a `<select>` of
   the template's own options), `isTickableField()` → a three-way **Signer decides
   / Checked / Unchecked**. `prefillFieldEntry()` turns each into its
   `existingFormFields` entry and stamps `isReadOnly: true`.

| CRM source | Token / field id | Notes |
|---|---|---|
| `properties.address` (+ city/state/zip) | `property_address`, `property_full`, `property_city`, `property_state`, `property_zip` | `property_full` is the one-line composite |
| `deals.contact_id` → contact | `seller_name` / `client_name` | primary signer's name |
| acting/deal agent | `agent_name`, `agent_email` | from `dealAgentList()` |
| brokerage | `broker_name` | |
| `deals.value` | `list_price` | |
| `deals.commission_type` / `commission_pct` / `commission_flat` | `commission_pct`, `commission_amount` | `commission_pct` fills only on a percentage deal; neither fills when no commission is entered, so a blank is a prompt rather than a silent `0%` |
| `deals.listing_start_date` / `listing_end_date` / `close_date` | `listing_start_date`, `listing_end_date`, `close_date` | |
| `deals.contact_id` + `deal_contacts` + deal agents | *signer rows* (not form fields) | seeded by `seedSignersFromDeal()` — see "Signer auto-fill" |

Signer *placement* (which role signs where) is BoldSign's, not the CRM's — see
"Templates — authoring" and "Per-deal field layouts".

### Configuration for this workflow

Nothing new is required beyond the existing setup, but three things must be true
or the flow degrades in ways worth naming:

- **`BOLDSIGN_API_KEY`** on a plan that includes **embedded requests**. Draft
  creation goes through `createEmbeddedRequestUrl`, so a tier without embedding
  cannot create drafts at all — not just "cannot show the editor".
- **Approved domains** (BoldSign → Settings → Embedded) for *Place Fields*,
  *Adjust Field Placement* and *Edit Fields*. **Creating the draft, Review Draft,
  Download Filled PDF and Send for Signature do not need them** — they are pure
  API calls — so an account mid-setup still has a working prepare-and-print path,
  and Place Fields falls back to the review rather than dead-ending.
- **Templates must have their signature fields placed.** A template with no
  fields still saves as a draft and still downloads as a filled PDF, but
  `draft-send` will refuse it (BoldSign runs the full send validation), and the
  agent is told to use **Edit Fields**. Registering templates is Form Library's
  job; see "Templates — authoring & catalog".
- **`BOLDSIGN_API_BASE`** only needs setting for a non-US region; `betaBase()`
  follows it automatically.

### Test checklist

Run against a **Sandbox** key, on a throwaway deal that has a linked contact with
an email, a linked property, and a commission entered on the Details tab.

1. **Create from template** — Signatures tab → *Prepare from Template*. Signer
   rows are pre-filled from the deal; text fields carry CRM values; tick boxes
   read *Signer decides*.
2. **Fill** — change a text value, set one box to *Checked* and one to
   *Unchecked*, leave a third alone.
3. **Review the draft** — *Review Draft*. No editor opens; the draft is created
   and the composed packet appears on screen, with the field count and the
   recipients in signing order. **The values from step 2 must be visible on the
   pages.** Confirm in BoldSign's dashboard that the document is in **Drafts**
   and that **no email was sent**. Close the review: a row appears with a
   **Draft** chip and the amber "Draft — nothing sent." strip.
3b. **The other door** — repeat from step 1 and click *Place Fields in BoldSign*
   instead. The same draft is created and opens straight in the embedded editor;
   leaving it lands on the review with the preview re-fetched. Confirm the two
   routes produce identical drafts (same field values, one document each).
4. **Download filled PDF** — *Download Filled PDF*. The file downloads with the
   CRM's filename. **Open it: the values from step 2 must be on the pages** (blue
   text; the ticked box marked, the unticked and untouched ones not), and the
   appended SIGNING SUMMARY must list every field with its value. Print it.
5. **Resume the draft** — *Edit Fields*. The same document reopens on
   `FillingPage` with signers and placement intact. Change one value, click
   **Save** inside BoldSign, close via the X and confirm the leave prompt. Then
   *Download Filled PDF* again and confirm the change is in the new PDF.
6. **Send** — *Send for Signature*. The confirm names the document and the
   recipient; cancel it once and confirm nothing sent. Then confirm: the row
   flips to **sent**, the signer receives the email, and the draft actions are
   replaced by Remind / Refresh.
7. **Double-send guard** — before the webhook lands, click *Send for Signature*
   again if the button is still visible (or POST `draft-send` for that
   documentId). It must answer **409** naming the real status, not send twice.
8. **Complete** — sign as the client in the portal; confirm the webhook flips the
   row to `completed` and the signed PDF + audit trail land in the Documents tab.
9. **Refusal paths** — save a draft from a template with **no fields placed** and
   press Send: the message must name unplaced fields and point at Edit Fields, and
   the row must stay a draft.

## Save PDF before Send
Agents want the packet as a finished file before a client ever sees it — to read, to
keep, to print later, or to take to a client in person. The browser can't produce it:
the document is in a **cross-origin iframe**, so `window.print()` prints the CRM's own
chrome and calling `print()` on BoldSign's frame throws.

**This used to be a Print button and it produced blank paper.** The copy was loaded
into a hidden same-origin iframe and printed from there — but Chrome renders a PDF
through a plugin the parent page cannot drive, so `print()` returned without error and
the job came out empty, silently, with nothing in the page able to detect it. The
action is now **Save PDF**: the same server-composed copy is *downloaded*. It either
arrives as a file or fails loudly, and the agent prints it from their own PDF viewer.

- **`document-print`** builds the copy server-side: the document exactly as BoldSign
  holds it (`/document/download`), plus an appended **SIGNING SUMMARY** page listing
  every field by page, signer, type, label and prefilled value.
- **A filled draft prints filled.** BoldSign hands back the *original* file for a
  document that hasn't been signed — every ticked box and typed date lives in the
  properties payload, not in the bytes — so a review copy of a draft the agent had
  filled out used to come off the printer blank, which is the one thing they were
  checking. `collectFilledFields()` + `drawFilledValues()` draw those values (and
  only those: never an empty field box) onto the pages in blue. The bounds→points
  scale is **derived, not assumed** — BoldSign's own page dimensions when the
  payload carries them, otherwise the largest of points-1:1 / pixels-at-96-DPI
  under which every field still lands inside its page. If neither validates,
  nothing is drawn and the summary says so; the values are still listed there.
- **Returns a signed storage URL, never base64** — a serverless response caps at
  4.5 MB, so base64 would work in testing and fail on the scanned packets worth
  printing. Written to `deal-<id>/print/` and overwritten per document; the Documents
  tab and the send picker now filter storage **folder** rows (entries with no `id`),
  so a review copy never appears as if it were a filing.
- **The DRAFT stamp is removed.** BoldSign paints a large diagonal DRAFT across
  every page of a document that has not been sent, and those are the bytes
  `/document/download` returns — so the copy an agent hands a client came out
  slashed with it. `removeDraftWatermark()` (`api/_lib/pdfWatermark.js`) cuts
  **only** the drawing block that paints the stamp out of each page's content
  stream (also inside a form XObject, and a `/Watermark` or DRAFT `/Stamp`
  annotation). Nothing is cropped, resized, re-paged or re-rendered, and nothing
  is stamped back on: every other glyph, rule, logo, checkbox and value is left
  exactly as it was, at the source file's own print quality. The test is
  deliberately narrow — the block must paint the word DRAFT *and nothing else*,
  and be either rotated or set at 24pt+ — so prose containing the word, a typed
  value and a small upright label all survive; leaving a stamp is the better
  failure. Best-effort, like the flatten below. The closing-packet bundler runs
  the same pass over each PDF it merges.
- **Interactive forms in the source are flattened.** Many county/board PDFs ship as
  AcroForms whose widgets carry no appearance streams (`NeedAppearances`): they look
  filled on screen and render blank through a print driver. `buildPrintablePdf()`
  calls `form.flatten()` before drawing anything, baking each widget's appearance into
  the page content. Best-effort — a document with no form, or one pdf-lib can't
  flatten, is used as-is.
- **`savePdfFromUrl()`** (`src/lib/savePdf.js`) fetches the bytes, wraps them in a blob
  and clicks a `download` anchor, so the file lands with **our** filename and an
  expired signature or network failure is reported instead of opening a tab on an
  error page. The object URL is revoked on a timer, not immediately after `click()`
  (Safari cancels the download otherwise). Replaces the old `src/lib/print.js`.
- **No field boxes are drawn on the page, on purpose.** BoldSign's `bounds` origin
  and units could not be confirmed (docs WAF-blocked), and this file already retired
  one coordinate-guessing feature for that reason — a printout with signature boxes
  in almost-the-right-place looks authoritative and is quietly wrong. The summary is
  derived from what BoldSign states outright, so it cannot be subtly incorrect. A
  visual overlay becomes safe to add once the origin is confirmed against one live
  document.
- **Fallback for bytes:** if BoldSign refuses to release an unsent document's pages,
  the deal's own archived copy is used; if neither exists the error names which door
  was locked rather than saying "could not save".
- **The copy is built from what BoldSign has *saved*.** Values typed in the embedded
  editor but not yet saved there never reach `/document/properties`, so the editor
  header nudges the agent to click Save inside BoldSign first when work is outstanding.
- Reachable from the editor header (including while BoldSign's Preview is open), from
  every document row, and from the draft strip next to Edit & Send. The wire action is
  still `document-print`; the client export is `documentPdfUrl()`.

## Modal size — the embedded editor is a workspace, not a form
Field placement and review happen on a US Letter page. At the old 900 × 640 box that
page rendered small enough that agents zoomed BoldSign in and then scrolled a page
they could see a third of at a time — and the brokerage's older agents were the ones
paying for it.

- `.modal--workspace` (`src/styles/app.css`): **95vw × 94vh**, no max-width, with the
  body as a flush flex column (`padding: 0; overflow: hidden; min-height: 0`) so the
  **iframe scrolls the document and nothing else scrolls**. Two nested scrollbars is
  what made placing a field feel slippery. Measured: 95% × 94% at 1512×945, 1280×720
  and 900×1200; the phone breakpoint (≤768px) keeps the bottom-sheet treatment at
  100% × 92**dvh** — dvh, so a collapsing mobile address bar can't push the footer
  controls out of reach.
- Document area goes from 900 × 640 to ~1436 × 790 on a 1512-wide laptop — about
  **2× the rendered page**, which is the other half of the readability fix (the first
  half being "stop compressing the source PDF", above).
- `Modal` takes `className` and accepts `width={null}`: an inline pixel width would
  beat the stylesheet and silently defeat both the class and its phone fallback. All
  other `Modal` callers are untouched — the default is still 520px.
- `BoldSignFrame` gains `fill`, which swaps its fixed pixel height for
  `flex: 1; min-height: 0`. The `min-height` matters: an iframe's default minimum
  would refuse to shrink and push the modal footer off screen.
- Applied to the deal's Edit Draft / prepare modal **and** Form Library's template
  editor — the same BoldSign editor, the same people, the same page to read.
- Keyboard and mouse behavior is unchanged: `Modal`'s Escape and backdrop handling
  were not touched, so Escape still routes through the confirm-before-close guard.

## Filing a composed document onto the deal (`document-file`)

**What this fixes.** `document-print` downloads to the agent's own machine, and the
copy it builds is written under a `print/` prefix the Documents tab filters out on
purpose — *"a print artifact is a convenience copy, not a deal document"*. That
reasoning is right for a throwaway review copy, but it left **no way to keep the
filled packet on the deal at all**: an agent who prepared an agreement, filled it
from the CRM and wanted it on the file had to download it and upload it back
through the Documents tab by hand, and the CRM held no record of a document it had
itself composed.

- **Same bytes as the review copy.** `composeFilledPdf()` is shared by
  `document-print` and `document-file`; they differ only in where the bytes go. Two
  composition paths could drift, and the copy an agent *files* must be the copy they
  *reviewed*.
- **Written where the Documents tab actually looks** — `deal-<id>/<timestamp>-<name>`,
  the same flat prefix `upload()` uses. The tab lists one prefix and drops
  sub-folder entries, which is why the `print/` copy is invisible and why the
  filename must not contain a slash (below).
- **`dealFilingName()` sanitizes hard, and it is load-bearing.** A composed name is
  `<template> — <street line>`, so it always carries an em dash and — on a packet
  named like *"Listing agreement/SD agency packet"* — a **forward slash**. Storage
  reads that slash as a folder separator: the document would be filed a level down
  where the Documents tab would never show it. Path traversal is neutralized by the
  same rule. Unit-tested.
- **Accumulates, never overwrites** (`upsert: false` under a timestamp). A filed
  document records what the packet said at a moment; replacing yesterday's copy
  would destroy the history filing it is for. `document-print`, by contrast,
  upserts one throwaway object.
- Logged to `audit_log` as `file`, best-effort — the document is already filed by
  then, and failing the request over a missing audit row would report a success as
  a failure.

### "Saved everything inside BoldSign?"

Both Save PDF and Save to Deal build from **what BoldSign has saved**
(`/document/properties`) — never from what is sitting typed but uncommitted in the
iframe. The old guard was a single `unsaved` flag, and **it under-reported after
the first save**: `onInteract` rides our window's `blur`, which fires when focus
moves *into* the frame, once. Keep typing after a save and focus never leaves, so
no second blur fires, the flag stays false, and the copy was built silently from
the last save — **missing exactly the fields the agent had just filled in.** The
code even carried a comment asserting the opposite ("any further work sets the flag
again via onInteract"), which was never true.

Nothing inside a cross-origin frame is observable, so the fix does not pretend
otherwise:

| State | What happens |
|---|---|
| Focus never entered the editor | Proceeds — no edits were possible |
| Entered, BoldSign never reported a save | **Blocked**: we know the copy is stale |
| Entered, saved at least once | **Asks**, naming the last-saved time |

Blocking outright once the editor had been touched would make the button useless;
building silently is what caused the bug. The confirm states that we cannot see
inside BoldSign and gives the agent the one fact they need to decide.

### The Save button has to be asked for — it was not

The guard above is only honest if a Save exists to point at. It did not.

**`createDraftEditUrl` enumerates the toolbar buttons it wants** — BoldSign renders
that enumeration, and a button the payload never names is not on the toolbar. Send,
Preview and the page navigation were named. **Save was not.** So an agent who opened
a Buyer Agreement or the IA agency packet got an editor with no way to commit what
they typed, and the guard's message — *"Click Save inside BoldSign first"* — named a
button that was not there. Both Save PDF and Save to Deal refused permanently, and
the draft on the Signatures tab stayed as the API had created it: the CRM's prefill,
with none of the agent's own typing on it.

`showSaveButton: true` is now named there, and `ShowSaveButton`/`showSaveButton`
alongside `ShowToolbar` at the two create-time doors (`document-embed-url`,
`createTemplateDraft`), so no path into the editor can be missing it. Asserted in
`api/__tests__/boldsign.test.js`.

**The save event was also misread.** BoldSign's document editor fires
`onSaveClick` for the click and **`onDraftSavedSuccess`** once the save is
committed. Only the first was in `BoldSignFrame`'s `DRAFT` set; the confirmation
ends in `success`, so it fell through to `SUCCESS` and a *saved draft* was reported
as a completed **send** — the iframe torn down mid-prep and the agent told the client
had it. `ondraftsaved` (substring, so it also covers `onDraftSavedSuccess`) and
`onsavesuccess` are now draft events.

### Logging the save path

The failure this whole section is about is invisible from the outside: a draft that
saved empty looks exactly like one that saved with everything on it. So the save path
logs, with the same `documentId` on every line:

| Line | Where | What it answers |
|---|---|---|
| `[boldsign] BoldSign reported a save` | browser | Did a save event arrive at all, and which one |
| `[boldsign] layout capture` | browser | What the capture that rides along with it stored |
| `boldsign.compose: document as BoldSign holds it` | server | **Every field and its value, as BoldSign has it saved** — if the agent's typing is missing here it was never saved, and nothing downstream can recover it |
| `boldsign.file: draft filed on the deal` | server | The final draft: storage path, filename, bytes, field count |
| `boldsign.layout-capture: field arrangement stored` | server | Whether the capture saved, and why not when it didn't |

`summarizeFieldValues()` builds the field rows. **Values are truncated to 60
characters** — they are client data, and the question a log answers is "did the value
arrive", not "what was it in full".

## Per-deal field layouts (placements that stick)
Field placement happens inside BoldSign's embedded editor, and BoldSign keeps it on
the **document**. So the arrangement an agent builds for a deal — the co-seller's
initials on page 3, a label the Iowa packet needs typed in — lived exactly as long
as that one draft. Send it, and the next packet for the same deal came back from the
template with the template's defaults and the agent re-did the work from memory.

`deal_field_layouts` (migration 0026) stores it per **(deal, template)**.

- **Not written back to the shared template.** `form_packets` entries are
  brokerage-wide and compliance-relevant; one deal's arrangement must never rewrite
  the form every other deal sends. `boldsign_documents.boldsign_template_id` is the
  key a layout hangs on.
- **Capture** (`captureFieldLayout`) reads `/document/properties` and normalizes
  `signerDetails[].formFields` — type, page, `bounds`, required/read-only, value,
  label. It reads from BoldSign rather than from what the app *thinks* it sent,
  because the placement being saved is the agent's, made on another origin where the
  app cannot observe it. Triggered from every way a session ends (draft saved, sent,
  closed) **and** from the Sent webhook, so a send completed after the tab closed
  still teaches the next packet.
- **Apply** (`applyFieldLayout`) runs inside `template-embed-url`, after the draft
  exists and before the editor URL is returned, via **`PUT /v1/document/edit`**. The
  response carries `layoutApplied` / `layoutFieldCount` / `layoutWarning` so the UI can
  say the form was deliberately rearranged.
- **The verb matters — this endpoint is a `PUT`.** It was called with `POST`, and
  BoldSign answers a wrong method with a bare `405` and no body, so *every* send
  reported "This deal's saved field layout could not be applied (BoldSign API 405).
  The form opened with its default fields." and no deal ever got its arrangement back.
  `PUT /v1/document/edit?documentId=…` (JSON) is confirmed against BoldSign's own SDK
  (`DocumentApi.editDocument`), which is also where the `EditFormField` property names
  used by `buildLayoutEditPayload()` come from — the docs site is WAF-blocked from CI.
- **A 200 is not proof.** After the edit the draft is re-read and its fields counted;
  `layoutFieldCount` is what BoldSign confirms is on the document, not what was stored.
  Zero fields back is reported as *not applied* rather than as a silent success.
- **Failures name a cause, not a status code.** `describeLayoutFailure()` turns the
  bodyless statuses into a sentence (405 → "rejected the request method", 404 → "no
  longer has this draft", 401/403 → permission, 5xx → server error) and keeps
  BoldSign's own validation text when it sends one. The full response (status, body,
  deal, document, template) goes to the function log either way, and the send still
  proceeds with the template's default placement.
- **An `Add` carries a `name`, never the saved `id`.** To BoldSign, `id` on an edited
  field is a *reference to a field that already exists on that signer* — not a name for
  a new one. Sending the previous document's id on a field the fresh draft doesn't have
  gets the request rejected outright: *"The document does not have a form field with the
  ID: 'CheckBox2'…"* — and `CheckBox2` is exactly the kind of field a layout exists to
  restore (BoldSign's auto-name for a checkbox an agent dropped in by hand). Added fields
  are therefore named, not id'd; BoldSign mints the id and the next capture records it,
  so the field moves onto the `Update` path from then on. `normalizeCapturedField()`
  stores `name` for the same reason.
- **`/document/edit` is atomic, so a field-level rejection is retried.** One unplaceable
  field otherwise costs the agent the entire arrangement. A 400 that names a form field
  triggers a second attempt built with `confirmedOnly: true` — only fields whose ids
  BoldSign is known to hold — and the response carries `layoutWarning` saying how many
  were skipped. Any other failure (auth, document state, malformed body) is not retried:
  it would fail identically.
- **The saved layout is authoritative for that deal**: a field it names is
  repositioned (`Update`) or created (`Add`), and a field the new draft has that the
  layout does *not* name is `Remove`d — otherwise a field the agent deliberately
  deleted would reappear on every send.
- **A removal needs positive evidence, because a capture is lossy.** Absence from the
  saved layout has two causes, and only one of them is a deletion: the agent removed
  the field, or *we could not store it*. `normalizeCapturedField()` returns null for
  any type outside `EDITABLE_FIELD_TYPES` — **`Name`, `Email` and `Phone` among them**,
  which is most of a signature block on an agency packet — and for any field with no
  usable bounds. Treating that gap as a deletion deleted those fields from the next
  draft, on a 200 that reported success, and it was a **one-way ratchet**: the next
  capture read a document that no longer had them, so they never came back and each
  prepare stripped the packet further. A packet degraded this way is also a plausible
  trigger for BoldSign's own editor to throw its generic "unexpected error" page.
  Capture now records `layout.unrestorableIds`, and `canRemove()` refuses to delete
  an id in that list, an id in `commonFields` (sender-filled Labels are captured
  outside `signers`, so all of them looked deleted), or **anything at all** on a
  layout stored before this list existed. Conservative on purpose: a stale field
  creeping back is a nuisance, a deleted signature block is a broken agreement. Rows
  written before the fix self-heal on their next capture.
- **Values are not clobbered.** A field that already has a value on the new draft
  keeps it (that's the CRM's fresh prefill — price, dates, names); the saved value
  only fills a field the new draft left empty, which is the hand-typed-label case
  the layout exists for.
- **`fieldCount` counts only what a restore can put back.** Sender-filled
  `commonFields` are recorded but not counted: `PUT /document/edit` only accepts fields
  nested under a signer.
- **Type spelling.** BoldSign reads back some types under a different spelling than
  it accepts on write (`Textbox` → `TextBox`, `initials` → `Initial`);
  `normalizeFieldType()` maps them, and a type it can't re-create is dropped from the
  layout rather than stored — one bad entry would fail the whole re-apply request. A
  field with no usable `bounds` is dropped too (BoldSign would stack it at 0,0).
- **Restoring a layout never worked on a template with a signature field.**
  BoldSign refuses `IsReadOnly` on nine types (*"IsReadOnly property is not
  supported for the Signature, Initial, Attachment, Date signed, Hyperlink,
  Title, Formula, Drawing and Company form fields"*), and all nine are in
  `EDITABLE_FIELD_TYPES`. `normalizeCapturedField()` stamped `isReadOnly` on
  **every** captured field, so a stored layout containing a signature carried a
  property the edit endpoint will not take. `/document/edit` is atomic, so that
  one field failed the entire restore. Every signable template has a signature
  field, which makes this every layout the feature ever stored.

  It did not read as a layout problem. `describeLayoutFailure()` passes a 400's
  own text through, so the agent got a red toast quoting BoldSign about a
  property they never set, on a send that had in fact created the draft
  successfully. The retry made it worse rather than better:
  `isFieldLevelRejection()` matches `/form field/i` and the message ends in
  "form fields", so it was retried as though a single field were unplaceable,
  and the second attempt carried the same property and failed identically.

  `supportsFieldReadOnly()` now gates it in **two** places: `normalizeCapturedField()`
  stops storing the property on those types, and `buildLayoutEditPayload()` strips
  it at emission so layouts **already in the database** heal on their next use
  instead of needing a backfill. Types that do accept a lock (`TextBox`, `Label`,
  `CheckBox`, …) are unaffected and still restore read-only.

  Kept as its own list rather than imported from
  `src/lib/services/boldsignFields.js`, which governs the send payload: this file
  imports nothing from `src/` by design. A test asserts every spelling in it is
  one `normalizeFieldType()` actually produces, so the two cannot drift into
  silently not matching.
- **Never fatal, either direction.** Capture and apply both swallow their own
  failures: a capture failure loses only the convenience, and an apply failure means
  the draft opens with the template's default placement — the behavior that existed
  before layouts. A database without migration 0026 reads as "this deal remembers
  nothing" (`isMissingLayoutStorage()`), so no send is decorated with a provisioning
  error the agent can't act on.
- Unit-tested in `api/__tests__/boldsign.test.js` (normalize, signer matching,
  Update/Add/Remove, both value-precedence rules).

## Drafts cleanup (Signatures tab)
- **Filter dropdown**: Active (default — hides completed, so drafts are visible) / Drafts only / Completed only / All.
- **Delete** (trash icon, shown on any non-`completed` row): calls `document-delete`, which **revokes** the document in BoldSign first if it's still in progress (BoldSign requires `completed`/`revoked`/`declined` before `DELETE`), then deletes it there, writes an `audit_log` entry, and removes the local `boldsign_documents` row. Completed (signed) records are refused — they're the legal record and aren't deletable from this action.
- **A draft is never revoked first.** Revoke means "recall a document that is out with signers"; BoldSign answers a bare **403 `Forbidden`** when asked to revoke one that was never sent. Only a 400 used to be tolerated, so that 403 surfaced to the agent as "Forbidden" on the one status that is always safe to remove — their own unsent draft. The live status is read from `/document/properties` (not trusted from our row, which a missed webhook can leave stale at `draft`), revocation is limited to documents actually in flight, and a 400/403 from either call on a genuine draft is logged and stepped over so the row still clears.

## Embedded signing/sending (iFrame)
- `<BoldSignFrame>` (`src/components/BoldSignFrame.jsx`) renders the URL and relays completion to `onDone`/`onError`. Completion is detected three ways (see the header comment), because **the embedded template editor and the document flows emit different events**:
  - Document send/sign → `onCreateSuccess` / `onDraftSuccess` / **`onDraftSavedSuccess`** / `onSendSuccess` / `onSuccessfullySigned` / `onSigningComplete` / `onDocumentSigned`. The saved-but-not-sent ones (`onDraftSuccess`, `onDraftSavedSuccess`, `onSaveClick`) route to `onDraft`, not `onDone` — see "The Save button has to be asked for" above.
  - **Template editor → `onCreateClick` / `onSaveClick` / `onSaveAndCloseClick`** (the data arrives as `{ status }` from `https://app.boldsign.com`). These were *not* in the original success set, which is why a saved template silently never wrote back to the Form Library — the "done" signal was dropped and the iframe's `RedirectUrl` (pointed at `window.location.href`, i.e. the CRM) loaded the whole CRM inside the popup instead.
  - The event/origin rules are a pure exported function, `classifyBoldSignMessage()`, unit-tested in `src/components/__tests__/BoldSignFrame.test.js`.
- **Return-page fallback.** The template editor's `RedirectUrl` now points at `public/boldsign-return.html` — a tiny same-origin page (so the CRM doesn't re-render inside the iframe). `BoldSignFrame` detects the return two ways: the page posts a `gwTemplateEditorDone` message, and the iframe's `load` event reads the same-origin URL and matches the `returnUrlMarker` prop. `FormLibrary` guards against the two signals double-saving with a ref.
- The client portal (`ClientPortal.jsx`) shows "Documents to Sign" and opens the signing UI in a full-screen overlay.
- Form Library's "Build in BoldSign" / "Rebuild in BoldSign" (`FormLibrary.jsx`) and both send flows in `Pipeline.jsx` all use the same component — template authoring is no longer a separate `window.open` tab.
- **Required:** add prod + preview domains to BoldSign → Settings → Embedded → Approved domains, or iframes are blocked. The `RedirectUrl` domain (your own origin) is already covered by this.

## Templates — authoring & catalog

**Authoring (in BoldSign):**
- **Preferred: Text Tags.** Type `{{fieldType|signerIndex|required|label|fieldId}}` directly into the source document at each blank, using a CRM token as `fieldId` (see the token list below) — the same string both places the field and tells the CRM what to prefill. Upload with `useTextTags: true` (the "PDF has text tags" checkbox in Form Library / the ad-hoc send modal) and BoldSign auto-places fields on create/send. See `buildTextTag()` in `src/lib/services/boldsign.js` for a builder helper, and BoldSign's text-tags/supported-fields + advanced-usage docs for the full tag syntax.
- **Alternative: visual editor.** Build/adjust via the embedded template editor (`template-editor-url`, opened from Form Library's "Build in BoldSign").
- **Role convention:** Role 1 = Seller/Client, Role 2 = Listing Agent (same order across all state templates). Recipient name/email in the template are placeholders; the CRM overrides them per send and drops unused roles via `roleRemovalIndices`.
- **Shared data must be a `Label` field.** A field assigned to a role is invisible to the other signers until that role signs, so anything all parties must read up front (address, price, commission, dates, reference numbers, and any box we tick for them) belongs in a **Label**, not a Textbox/Name/Email. Full rationale and the code path: "Prefilled data every signer must see" below. In a text tag that is `{{Label|1|false|List price|list_price}}`.
- **Never a `Name` field for someone else's name.** A Name field always prints the name of the signer it is assigned to and ignores any value sent for it, so using one for the appointed agent, a co-seller or a trustee puts the *wrong* name on the document rather than a blank. Use a **Label**. See "Never use a Name field for a name that is not that signer's own" below.

**Package templates (multiple files in one template):**
- A packet's PDF upload is **multi-file** — add a listing agreement + disclosures + addenda and "Build in BoldSign" sends every file as a repeated `Files` field to `createEmbeddedTemplateUrl`, which **combines them into one template document** (in the order shown). The admin then places fields across the whole combined document in the embedded editor. This is BoldSign's single-template-from-many-files behavior, not the separate mergeAndSend-at-send-time feature.
- All source files are stored on the packet: `form_packets.storage_paths` (jsonb `[{ path, name }]`, migration 0022) holds the ordered list; `storage_path` stays the primary/first for back-compat. "Get Forms" downloads every file. `FormLibrary`'s save degrades gracefully (drops `storage_paths`) if 0022 hasn't been applied yet.

**Catalog (in the CRM — Form Library):**
- Register a template by pasting its BoldSign template id into a Form Library entry (Settings → BoldSign links here too), along with `state`, `doc_type`, and comma-separated `field_tokens`. The entry shows a **Sendable** badge and becomes selectable in a deal's "Send from Template" picker, filtered to the deal's state.
- **Nightly drift sync** (`GET /api/cron?task=boldsign-sync`, 3am): calls `template-list` and reconciles the catalog —
  - **deactivates** any linked entry whose template was deleted in BoldSign;
  - **draft-registers** (inactive) any BoldSign template not yet in the catalog, but *only* when its title confidently maps to one of `OPERATING_STATES` (`detectStateFromTitle()`) — ambiguous titles are reported in the job's response, never guessed, since `state` is compliance-relevant;
  - never overwrites an admin-set name/state/tokens on an existing entry, and never auto-activates a draft — an admin reviews and flips `active` in Form Library.

## Signer auto-fill (Send from Template)
When an agent picks a template on a deal's Signatures tab, the signer name/email rows are pre-filled by `seedSignersFromDeal()` (`src/lib/services/boldsign.js`, unit-tested):
- **Agent/broker/realtor roles** → the agents **on the deal**, in order. The source is the same one the "Agents on deal" card uses (`dealAgentList()`, mirroring `src/pages/DealPage.jsx`): `deals.agent_id`, then legacy `deals.co_agent_ids`, then `commissions.participants`, deduped. The acting agent is promoted to the first agent role when they're on the deal; when they aren't — an admin or TC sending on someone's behalf — the deal's own agents fill the roles, because the listing agent should sign the listing agreement, not whoever clicked Send. Commissions are admin-only under RLS, so a regular agent sees owner + `co_agent_ids` — the same people their deal page shows them.
- **An agent role is never filled with a client.** `CLIENT_ROLE_RE` is substring-based and several professional roles contain a client keyword, most importantly **"Buyer's Agent"** (matches `/buyer/`). A template with roles `[Seller, Listing Agent, Buyer's Agent]` used to seed the **co-buyer's** name and email into the buyer's-agent signature slot — the acting agent consumed the first agent role and the second fell through to the client branch. The row looked plausible, and sending it asked a client to sign as their own agent. It was also order-dependent, so the same three roles in a different order behaved correctly and the bug wouldn't reproduce on demand. `NON_CLIENT_ROLE_RE` now blocks agent/broker/realtor/attorney/escrow/title/lender/notary/witness roles from client seeding; with no agent left to assign they stay blank or keep the template placeholder.
- **Client-type roles** (seller/buyer/client/owner/purchaser/grantor/grantee/landlord/tenant/lessor/lessee/borrower/customer/signer) → the deal's people, in order: the **primary contact** (`deals.contact_id`), then any **Additional Contacts** linked to the deal (`deal_contacts` — migration 0021), so a template with two signer roles gets the primary and the co-buyer/spouse, each with their own email.
- If no additional contacts are linked but the primary contact has a stored **spouse name**, that fills a second client role (name only — spouse email isn't stored).
- Those Additional Contacts normally arrive from the **property**: "Start Deal" copies its `property_contacts` onto the new deal. A deal that never got that copy — converted before the carry-over shipped, or built from scratch and linked to a property later — used to reach the packet with the primary contact alone. The drawer now **seeds an empty picker** from the linked property's list (`propertyExtrasNotOnDeal()`, `src/lib/dealPeople.js`), so the co-owner gets their own signer row and persists to `deal_contacts` on save. A picker that already has someone in it is never overwritten — re-adding a person the agent removed from the deal would put them back on the next send — so the remaining property contacts appear as a one-click "Also on this property" suggestion instead. Removing the last extra empties the picker, which looks identical to "never had one", so the drawer also remembers removals for the session; after a full page reload a person still linked to the property is offered again (as a suggestion, and as a seed if the deal has no extras at all). Taking a co-owner off the property itself is the permanent fix.
- Any other role (e.g. Witness) keeps the template's placeholder.

The agent can edit every field before sending. **Prerequisite:** the deal must have a linked Contact (`deals.contact_id`) with an email — if a deal has no contact, client rows fall back to the template placeholder (usually blank). Link co-signers via the deal drawer's **Additional Contacts** picker so they seed with real emails.

## Selections the agent makes (tick boxes, dates) — set them in the CRM, not in BoldSign
A box the agent ticks inside BoldSign's **embedded editor** is a placement-time
preview: the agent sees "Exclusive Agency" checked, sends the packet, and the
client opens it unchecked. That editor is for *where fields go*, not *what they
say*. Field values only reach signers when they travel with the send, as
`roles[].existingFormFields`.

So the send modal now offers every **prefillable** field, not just the text ones:

- `isFillableField()` — text/label/dropdown/date-ish → a text input, or a
  `<select>` of the template's own options when it has them.
- `isTickableField()` — `CheckBox` / `RadioButton` → a three-way **Signer decides /
  Checked / Unchecked** control. Three-way on purpose: "unticked" and "left to the
  signer" are different instructions, and collapsing them would either lock every
  box the agent didn't touch or lose a deliberate "no" on a form where an unticked
  box is itself a term.
- `isSignerBoundField()` — `Name` → **no control at all.** BoldSign prints the
  assigned signer's own name and discards anything sent for it, so the field is
  listed as a template defect instead of offered as an input. See "Never use a
  Name field for a name that is not that signer's own".
- `prefillFieldEntry()` turns each one into its `existingFormFields` entry
  (`"true"` / `"false"` for a box) and stamps **`isReadOnly: true`** — what the
  agent decided is what every signer sees, and none of them can change it after the
  send. All three are pure and unit-tested in `src/lib/services/__tests__/boldsign.test.js`.

### Some types refuse to be locked, and say so by failing the whole send
BoldSign rejects `IsReadOnly` outright on nine field types:

> IsReadOnly property is not supported for the Signature, Initial, Attachment,
> Date signed, Hyperlink, Title, Formula, Drawing and Company form fields.

It is a hard failure on the **entire send**, not a warning about the one field,
so a single box takes the whole packet down and names a property the agent never
set on a field they may not know is there. Seen live on the IA Agency Packet.

Two of the nine are reachable from our own send screen. **Company** and **Title**
are in `FILLABLE_FIELD_TYPES`, because they are legitimately values an agent
fills in (the brokerage, the signer's role on the agreement), so both render as
inputs and both used to be stamped read-only like everything else. Any packet
with a brokerage box hit this.

`READONLY_UNSUPPORTED_FIELD_TYPES` / `supportsReadOnly()` encode the list, and
`prefillFieldEntry()` now makes the lock conditional while the value is not.
The property is **omitted** rather than sent as `false`: the message says it "is
not supported", which reads as presence rather than value.

So a prefilled Company or Title goes out editable by its signer. That is not a
choice, it is the only state BoldSign will accept, and a prefilled box the signer
could retype is worth incomparably more than a packet that refuses to send.
**Where a value must be both locked and legible to every party, the answer is the
same as everywhere else on this page: put it in the template as a `Label`**,
which takes a lock and is common to the document.

Matching ignores spacing and casing, so `DateSigned`, `Date signed` and
`date_signed` are one type; `initials` is listed beside `initial` because
BoldSign reads that type back under both spellings.

**The saved-layout path had the same bug, and worse.** See "Restoring a layout
never worked on a template with a signature field" under Per-deal field layouts.

Where each of those values *lands* — one shared copy visible to everyone, or one
signer's private field — is decided by `buildPrefillFields()`; see "Prefilled data
every signer must see" below. The modal renders the two groups separately
("Shared details" / "Signer details") so it is visible before sending which is
which.

`template-details` returns `label`, `required`, `value` and `options` alongside each
field's `id`/`type`/`roleIndex` so those controls can be rendered with the
template's own wording rather than a prettified field id.

## Per-signer state — who is actually holding it up

**A document's status and a signer's status are different things.** The document
is `sent` until everyone is done; each signer is somewhere between "hasn't
opened it" and "signed". Every send stored its full signer array and the UI
rendered `signer_name` — a comma-joined string of everybody — plus one chip for
the document as a whole. On a four-party packet an agent could see it was
unsigned and could not see *who* was holding it up, which is the only fact that
decides what they do next. The data was being collected and thrown away.

`src/lib/services/boldsignSigners.js` is the shared, pure model
(`api/boldsign.js` and `api/cron.js` import it directly, the same way they
import `boldsignCaptions.js`). It normalizes to:

| state | means |
|---|---|
| `signed` | done |
| `viewed` | opened it, hasn't signed |
| `waiting` | has it, hasn't opened it |
| `queued` | **derived** — sequential send, BoldSign hasn't emailed them yet |
| `declined` / `expired` / `revoked` | terminal, not chaseable |

`queued` is the one that isn't BoldSign's. On a sequential send the people
behind the active signer have not been asked yet, so showing them as "waiting"
sends an agent chasing someone who never received anything. Because these rows
are persisted to `boldsign_documents.signers` and read back,
`normalizeSignerStatus` is **round-trip safe** — without that, `queued` decayed
to `waiting` on every reload.

### Where the state comes from

- **Webhook** — written on *any* delivery carrying `signerDetails`, not only one
  that advances the document. "Jane signed, John hasn't" does not move the
  document off `sent`, so gating this on `advanced` would discard the one event
  that says who to chase. **Monotonic**: deliveries are unordered, so a payload
  is written only when it knows at least as much as the row already does.
- **Status refresh** — `action: 'status'` returns normalized `signers` alongside
  the document status, and the Signatures tab stores them. A document sent
  before per-signer state existed fills in the first time anyone refreshes it.
- **Legacy fallback** — `signerRows()` reconstructs people from the comma-joined
  columns when there is no array, so old rows still render as a list.

### Reminders are targeted

`/document/remind` takes repeated `receiverEmails` query parameters. Without
them BoldSign emails **every** pending recipient — including, on a sequential
send, people it has not asked yet. Reminding someone who has already signed, or
who cannot yet act, is how a client learns to ignore the next one.

- The `remind` action reminds whoever the row still shows as outstanding, or
  exactly the `signerEmails` the caller names.
- **The list is filtered against the document's own signers.** `signerEmails`
  comes from the browser, and an unchecked pass-through would turn the endpoint
  into a way to send brokerage-branded mail to any address through our BoldSign
  account.
- The nightly sweep (`api/cron.js`) targets the same way. It is the one that
  runs unattended and therefore the one most able to train a client to ignore
  us. No recorded signer state falls back to BoldSign's default rather than
  skipping the reminder.
- **BoldSign allows one manual reminder per document per day.** That 400 is
  translated into a sentence an agent can act on rather than surfacing bare.

### What the agent sees

- The Signatures row leads with **"waiting on John Doe"** and, on a multi-party
  packet, `2/4 signed`.
- In-flight documents with more than one recipient expand into a per-signer
  strip: order badge, name, role, state ("opened Aug 14", "not their turn yet"),
  and a per-person **Nudge** — offered only to someone who can actually act.
- The send confirmation lists recipients **in signing order, one per line, with
  addresses**. The mistake it exists to catch is sending the right document to
  the wrong people, and a comma-joined run-on line is what a person skims past.
- The dashboard queue (`SignatureQueue`) uses the same model, so "waiting on
  John Doe" reads identically in both places.

## Send options — brand, CC, expiry (and the reminder we deliberately don't use)

**BoldSign fixes all of these when the document is CREATED and refuses to
change them afterwards.** That single fact decides the whole design: they ride
on the draft-creating call, and the UI asks for them on the prepare screen. By
the time an agent is looking at a Send button it is already too late to set an
expiry or add a copy recipient.

`buildSendOptions()` in `api/boldsign.js` produces the partial payload every
JSON creation path spreads in (`/template/send`, `/template/createEmbeddedRequestUrl`);
`appendSendOptions()` does the multipart equivalent for the two ad-hoc PDF paths.

| Option | Where it comes from | Notes |
|---|---|---|
| `brandId` | `BOLDSIGN_BRAND_ID`, else the Gateway brand in code | Applied to **every** send. Not the agent's to choose |
| `cc` | Send options → "Send a copy to" | Normalized to `[{ emailAddress }]`, deduped case-insensitively, malformed addresses dropped, **capped at 10** — a "copy everyone" list is a way to leak an agreement, not a feature |
| `expiryDays` | Send options → "Expires after" | Clamped to 1–180. Blank means the account default, not "no expiry we imposed" |
| `reminderSettings` | **not wired to any UI** | See below |

**Every field is omitted when unset.** A payload that always carried
`expiryDays: null` would be us overriding the account's own default with
nothing.

### Why BoldSign's auto-reminders stay off

BoldSign will chase signers for you (`enableAutoReminder`, `reminderDays`,
`reminderCount`). We don't use it, and that is a decision rather than an
omission: **the CRM already owns chasing.** The nightly sweep decides when a
document is stale, and since the per-signer work it reminds only the people who
still owe something — which BoldSign's own reminder cannot do, because it has no
idea our sequential sends leave later signers un-notified.

Turning both on means two systems emailing the same client on two schedules,
which is exactly how a client learns to filter you out. One reminder authority,
and it is ours. `normalizeReminders()` is implemented, clamped and tested so
this is a one-line change the day that judgment changes.

### Multipart carries only the scalars

`appendSendOptions()` sets `BrandId` and `ExpiryDays` on the two ad-hoc PDF
paths and stops there. BoldSign documents `cc` and `reminderSettings` as
objects, and how a multipart body nests those is not something this file will
guess at — **this integration has already retired one feature built on a guess
about BoldSign's wire format** (the coordinate auto-placement). The template
paths, which are how the CRM actually sends agreements, carry the full set as
JSON.

### Still unused

`in-person signing` (a host signer for a client at the table), `scheduled send`,
and SMS delivery / SMS-OTP authentication. SMS is blocked on Twilio, which the
brokerage has not connected yet; the other two are unbuilt, not undecided.

## The terms panel is declared per packet, not per app

**The decisions a packet asks its sender for — Representation, Term, agency
Policy — belong to that packet and are bound to its own field ids.** This used
to be one hard-coded map (`CheckBox1` … `CheckBox9`) applied to every template
the send screen opened, and that is not survivable: **BoldSign auto-assigns
`CheckBox1`, `CheckBox2`, … on every template it creates**, so those ids are
shared across the whole catalog. Registering a second template with tick boxes —
a seller listing agreement, a disclosure, a Nebraska form — meant the Iowa buyer
packet's answers were written onto that template's first nine boxes as locked
terms of a signed agreement, silently. The same map also gated *both* send
buttons, so a listing agreement could not be saved as a draft until the agent
answered two buyer-agency questions that did not apply to it.

A panel is now a **declarative spec on the packet row**
(`form_packets.signing_panel`, migration 0043), read and enforced by
`src/lib/services/boldsignPacketPanel.js`:

```jsonc
{ "version": 1, "key": "ia_buyer_agency_v1", "groups": [
  { "key": "representation", "kind": "choice", "label": "Representation", "required": true,
    "options": [
      { "key": "exclusive",     "label": "Exclusive",     "fieldId": "CheckBox1", "expect": "^(?!.*non-?\\s?exclusive).*\\bexclusive\\b" },
      { "key": "non-exclusive", "label": "Non-exclusive", "fieldId": "CheckBox2", "expect": "non-?\\s?exclusive" }
    ] }
] }
```

Three group kinds: `choice` (radios; the mutex is structural, `required` gates
the send), `toggles` (independent state, collapsed by default), `fixed` (never
rendered, written at its stated value — "this is a buyer packet, so the BUYER
box is ticked"). `expect` is a **regex source string**, not a RegExp, because a
panel round-trips through jsonb; it is compiled at load and matched against the
caption read off the page.

### Two modes, and the difference is the whole design

| | Where it comes from | A validation failure means |
|---|---|---|
| **Declared** | `form_packets.signing_panel` | **The send is blocked** and the field is named on screen. An admin asserted these ids mean these things here, so quietly dropping the panel would send the agreement without the terms it exists to set. |
| **Inferred** | A built-in panel matching the packet's `(state, transaction_type)` | **No panel at all.** Nobody asserted it applies, so a failure means "this isn't that packet". |

An inferred panel is applied only if it validates **completely**: every field id
present, every one a tick box, and every one captioned the way the panel
expects. "Probably the Iowa packet" is not good enough to lock terms onto an
agreement. This is what keeps the Iowa buyer packet working on a database where
0043 has not been applied, without ever reaching another template by accident.

### What validation checks

- `missing_field` — the panel names an id the template does not have → **blocking**
- `not_tickable` — the id exists but is a TextBox/Label, not a tick box → **blocking**
- `caption_conflict` — the page prints something else beside that box → **blocking**
- `no_caption` / `unverifiable` — nothing to check against (scanned or image-only
  page, or no `expect`) → **warning**, shown as a count, never blocking

Blocking defects render as a red panel above the buttons naming the decision,
the box and what the page actually says, and both send buttons are disabled.
This was previously a `console.warn` nobody was watching.

### The floor under it, server-side

`api/boldsign.js` refuses any template send whose payload addresses a field the
template does not have (`assertPayloadFieldsExist`, checking
`roles[].existingFormFields`, `sharedFormFields` and `fieldRemovalIds` against a
cached `/template/properties`). Best-effort by design: if BoldSign cannot be
asked, the send proceeds unvalidated rather than failing, because refusing every
send during a BoldSign blip is a worse failure than the one being guarded
against. This catches the same class of bug from any caller — a future client, a
typo'd token id, an AI agent driving the API.

### Boxes the panel does not own

Every other tick box on the form is offered as a **tri-state** selection named
from its printed caption: *As the form is* (default — no value sent, the form's
own setting stands), *Checked*, *Unchecked*. That default is what makes opening
the send screen safe on a template nobody has configured: it cannot change a box
by itself, and the agent can still tick one deliberately.

### Adding a panel to a packet

1. Open the packet in **Prepare Draft Agreement**. The status line under the
   template picker says whether a panel applies and whether it verifies.
2. Confirm the field ids against the form in BoldSign.
3. Run the `update form_packets set signing_panel = …` block at the bottom of
   `migrations/0043_form_packet_signing_panel.sql` — **for one packet, by id**.
   Never by state alone: two Iowa buyer packets built from different source PDFs
   do not share field ids.
4. Setting it back to `null` reverts to the self-validating fallback.

## Selections is the sender's panel, not the signer's

One row is one checkbox already placed on the template, and the dropdown is the
**sender** deciding what the packet goes out saying — `Checked` or `Unchecked`,
locked onto the document before the signer ever sees it. There is no third
"Signer decides" state: these boxes are terms of the agreement (which
representation, which party, which term length) and leaving one unset left a term
to whoever opened the document.

- **Row names come from the printed caption**, never the field id — see the next
  section. `src/lib/services/boldsignSelections.js` maps a caption to a short
  label ("non-exclusive" → *Non-exclusive representation*). Rule order is load
  bearing: `non-exclusive` is tested before `exclusive`, and the policy clauses
  before the bare party words, or "2. SINGLE BUYER AGENCY" is labelled as the
  party box. Unrecognized wording keeps its printed caption; only a box the page
  could not caption at all still shows its id, marked "unnamed on the page".
- **Rows are ordered as they appear on the paper** (page, then top to bottom).
  BoldSign returns placement order, which is neither document order nor stable.
- **Each row defaults to what the template already carries** — a box the packet
  was authored with stays ticked, so the sender confirms it rather than silently
  clearing it.
- **Mutex groups are enforced in the panel**: ticking Exclusive unticks
  Non-exclusive, ticking Term A unticks Term B. Unticking never ticks anything —
  clearing both is a valid intermediate state, and choosing the other one would
  be the panel deciding a term on the sender's behalf. The groups are asserted
  from the packet's rules, not read off the page: page 1 prints "CHECK ALL BOXES
  THAT APPLY" above the representation pair.
- **Every row is written on save.** `prefillFieldEntry` turns each `true`/`false`
  into a read-only `"true"`/`"false"` on the matching BoldSign field id, so both
  doors out of the prepare screen carry the tick states — they build one payload.

Consequence worth knowing: because no checkbox is left unset any more, a box a
signer used to be able to tick themselves now goes out locked as the sender left
it. That is the intent for agreement terms; a template that genuinely wants a
signer-ticked box needs that box left off the template's field list.

## Naming a field nobody named — captions read off the PDF

BoldSign auto-names a placed field by type plus a counter, so a template whose
fields were never captioned in the editor reaches the send screen as `Checkbox1`,
`CheckBox11`, `Label7` — in *placement* order, which is neither document order
nor anything an agent can read. On the live Iowa buyer-agency packet that is 14
tick boxes with no captions, several of which are terms of the agreement:
exclusive vs non-exclusive representation, which party the client is, which of
two term lengths applies. The agent is asked to set them before sending and given
nothing to set them *by*.

Hand-mapping the ids in a table fixes one template until somebody moves a field,
and a mis-mapped id locks the **opposite** term onto an agreement a client then
signs. The document already carries the answer: the words printed beside the box.

**How it works.** On `template-details`:

1. `templateCaptions()` (`api/boldsign.js`) downloads the template PDF once —
   `GET /template/download` — and caches the result per template for 10 minutes.
2. `extractPdfWords()` (`api/_lib/pdfText.js`) extracts every text run with
   coordinates via pdf.js, converted into **BoldSign's frame**: origin at the
   page's top-left, y growing downward. pdf.js reports the *baseline* in
   bottom-left space; using it as the top shifts every word down a full line and
   matches boxes against the line below their label.
3. `resolveBoundsScale()` decides points-per-bound-unit from evidence — the same
   helper the print path uses. BoldSign's bounds are not necessarily points, and
   a caption matched at the wrong scale lands on whatever text sits at 0.75 of
   the real position: a plausible wrong answer. No scale resolves → no captions.
4. `captionFields()` (`src/lib/services/boldsignCaptions.js`) matches each
   field's box against the words on its line and returns a caption.

Fields come back with `page`, `bounds`, and (where the page named them)
`caption`. A captioned field is no longer folded behind the "unnamed template
fields" toggle — the page named it, so it belongs in the list.

**The rules that keep a caption honest** (all covered by tests built from
generated PDFs, in `src/lib/services/__tests__/boldsignCaptions.test.js`):

- **Nothing is guessed.** A box with no words beside it gets no caption at all
  and the screen falls back to what it showed before. A wrong caption on a box
  that locks a term is worse than no caption.
- **A caption stops at the next field box on the line.** `[ ] BUYER or [ ] SELLER`
  captions the first box "BUYER", not "BUYER or SELLER" — which would name either
  choice equally well on a box about to be locked.
- **A caption stops at an unbalanced closing bracket.** The box sits *inside*
  "(non-exclusive)", so the sentence carrying on past it is not part of the choice.
- **A caption ends at the first sentence break** long enough to leave something
  behind, which is what turns a whole policy clause into "3. APPOINTED AGENCY"
  while keeping the "3." the document refers to it by.
- **Right beats left.** On every agency form seen, the box precedes its label.
  A leftward caption is reported as low confidence.

**Printed instructions are quoted, never enforced.** `detectSelectionCues()`
finds sentences like "check either A or B" and "check only one" and the send
screen shows them under Selections. It does not turn them into a constraint,
because the page is evidence about the page and not about the packet: page 1 of
the buyer packet prints "CHECK ALL BOXES THAT APPLY" directly above the
exclusive / non-exclusive pair that a buyer packet must nonetheless treat as
one-or-the-other. That rule lives with the packet
(`docs/ia-buyer-packet-selections.md`), not in the engine.

**Failure is always silent and total.** No PDF, an unparseable one, no
resolvable scale, pdf.js missing — every path returns no captions rather than
bad ones, and the payload is exactly what it was before captions existed.

## Prefilled data every signer must see — use Label fields

**BoldSign's default hides prefilled data from everyone but the field's own
signer.** A form field belongs to a role, and the other recipients cannot see it
— or the value we prefilled into it — until that role has finished signing. On a
two-party listing agreement that means the co-seller opens the packet and finds
the price, the dates and the commission blank, because those fields sit on the
listing agent's role. Nothing about the send is broken; that is simply what
role-scoped fields do.

**The fix is the Label field.** A Label is a *common* field:

- every signer sees it the moment the document is sent, in any signing order;
- no signer can edit it — it is read-only by construction;
- its value is supplied at send time through **one** role's
  `existingFormFields`, because it is not scoped to a role at all.

([BoldSign KB 19096](https://support.boldsign.com/kb/article/19096/prefill-form-fields-to-be-visible-to-both-signers-when-using-templates-via-api))

### Template rule (authoring)
Anything **every party must be able to read immediately** — property address,
list price, commission, listing/closing dates, reference numbers, the parties'
own names as printed on the agreement, and any box **we** tick on their behalf —
goes in the template as a **Label**, *never* as a Textbox/Name/Email/Company
assigned to a role. Give the Label the CRM token as its name and it auto-fills
(see "CRM prefill tokens").

Keep role-scoped field types (`Textbox`, `CheckBox`, `Email`, …) for what that one
signer supplies **themselves** — a licence number, a box the signer chooses. That
is the only case where per-signer visibility is the right behavior.

### Never use a Name field for a name that is not that signer's own
A BoldSign **Name** field always renders the name of the signer it is assigned
to. A value supplied for it in `existingFormFields` **does not override that** —
BoldSign accepts the value and then ignores it. (Confirmed by BoldSign support.)

This is the worst failure mode in the integration, because it is silent *and*
plausible: the send screen showed `Alex Agent` in the box, the payload carried
it, BoldSign returned 200 — and the client received an Appointed Agency
Agreement with the **seller's** name on the appointed-agent line, because that
is the role the field happened to sit on. A blank would have been better.

So:

- a name that is **not** the assigned signer's own → **Label** (+ CRM token);
- the signer's own name → leave the Name field alone and send **nothing** for
  it; BoldSign fills it from the signer;
- read-only does not help here, and neither does signing order. The value never
  reaches the field at all.

The code enforces this rather than trusting the template: `Name` is in
`SIGNER_BOUND_FIELD_TYPES`, `isFillableField('Name')` is `false`, and
`prefillFieldEntry()` returns `null` for one, so no value is ever sent for a Name
field. It stays *discoverable* (`isPrefillableField('Name')` is `true`) purely so
`signerBoundPrefillFields()` can report a misused one instead of hiding it.

**Changing a placed field's type is not possible in the BoldSign editor.** Delete
the Name field and place a **Label** at the same coordinates — see "Remediating a
template" below.

### Boxes we tick are terms, not signer input
A `CheckBox` we pre-select (Exclusive Agency, who pays what) is a **term of the
agreement**, not the signer's own input, so it is subject to exactly the same
visibility rule as the price: read-only stops the assigned signer editing it, but
the other parties still cannot see it until that signer's turn. Where all parties
must see the selection up front, the template needs the state shown as a **Label**
(or the box assigned to the first signer, on a fixed sequential send).

`prefillFieldEntry()` keeps checkboxes three-state on purpose — `true` / `false` /
`null` — because "unticked" and "left to the signer" are different instructions,
and only the first two are values we are asserting.

### Send rule (code)
`buildPrefillFields()` (defined in `src/lib/services/boldsignFields.js`, re-exported
from `src/lib/services/boldsign.js` — import it from either) is the single place that
decides where a prefilled value goes, and it splits the payload in two:

| | goes out as | who sees it | editable |
|---|---|---|---|
| **Label** field | top-level `sharedFormFields` | every signer, immediately | no |
| role-scoped field | `roles[].existingFormFields` | its own signer until they sign | no (`isReadOnly`) |
| **Name** field | *nothing is sent* | — | n/a — BoldSign prints the signer's own name |

- A Label's own `roleIndex` in the template is ignored — that is the whole point.
- A role-scoped field whose role this send drops falls back to the anchor role
  rather than being lost.
- `partitionPrefillFields()` returns the same split as
  `{ shared, signerSpecific, signerBound }` for anything that needs to *display*
  the distinction.
- The API (`api/boldsign.js`) takes `sharedFormFields` on `template-send`,
  `template-draft` and `template-embed-url`, and `mergeSharedFormFields()`
  attaches it to the **first role**, forces `isReadOnly: true`, and strips any
  role-scoped copy of a shared id so a per-signer value can never shadow the
  Label. It is idempotent and does not mutate its input.
- `template-details` collects fields from the template's top-level `formFields`
  **and** from each role's nested list, deduped by id — a Label missed here would
  silently drop a shared value from the send.

### When a template still has it wrong
The CRM cannot change a template field's type from code — BoldSign has no such
API, and the editor cannot retype a placed field either. What the code does
instead is **refuse to send anything that would be silently wrong, and name the
template field that needs fixing.** Two audits run on every open of the send
modal:

| audit | finds | severity | shown as |
|---|---|---|---|
| `signerBoundPrefillFields()` | a **Name** field carrying a CRM token or a typed value | defect — the document will print the **wrong name** | red panel, names each field, its role and the token it was meant to show |
| `sharedDataOnSignerFields()` | any value **we** supply (token, typed text, or a pre-ticked box) on a role-scoped field that some party cannot see | gap — a party reads a **blank** | amber panel, names each field and its role |

`sharedDataOnSignerFields()` stays quiet in the two sanctioned cases: the value
is on a **Label**, or it is on the **first signer of an in-order send**. It
deliberately does *not* limit itself to CRM tokens — that older gate could never
match a checkbox, so every box we pre-ticked went out unreported.

### Auditing every template at once
The send modal only reports the template an agent happens to be using. To sweep
the whole account:

```
npm run audit:boldsign            # BOLDSIGN_API_KEY must be in the environment
npm run audit:boldsign -- --all       # include the healthy fields too
npm run audit:boldsign -- --json      # machine-readable, for diffing between runs
npm run audit:boldsign -- --template=<id>
```

`scripts/audit-boldsign-templates.mjs` is **read-only** — GETs only, and field
types cannot be changed through the API in any case. It classifies every field in
every template and prints, per defect, the field's caption, type, role, page and
coordinates, plus the fix. Exit code is `1` when it finds something, so it can
gate a deploy. Severities:

| | means |
|---|---|
| `WRONG NAME` | a `Name` field carrying a CRM token — the document prints the assigned signer's name instead |
| `HIDDEN` | a prefilled value (or a pre-tickable box) on a role that is not the first signer — someone reads a blank |
| `REVIEW` | a prefilled value on the first signer — correct today, but only while the send stays in order |

It shares its rules with the app rather than reimplementing them:
`src/lib/services/boldsignFields.js` is the pure field model (no network, no
Supabase, loads under plain Node) and `src/lib/services/boldsign.js` re-exports
all of it for the browser, so the audit and the send path can never disagree
about what a field type means.

### Remediating a template
Per field, in the BoldSign template editor:

1. Note the existing field's **page, position and size** before touching it — the
   replacement must land in the same place, and the type cannot be changed in
   place.
2. **Delete** the old field.
3. Place a **Label** (or a Textbox, if the sequential pattern is acceptable — see
   the decision table below) at the same coordinates.
4. Set the new field's **name** to the CRM token it should carry
   (`agent_name`, `list_price`, …). Matching is case- and separator-insensitive,
   so `Agent Name` and `agent_name` are the same token.
5. Leave **Required** unticked on any CRM-filled field. A required + read-only
   field whose token resolves empty is a dead end the signer cannot clear.
6. Re-open the send modal. Both panels above should be gone.

No payload change is needed afterwards. The send path addresses fields by the
**token**, resolved from the field's id, name *or* label, so a replacement field
with the same token is picked up automatically even though BoldSign minted it a
new id (`Label7` and friends are auto-assigned and are not stable identifiers).

### Which type to use — decision table
| what the value is | field type | assignment | prefill | visible to |
|---|---|---|---|---|
| a name that is **not** the signer's own (appointed agent, co-seller, trustee, brokerage) | **Label** | none (common) | `sharedFormFields`, read-only | everyone, immediately |
| static deal data all parties must read (address, price, commission, dates, reference no.) | **Label** | none (common) | `sharedFormFields`, read-only | everyone, immediately |
| a box **we** tick that all parties must see | **Label** showing the resulting state | none (common) | `sharedFormFields`, read-only | everyone, immediately |
| the same, where the order is fixed and sequential visibility is acceptable | `CheckBox` / `TextBox` | **first signer** | `existingFormFields`, `isReadOnly: true` | first signer now, others at their turn |
| the signer's **own** name | `Name` | that signer | **nothing sent** | BoldSign fills it |
| the signer's own input (licence no., a box they choose) | `TextBox` / `CheckBox` | that signer | none | that signer |

The sequential row is the weaker option and is only correct while the send stays
in order with the right party first. Where the value must be legible **regardless
of order**, it is a Label — no exceptions.

## CRM prefill tokens
`property_address` · `property_full` · `property_city` · `property_state` · `property_zip` · `seller_name` / `client_name` · `seller_names` / `client_names` · `seller_2_name` / `client_2_name` · `buyer_1_name` · `buyer_2_name` · `broker_name` · `agent_name` · `agent_2_name` · `agent_email` · `list_price` · `commission_pct` · `commission_amount` · `listing_start_date` · `listing_end_date` · `close_date`

### Canonical Label field ids (the template-side vocabulary)

Templates are moving to a fixed naming convention for their Label fields:
PascalCase ids ending in `Label`, one id per category of data, reused across
every template. A field id only has to be unique *within* a template, so the same
id can mean the same thing account-wide, which is what keeps the send code
template-agnostic.

**These do not resolve through `normalizeTokenKey()` on their own.** That
function collapses case and separators, which is why `Agent_Name` and
`agent name` are already one token, but `Agent1NameLabel` has no separators to
collapse: it normalizes to `agent1namelabel` and matches nothing. A template
authored exactly to the convention rendered every one of these as an empty box on
the send screen and sent no value for it. Not a wrong name, a blank, and nothing
on screen said why.

`CANONICAL_LABEL_TOKENS` (`src/lib/services/boldsignFields.js`) is the bridge.
`fieldTokenKey()` tries a field's own spelling first and falls back to this table,
matching with separators removed entirely, so `Agent1NameLabel`,
`agent1namelabel` and `Agent1_Name_Label` are one id.

| Canonical Label id | CRM token | Source |
|---|---|---|
| `Agent1NameLabel` | `agent_name` | `appointedAgent()` |
| `Agent2NameLabel` | `agent_2_name` | `orderAgentSigners()[1]` |
| `Buyer1NameLabel` | `buyer_1_name` | first client, buyer-side deals only |
| `Buyer2NameLabel` | `buyer_2_name` | second client, buyer-side deals only |

The table is an explicit list rather than a derived pattern on purpose: a wrong
entry prints a real person's name under the wrong caption, which is the failure
this module exists to prevent, and a table can be read against the template and
checked. Every id in it is unit-tested to have a real token behind it, since an
id pointing at a token that does not exist would resolve to `undefined` and
quietly send nothing.

The convention covers a much wider vocabulary (entities, licence numbers, lender,
the financial terms, the staff selections that replace checkboxes). **None of
those has a column in this schema**, so none is listed here. The table grows when
the data model does, not before.

### `buyer_*` is side-aware, `client_*` is not
`client_name` and its `seller_name` alias mean "our client", whoever that is, and
fill identically on a listing and on a buyer representation agreement. That is
right for a form with one "Client" line and wrong for a form that says BUYER.

`buyer_1_name` / `buyer_2_name` fill **only when the deal says our clients are the
buyers**, read from `comp_data.transaction_type` via `dealClientSide()` (the same
value the Form Library filters templates by). On a seller-side deal they stay
blank on purpose: our clients are the sellers, the buyers are the other side of
the table, and the CRM stores nothing about them. A `lease` or `general` deal, or
one with no transaction type recorded, reads as "unknown side" and gets the blank
too rather than a coin flip.

Printing our seller's name on a line captioned "Buyer" is the same silent,
plausible, wrong-name failure that `SIGNER_BOUND_FIELD_TYPES` exists to prevent,
and it is worse than a blank. A blank is visible on the send screen as an empty
box, and a Label field stays editable there precisely so the agent can fill it in
by hand before sending.

**The counterparty is not modelled.** Giving `Seller1NameLabel` a source on a
buyer-side deal (and vice versa) needs a real other-side record on the deal, which
is a schema change, not a token.

**Field ids match case-insensitively.** Ids are typed by hand in BoldSign's
editor, where `Agent_Name` and `agent_name` look like the same thing, and a
mismatch used to fail silently as an empty box the agent retyped every send.
`tokenValueFor()` owns this.

**Which client token to use.** `client_name` is the **primary contact alone** —
right for a form with one "Client" line. `client_names` is **every client on the
deal**, written as a parties clause ("Jane Doe and John Doe"), which is what the
"entered into by and between ______" line of an agency agreement needs: naming
only the primary buyer misstates who is bound by it. `client_2_name` is the
co-buyer on their own, for forms with a second named line. The `seller_*` names
are aliases of the same values. All of them come from `dealClientList()` — the
primary contact, then **Additional Contacts**, then the primary's stored
`spouse_name` when no additional contact is linked — which is the same list
`seedSignersFromDeal()` uses for the signature rows, so the parties clause and
the signer rows can never disagree about who the clients are.

**`agent_name` / `agent_email` are the deal's agent, not the sender.**
`appointedAgent()` applies the rule the signer rows already followed: the acting
agent only when they are on the deal, otherwise the deal's own first agent. These
were hard-wired to the acting agent, so an admin or TC sending a packet on an
agent's behalf printed *their* name into the agreement — on an Appointed Agency
form that is a licensing statement about the wrong person — while the signature
row below correctly named the agent.

**`broker_name` is effectively always blank:** `agents` has no brokerage column.
Put the firm name in the template as fixed text.

Both commission tokens come from the agent's entry on the deal's **Details** tab
(`deals.commission_type` / `commission_pct` / `commission_flat` — migration 0024).
`commission_pct` fills only on a percentage deal, since a flat-fee deal has no
rate to print; `commission_amount` is the dollar figure either way. Neither fills
when the agent hasn't entered a commission, so an unfilled field is a prompt to
go enter one rather than a silent `0%` on a signed agreement.

## Environment variables
| Var | Purpose |
|---|---|
| `BOLDSIGN_API_KEY` | API key (Sandbox in preview/staging, Live in prod) |
| `BOLDSIGN_WEBHOOK_SECRET` | Webhook HMAC signing secret. **Required** — without it `/api/boldsign` answers 503 and processes nothing (an unverified endpoint lets anyone who knows the URL mark a real document completed or declined) |
| `BOLDSIGN_WEBHOOK_AUDIT_ONLY` | Go-live safety valve: verify, log the verdict, process anyway. On for the first hours on Live, then off |
| `BOLDSIGN_WEBHOOK_INSECURE` | Local dev only — process events with no secret configured |
| `BOLDSIGN_BRAND_ID` | The brand applied to every signature request — logo, colours, sender identity in the client's inbox. Defaults in code to the Gateway brand (`67317627-…`), so branding works without configuring anything; set it only to point a second brand (a DBA, a partner office) at a different one. Not a secret: a brand id names an account resource, it does not grant access to one |
| `BOLDSIGN_API_BASE` | Region override (EU accounts: `https://api-eu.boldsign.com/v1`) |
| `ALLOWED_ORIGIN` | Comma-separated origins allowed to call the API from a browser. Unset = `*` |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | Server-side DB + storage (webhook, portal, cron) |

## Migrations (Supabase SQL Editor — manual apply)
- `2026-07-07_esign_transaction_layer.sql` — `boldsign_documents` + transaction layer. **Applied.**
- `2026-07-08_boldsign_phase1.sql` — `boldsign_sender_identities` + `boldsign_templates`. **Applied.**
- `2026-07-08_boldsign_audit_trail.sql` — `boldsign_documents.audit_trail_saved`. **Applied.**
- **`2026-07-31_boldsign_hardening.sql` — APPLY THIS ONE.** A single idempotent
  bundle that supersedes the four migrations below (they were all still pending,
  which is why "Send from Template" never appeared: `form_packets` had no
  `boldsign_template_id` column, the query failed, the error was discarded, and
  the button was hidden) **and** adds this deploy's columns
  (`signed_storage_path`, `audit_storage_path`, `last_reminded_at`,
  `reminder_count`). Ends with verification `SELECT`s. Superseded, no longer
  apply individually:
  - `2026-07-16_form_library_boldsign_unification.sql`
  - `2026-07-17_boldsign_identity_default.sql`
  - `2026-07-17_form_packet_multi_file.sql`
  - `2026-07-17_multi_contacts.sql`

**Deploy order is flexible** — every read of a new column falls back when it's
absent (with a `console.warn` naming the bundle), so shipping the app before the
SQL degrades rather than breaks. Apply the SQL first anyway.

## Sandbox → Live go-live procedure

Sandbox and Live are **separate BoldSign accounts**. Nothing carries over: not
template ids, not sender identities, not the webhook endpoint or its signing
secret. Plan for the Form Library's `boldsign_template_id` values to be *wrong*
the moment the key changes — every packet must be rebuilt or re-registered
against the Live account.

Order matters. Each step is safe to stop at.

1. **Apply `migrations/production/2026-08-09_boldsign_go_live.sql`** in the
   Supabase SQL editor (unique `document_id`, admin-only form catalog). If it
   warns about duplicate `document_id` rows, resolve those by hand and re-run —
   it will not pick a survivor for a legal record.
2. **Let Sandbox drain.** Any document still `sent`/`delivered` on the Sandbox
   account will never complete once the key changes: its webhooks stop matching
   and its documents are deleted by BoldSign after the sandbox retention window.
   Finish or revoke them first:
   `select document_id, document_name, status from boldsign_documents where status in ('sent','delivered');`
3. **Create the Live API key** (app.boldsign.com → Settings → API → API Keys)
   and set `BOLDSIGN_API_KEY` in Vercel → Production only. Leave Preview on the
   Sandbox key so preview deploys can never email a real client.
4. **Register the Live webhook** → `https://<your-domain>/api/boldsign`,
   subscribed to Sent, Viewed/Delivered, Completed, Declined, Revoked, Expired.
   Reveal its signing secret and set `BOLDSIGN_WEBHOOK_SECRET`.
5. **Set `BOLDSIGN_WEBHOOK_AUDIT_ONLY=true`** for the first hours. Verification
   runs and logs its verdict but events are still processed, so a wrong or rolled
   secret shows up as a log line instead of silently 401-ing every status update.
   Remove it once the logs show clean verifications.
6. **Set `ALLOWED_ORIGIN`** to the production origin(s).
7. **Approved domains** — add the production domain in BoldSign → Settings →
   Embedded, or every embedded prepare/sign iframe refuses to load.
8. **Re-register sender identities** on the Live account (Settings → BoldSign →
   sync/resend). Each agent must click the approval email again; until they do,
   sends fall back to the org default identity, and then to the raw API account.
9. **Verify every template id against the Live key — do not assume they carried
   over.** BoldSign's own docs are explicit that Sandbox and Live keep separate
   templates *within the same account*, so a template id that resolves under the
   Sandbox key is not guaranteed to resolve under the Live one. This is a
   two-minute check and it is the difference between a working send picker and an
   empty one:

   ```
   # With BOLDSIGN_API_KEY already switched to the Live key:
   curl -s -H "X-API-KEY: $BOLDSIGN_API_KEY" \
     "https://api.boldsign.com/v1/template/list?page=1&pageSize=100" \
     | jq -r '.result[] | "\(.templateId)  \(.title)"'
   ```
   ```sql
   -- Compare against what the CRM points at:
   select name, boldsign_template_id, active from form_packets
    where boldsign_template_id is not null order by name;
   ```

   Every id in the second list must appear in the first. For any that do not:
   export the template from Sandbox and import it into Live (BoldSign →
   Templates → ⋯ → Export / Import, JSON), then paste the **new** id into that
   Form Library packet — an import mints a new id, it does not preserve the old
   one.

   Do this BEFORE 03:00. The nightly `boldsign-sync` deactivates every packet
   whose template id is absent from the live list — correct behavior, but it
   happens unattended and the packets simply disappear from the send picker.
10. **Smoke test on a throwaway deal**, in this order: send from template →
    confirm the row appears in the Signatures tab → sign as the client in the
    portal → confirm the webhook flipped it to `completed`, the signed PDF *and*
    the audit trail landed in Documents, and the agent got a notification. Then
    check the function log for `[boldsign] rate limit` and signature-verification
    lines.
11. **Revoke the Sandbox key** so nothing can accidentally send from it again.

Rollback: put the Sandbox key back and re-point the webhook. Documents created
on Live stay on Live — they are real signed records and are not portable.

## Testing
- `api/__tests__/boldsign.test.js` — retry/idempotency, `buildSignerPayload`/`requiresExplicitFieldPlacement` (retired-placement contract), `normalizeTemplateRoles` (the Roles-empty fix), `resolveOnBehalfOf` (agent identity → org-default fallback → null), `betaBase` (region-preserving `/v1-beta` derivation), `sendDraftDocument` (beta path, `onBehalfOf`, never-retried, indeterminate outcome) and `describeDraftSendFailure`.
- `api/__tests__/cron-boldsign-sync.test.js` — `detectStateFromTitle`.
- `src/lib/services/__tests__/boldsign.test.js` — `buildTextTag`, `normalizeState`, `crmTokenValues`/`buildPrefill`, `isFillableField`, and the shared-field routing (`isSharedField`, `partitionPrefillFields`, `buildPrefillFields`, `sharedDataOnSignerFields`). Also the canonical Label ids: `CANONICAL_LABEL_TOKENS` resolution through `fieldTokenKey`, `dealClientSide`, the side-aware `buyer_*` tokens, and an end-to-end pass over the four fields on the live test template (all four routed to `sharedFormFields`, and a single-buyer deal sending no `Buyer2NameLabel` entry at all rather than an empty one).
- `api/__tests__/boldsign.test.js` also covers `mergeSharedFormFields` — Labels land on the first role, read-only, deduped against role-scoped copies, idempotent.
- Manual smoke test after deploy: Form Library → Add/Edit Packet → confirm the dialog scrolls and shows Save/Cancel → Build in BoldSign (confirms the Roles/DocumentTitle fix) → place a field and click Finish inside the embedded editor → confirm it auto-saves and closes back to the library list with the new template id and a "Sendable" badge, with no separate Save click needed → click "Rebuild in BoldSign" on that same packet and confirm it reopens the *same* template (not a new one) → send from a deal → sign in Sandbox → confirm the signed PDF + audit trail land in Documents with a "Signed by … on …" note → delete an unsigned draft from the Signatures tab filter view.
- **Shared-visibility check (multi-signer, do this after any change to the prefill payload):** send a two-signer packet from a template that has Label fields, then open the signing link for the **second** signer *before the first has signed*. Every Label value — including any box we pre-ticked — must already be on the page and none of them editable. If a value is missing, it is on a role-scoped field in the template — convert it to a Label (the send modal warns about the ones it can detect).
- **Name-field check (do this after any template edit):** on that same second-signer view, read every printed name against who it is captioned for. A name that has silently become the *signer's own* is a `Name` field being used for somebody else — the one failure that produces a wrong value rather than a blank. The send modal's red panel catches the ones carrying a CRM token; this catches the rest.

## Chasing signatures (reminders)
- **Manual:** a **Remind** button on every row awaiting signature (Signatures
  tab). Refuses when there's nobody left to remind, and records the nudge.
- **Automatic:** folded into the nightly `boldsign-sync` cron (no extra Vercel
  cron slot). `shouldRemind()` bounds it deliberately — nothing before **3 days**
  outstanding, at most one reminder every **3 days** per document, at most **4**
  over its life, and **50** per run. A request that nags gets marked as spam.
- The row shows **waiting Nd** (amber, red past a week) and how many reminders
  have gone out, so the tab doubles as a follow-up queue.
- Ledger: `boldsign_documents.last_reminded_at` / `reminder_count`. Tested in
  `api/__tests__/cron-boldsign-sync.test.js`.

## Skipping a role — BoldSign's post-removal index shift
A template role the agent leaves blank is dropped via `roleRemovalIndices`.
**BoldSign applies those removals first and then expects each supplied role's
`roleIndex` to be its position in the REMAINING list**, not its original index in
the template. Verified against the live API on the 5-role Iowa Agency Packet
(Seller, Listing Agent, Co-seller, Co-listing agent, Buyer):

| sent | result |
|---|---|
| `roles [1,2]` + `removals [3,4,5]` | accepted |
| `roles [1,2,4]` + `removals [3,5]` | `SignerName or SignerEmail is missing in roles` |

In the second case role 3 is dropped, so only three roles remain and index 4
addresses nothing — the third remaining role ends up with no signer. Removal
indices stay in the template's original numbering (that's how BoldSign identifies
what to drop); surviving roles are shifted down by the number of removals below
them, so `[1,2,4]` becomes `[1,2,3]`.

`buildTemplateRoles()` (`src/lib/services/boldsign.js`) owns this and is
property-tested across all 31 skip patterns of a 5-role template: the emitted
indices must always be a dense `1..N`. Roles before the first removal are
unchanged, so payloads that already worked are unaffected.

This only became reachable once co-agent seeding started filling a *middle* role
(#56) — before that, blanks were always trailing.

## Signing order — sequential by default, because visibility depends on it
**"Sign in this order" is ON by default**, and the order is the template's role
order (client first, agent last, per the role convention above).

This has been reversed twice, so the reasoning matters:

1. `signerOrder` was originally hard-wired to the role index — strictly
   sequential on every send. Two co-buyers at the same kitchen table couldn't
   sign together, because the second one's email wasn't sent until the first
   finished and the webhook landed.
2. So parallel became the default, with a checkbox for the cases that needed
   ordering.
3. **Now sequential is the default again**, for a reason that has nothing to do
   with convenience: BoldSign scopes field visibility by role. A field assigned
   to a signer is invisible to every other recipient *until that signer
   completes*. Our packets carry the deal's own details on role-scoped fields, so
   on a parallel send the client opens an Appointed Agency Agreement and finds
   the agency type and the appointed agent's name blank — they are on the
   agent's role, and the agent signs last. In order, with the client first, every
   later signer sees everything the earlier ones did.

The cost is real and accepted: **co-buyers sign one after the other, not
together.** The checkbox still turns it off for a packet with nothing prefilled
to share.

### The two ways to make prefilled data visible to everyone
Either is correct, and `sharedDataOnSignerFields()` only warns when neither holds:

| | works when | order-dependent? |
|---|---|---|
| **Label** field | always | no |
| role-scoped field **on the first signer**, read-only | in-order sends | yes |

The second is what the templates actually do — the prefilled data sits on the
buyer's role with **Read Only** ticked, and the buyer signs first. It needs no
field-type changes, which is why it was adopted over converting everything to
Labels. It breaks the moment a send goes out parallel, or the data is assigned to
a signer who isn't first, and the send modal names the offending fields in both
cases.

There is **no third way.** There is no "assign to all", and no visibility flag on
a normal field; `isReadOnly` controls *editing*, not visibility. Collaborative
Field Editing is for editable collaboration between signers and is not a
read-only visibility mechanism either. If a value must be legible regardless of
order, it is a Label.

Both rows assume the value can reach the field at all — which rules out `Name`
outright, whatever its role or the signing order. See "Never use a Name field for
a name that is not that signer's own".

**Signature and initial fields never move.** Reassigning a signature field to
another role means the wrong person signs. Only *prefilled data* belongs on the
first signer.

**Watch Required + Read Only.** A required, read-only field with no CRM value is
a field the signer must complete and cannot — a dead end at signing time. Either
guarantee the token resolves, or untick Required on CRM-filled fields.

## Roadmap
1. ✅ Text-tags authoring + retired coordinate auto-placement.
2. ✅ Idempotency + retry/backoff in the client.
3. ✅ Audit-trail auto-archive + on-demand download.
4. ✅ Form Library ↔ template unification + nightly drift sync.
5. ✅ Full sender-identity management (create/update/delete/default) + fixed "Build in BoldSign" (Roles/DocumentTitle) + drafts cleanup + document_versions metadata on completion.
6. ✅ Form Library modal scrolling fix, embedded (not new-tab) template editor with auto-save-back, and a real "Rebuild" (edit, not recreate) path.
6b. ✅ Prepare & Print draft agreements — `template-draft` (Review Draft / Place Fields, no editor required), filled-PDF download on a draft, and `draft-send` as the single explicit send.
7. Monitoring/alerting on the signature funnel (webhook failures, stuck `sent` docs, send error rate, drift-sync `unmatched` titles).
8. Confirm the BoldSign plan supports a 4th daily cron job (this repo's Vercel cron count just grew from 3 → 4) and that embedded signing/sending is enabled on the account tier.

## Audit — backend ↔ frontend gaps (2026-07-17)
Full pass over sender identities, text tags, drafts deletion, auto-storage, and the Form Library ↔ BoldSign embedded flows. Findings, prioritized:

**Fixed this round:**
- Form Library upload modal not scrollable (see above) — **critical**, blocked adding roles/saving on smaller screens.
- "Build in BoldSign" opened a disconnected new tab instead of an embedded, event-driven flow, and never auto-saved — **critical**, the exact "why doesn't this save back to the CRM" gap.
- "Rebuild in BoldSign" silently created a new template instead of editing the existing one — **high**, orphaned BoldSign templates on every rebuild.
- A packet built purely via "Build in BoldSign" (skipping the separate "Upload PDF" box) couldn't be saved at all for a brand-new packet — **high**, blocked by `save()`'s own PDF-required check.

**Open, not yet addressed (backlog, roughly prioritized):**
- *Quick win* — Settings → BoldSign has no visibility into *how many* agents are still unapproved/unregistered; an admin has to scan the full agent list. A small "N agents need approval" banner would make the identity rollout (see main flow above) self-tracking.
- *Quick win* — `recordDocumentVersion()` is best-effort and silently swallows failures (by design, so a webhook never 500s on a metadata-only problem) but nothing surfaces those failures anywhere; consider a lightweight `console.error`-visible-in-Vercel-logs tag so a persistent failure isn't invisible forever.
- *Medium* — Template roles are fixed cardinality at creation time (one BoldSign role = one signer slot); multi-signer-per-role scenarios (e.g. two sellers) need the template over-provisioned with extra named roles (`Seller 1`, `Seller 2`) up front, then left blank per-send. Not a bug, but undocumented outside this conversation — worth its own doc section if it comes up again.
- *Medium* — No loading/skeleton state on the embedded editor iframe itself while BoldSign's app boots inside it (`BoldSignFrame` renders the iframe immediately with no interstitial); on a slow connection the modal looks empty for a beat. Same is true of the send-flow embeds in `Pipeline.jsx`.
- *Larger* — The nightly drift-sync cron (`boldsign-sync`) and this modal's own template creation both write `boldsign_template_id`, but there's no reconciliation UI for the case where a template is edited directly in the BoldSign dashboard (title/role changes) rather than through the CRM — Form Library's cached `name`/`doc_type`/`field_tokens` can drift silently from what's actually in BoldSign.
