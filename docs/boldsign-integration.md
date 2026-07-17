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
        │                          │  (X-API-KEY, retry+idempotency)
        ▼                          ▼
   <BoldSignFrame> iframe  ◀──  sendUrl / signLink  (app.boldsign.com)

Client (Portal)                /api/portal?action=sign-link
  Documents to Sign   ─────▶   token-validated → getEmbeddedSignLink ─▶ iframe

BoldSign  ──webhook──▶  /api/boldsign (HMAC-verified)
                          → update boldsign_documents
                          → on Completed: archive signed PDF + audit trail
                          → notify agent

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
- **Reliability:** the central `boldsign()` client does exponential backoff + jitter on network / 429 / 5xx, and attaches an `Idempotency-Key` to writes.

## Data model
| Table | Purpose |
|---|---|
| `boldsign_documents` | one row per send: `document_id`, `deal_id`, `agent_id`, `status`, `signer_*`, `signers` jsonb, `completed_at`, `audit_trail_saved` |
| `form_packets` | **the template/form catalog.** `state`, `transaction_type`, `name`, `storage_path` (plain downloadable forms) plus `boldsign_template_id`, `doc_type`, `field_tokens`, `active` (e-sign-ready entries) |
| `boldsign_sender_identities` | per-agent send-on-behalf: `agent_id`, `email`, `status` (pending/approved/declined) |
| `boldsign_templates` | **superseded** by `form_packets` (0019 backfills it in) — kept, not dropped, for rollback safety. Don't write new rows here. |

Signed PDFs + audit-trail PDFs are archived to the `deal-documents` bucket.

## API surface — `POST /api/boldsign` (action-routed)
| Action | Auth | Purpose |
|---|---|---|
| `send` | agent | Ad-hoc immediate send (multipart). Requires `useTextTags: true` or per-signer `tabs` — no auto-placement. |
| `document-embed-url` | agent | Ad-hoc → embedded prepare/send URL (iframe). `useTextTags` optional; otherwise the agent places fields in BoldSign. |
| `status` / `download` / `audit-download` / `remind` | agent | Doc status, signed PDF, audit trail PDF, reminder |
| `document-delete` | agent (sender) / admin | Remove a draft/unsigned/expired document — revokes if in-progress, then deletes in BoldSign, then removes the local row. Refuses `completed` records. |
| `template-list` / `template-details` | agent | List templates / read a template's roles + fields |
| `template-send` / `template-embed-url` | agent | Send from template (JSON) / embedded prepare from template |
| `template-editor-url` | admin | Embedded template create/edit URL. Requires `roles` (defaults to Seller/Listing Agent) and a document title on create — see "Fixing 'Roles cannot be null or empty'" below. `useTextTags` + `textTagDefinitions` supported. |
| `identity-create` / `identity-details` / `identity-update` / `identity-delete` / `identity-set-default` / `identity-sync` / `identity-resend` | admin | Full sender-identity lifecycle — see "Sender Identity Management" below |
| `debug` | agent | Config sanity check |
| _(no `action`)_ | webhook | BoldSign lifecycle events (HMAC-verified) |

`getEmbeddedSignLink` for clients is minted via `GET /api/portal?action=sign-link` (portal-token validated).

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

## Drafts cleanup (Signatures tab)
- **Filter dropdown**: Active (default — hides completed) / Drafts only / Completed only / All.
- **Delete** (trash icon, shown on any non-`completed` row): calls `document-delete`, which **revokes** the document in BoldSign first if it's still in progress (BoldSign requires `completed`/`revoked`/`declined` before `DELETE`), then deletes it there, writes an `audit_log` entry, and removes the local `boldsign_documents` row. Completed (signed) records are refused — they're the legal record and aren't deletable from this action.

## Embedded signing/sending (iFrame)
- `<BoldSignFrame>` (`src/components/BoldSignFrame.jsx`) renders the URL and relays completion to `onDone`/`onError`. Completion is detected three ways (see the header comment), because **the embedded template editor and the document flows emit different events**:
  - Document send/sign → `onCreateSuccess` / `onDraftSuccess` / `onSendSuccess` / `onSuccessfullySigned` / `onSigningComplete` / `onDocumentSigned`.
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

