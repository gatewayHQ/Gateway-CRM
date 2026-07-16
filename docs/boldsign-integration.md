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
```

**Source of truth**
- **BoldSign** owns the document bytes, form fields, roles, text-tag layout, and template versions.
- **CRM** stores lightweight pointers + metadata: `boldsign_documents` (per-send records) and `boldsign_templates` (registry: `template_id`, `name`, `state`, `doc_type`, `field_tokens`). Never duplicate the document/field definitions in Postgres.

## Key decisions
- **US region**, `X-API-KEY` auth. Sandbox vs Live is decided by *which key* is configured — no per-request test flag. Sandbox and Live are separate accounts, so **template IDs differ between them**.
- **Signers (multipart):** each signer is a **repeated `Signers` form field holding one JSON object** — never one field with a JSON array (that returns `{"Signers":["Value is invalid"]}`).
- **Prefill by field ID:** a template field whose ID matches a CRM token (`property_address`, `seller_name`, …) is auto-filled and sent **read-only**. See `crmTokenValues()`.
- **Embedded everywhere:** agents send via BoldSign's embedded prepare UI in-frame; clients sign via embedded signing in the portal. Requires **approved domains** in BoldSign + a paid tier.
- **Reliability:** the central `boldsign()` client does exponential backoff + jitter on network / 429 / 5xx, and attaches an `Idempotency-Key` to writes.

## Data model
| Table | Purpose |
|---|---|
| `boldsign_documents` | one row per send: `document_id`, `deal_id`, `agent_id`, `status`, `signer_*`, `signers` jsonb, `completed_at`, `audit_trail_saved` |
| `boldsign_templates` | registry of BoldSign templates: `template_id`, `name`, `state`, `doc_type`, `field_tokens`, `active` |
| `boldsign_sender_identities` | per-agent send-on-behalf: `agent_id`, `email`, `status` (pending/approved/declined) |

Signed PDFs + audit-trail PDFs are archived to the `deal-documents` bucket.

## API surface — `POST /api/boldsign` (action-routed)
| Action | Auth | Purpose |
|---|---|---|
| `send` | agent | Ad-hoc immediate send (multipart) |
| `document-embed-url` | agent | Ad-hoc → embedded prepare/send URL (iframe) |
| `status` / `download` / `audit-download` / `remind` | agent | Doc status, signed PDF, audit trail PDF, reminder |
| `template-list` / `template-details` | agent | List templates / read a template's roles + fields |
| `template-send` / `template-embed-url` | agent | Send from template (JSON) / embedded prepare from template |
| `template-editor-url` | admin | Embedded template create/edit URL |
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

## Templates — authoring
- Prefer **Text Tags** in the source document: `{{fieldType|signerIndex|required|label|fieldId}}` with `fieldId` = a CRM token so prep and prefill are unified. Enable with `UseTextTags=true` on create. (Roadmap item #1.)
- Alternatively, build/adjust visually via the embedded template editor (`template-editor-url`).
- Register each template in the CRM (Settings → BoldSign — Templates): `template_id`, `name`, `state`, `doc_type`, `field_tokens`. The send picker filters by the deal's state.
- **Role convention:** Role 1 = Seller/Client, Role 2 = Listing Agent (same order across all state templates). Recipient name/email in the template are placeholders; the CRM overrides them per send and drops unused roles via `roleRemovalIndices`.

## Environment variables
| Var | Purpose |
|---|---|
| `BOLDSIGN_API_KEY` | API key (Sandbox in preview/staging, Live in prod) |
| `BOLDSIGN_WEBHOOK_SECRET` | Webhook HMAC signing secret |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | Server-side DB + storage (webhook, portal) |

## Migrations (Supabase SQL Editor — manual apply)
- `2026-07-07_esign_transaction_layer.sql` — `boldsign_documents` + transaction layer.
- `2026-07-08_boldsign_phase1.sql` — `boldsign_sender_identities` + `boldsign_templates`.
- `2026-07-08_boldsign_audit_trail.sql` — `boldsign_documents.audit_trail_saved`.

## Roadmap
1. **Text-tags authoring + retire coordinate auto-placement** (kills the points-vs-pixels drift; makes prep reproducible).
2. ✅ Idempotency + retry/backoff in the client.
3. ✅ Audit-trail auto-archive + on-demand download.
4. **Form Library ↔ template unification** — add `boldsign_template_id` to Form Library entries; nightly drift sync; create/clone/edit via embedded template URLs.
5. Monitoring/alerting on the signature funnel (webhook failures, stuck `sent` docs, send error rate).
