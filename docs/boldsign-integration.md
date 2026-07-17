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
- `boldsign_documents` records per-send state; `boldsign_sender_identities` records per-agent send-on-behalf approval.

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
| `template-list` / `template-details` | agent | List templates / read a template's roles + fields |
| `template-send` / `template-embed-url` | agent | Send from template (JSON) / embedded prepare from template |
| `template-editor-url` | admin | Embedded template create/edit URL. `useTextTags` + `textTagDefinitions` supported on create. |
| `identity-create` / `identity-sync` / `identity-resend` | admin | Sender identity lifecycle |
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
- On `Completed`: archive signed PDF + audit trail to `deal-documents`, set `audit_trail_saved`, notify the agent. The audit trail can lag — if it isn't ready, agents fetch it on demand via the **Audit Trail** button (`audit-download`).

## Embedded signing/sending (iFrame)
- `<BoldSignFrame>` (`src/components/BoldSignFrame.jsx`) renders the URL and relays `postMessage` events with a strict `https://app.boldsign.com` origin check.
- The client portal (`ClientPortal.jsx`) shows "Documents to Sign" and opens the signing UI in a full-screen overlay.
- **Required:** add prod + preview domains to BoldSign → Settings → Embedded → Approved domains, or iframes are blocked.

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

## Roadmap
1. ✅ Text-tags authoring + retired coordinate auto-placement.
2. ✅ Idempotency + retry/backoff in the client.
3. ✅ Audit-trail auto-archive + on-demand download.
4. ✅ Form Library ↔ template unification + nightly drift sync.
5. Monitoring/alerting on the signature funnel (webhook failures, stuck `sent` docs, send error rate, drift-sync `unmatched` titles).
6. Confirm the BoldSign plan supports a 4th daily cron job (this repo's Vercel cron count just grew from 3 → 4) and that embedded signing/sending is enabled on the account tier.