**Catalog (in the CRM — Form Library):**
- Register a template by pasting its BoldSign template id into a Form Library entry (Settings → BoldSign links here too), along with `state`, `doc_type`, and comma-separated `field_tokens`. The entry shows a **Sendable** badge and becomes selectable in a deal's "Send from Template" picker, filtered to the deal's state.
- **Nightly drift sync** (`GET /api/cron?task=boldsign-sync`, 3am): calls `template-list` and reconciles the catalog —
  - **deactivates** any linked entry whose template was deleted in BoldSign;
  - **draft-registers** (inactive) any BoldSign template not yet in the catalog, but *only* when its title confidently maps to one of `OPERATING_STATES` (`detectStateFromTitle()`) — ambiguous titles are reported in the job's response, never guessed, since `state` is compliance-relevant;
  - never overwrites an admin-set name/state/tokens on an existing entry, and never auto-activates a draft — an admin reviews and flips `active` in Form Library.

## CRM prefill tokens
`property_address` · `property_full` · `property_city` · `property_state` · `property_zip` · `seller_name` / `client_name` · `broker_name` · `agent_name` · `agent_email` · `list_price` · `commission_pct` · `listing_start_date` · `listing_end_date` · `close_date`

## Environment variables
| Var | Purpose |
|---|---|
| `BOLDSIGN_API_KEY` | API key (Sandbox in preview/staging, Live in prod) |
| `BOLDSIGN_WEBHOOK_SECRET` | Webhook HMAC signing secret |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | Server-side DB + storage (webhook, portal, cron) |

## Migrations (Supabase SQL Editor — manual apply)
- `2026-07-07_esign_transaction_layer.sql` — `boldsign_documents` + transaction layer. **Applied.**
- `2026-07-08_boldsign_phase1.sql` — `boldsign_sender_identities` + `boldsign_templates`. **Applied.**
- `2026-07-08_boldsign_audit_trail.sql` — `boldsign_documents.audit_trail_saved`. **Applied.**
- `2026-07-16_form_library_boldsign_unification.sql` — adds e-sign columns to `form_packets` and backfills existing `boldsign_templates` rows. **Pending.**
- `2026-07-17_boldsign_identity_default.sql` — `boldsign_sender_identities.is_default` + partial unique index. **Pending.**

## Testing
- `api/__tests__/boldsign.test.js` — retry/idempotency, `buildSignerPayload`/`requiresExplicitFieldPlacement` (retired-placement contract), `normalizeTemplateRoles` (the Roles-empty fix), `resolveOnBehalfOf` (agent identity → org-default fallback → null).
- `api/__tests__/cron-boldsign-sync.test.js` — `detectStateFromTitle`.
- `src/lib/services/__tests__/boldsign.test.js` — `buildTextTag`, `normalizeState`, `crmTokenValues`/`buildPrefill`, `isFillableField`.
- Manual smoke test after deploy: Form Library → Add/Edit Packet → confirm the dialog scrolls and shows Save/Cancel → Build in BoldSign (confirms the Roles/DocumentTitle fix) → place a field and click Finish inside the embedded editor → confirm it auto-saves and closes back to the library list with the new template id and a "Sendable" badge, with no separate Save click needed → click "Rebuild in BoldSign" on that same packet and confirm it reopens the *same* template (not a new one) → send from a deal → sign in Sandbox → confirm the signed PDF + audit trail land in Documents with a "Signed by … on …" note → delete an unsigned draft from the Signatures tab filter view.

## Roadmap
1. ✅ Text-tags authoring + retired coordinate auto-placement.
2. ✅ Idempotency + retry/backoff in the client.
3. ✅ Audit-trail auto-archive + on-demand download.
4. ✅ Form Library ↔ template unification + nightly drift sync.
5. ✅ Full sender-identity management (create/update/delete/default) + fixed "Build in BoldSign" (Roles/DocumentTitle) + drafts cleanup + document_versions metadata on completion.
6. ✅ Form Library modal scrolling fix, embedded (not new-tab) template editor with auto-save-back, and a real "Rebuild" (edit, not recreate) path.
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
