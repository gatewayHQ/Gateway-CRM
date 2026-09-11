# Signature Packets

The deal-level packet module: composing several forms into one signature
request, fixing one that is already out for signature, correcting one that has
been signed, and packaging the results for MLS.

Companion to [`boldsign-integration.md`](./boldsign-integration.md), which
covers the underlying e-signature integration (auth, webhooks, templates,
prepare-and-print). Read that first — everything here builds on it.

---

## Three facts, and everything follows from them

Every design decision in this module traces to something BoldSign either does or
refuses to do. None of them is worked around.

**1. An in-progress document can be edited, narrowly.** Fields can be added for
a signer who has not finished. A signer who *has* finished, their fields, and
the files they already signed are off limits. Title, brand and signing order are
fixed at creation and cannot change afterwards.

So *"the client spotted a typo"* is answered with an **acknowledgement label plus
required initials** on the corrected page. **Not** a strike-through drawing: a
line through the old text says nothing about who agreed to the change or when,
and an acknowledgement someone initials says exactly that. (This was an explicit
product decision — see "Not implemented" below.)

**2. A completed document cannot be edited at all.** Not by us, not by BoldSign.
A correction after signing is a **clone** — a new envelope prefilled from the
original — and the original signed PDF stays exactly where it is, because that is
the file MLS receives. There is deliberately no button anywhere in this app
called "Edit signed document".

**3. BoldSign will not split pages out of a signed combined PDF.** It will also
not merge two completed envelopes into a new one, and will not restripe a signed
file. If a packet needs to reach MLS as separate forms, that is decided **before
it is sent** (`DocumentDownloadOption: Individually`, which BoldSign fixes at
creation). Afterwards, all we can do is assemble what we already hold — locally,
in our own PDF layer, never back through BoldSign.

---

## Data model

The packet **is** the envelope. `boldsign_documents` already held one row per
send; migration 0046 adds the facts the packet module acts on.

| Column | What it is |
|---|---|
| `document_id` | BoldSign's id (pre-existing) |
| `status` | the normalized, forward-only lifecycle: `draft`, `sent`, `delivered`, `needs_attention`, `completed`, `declined`, `expired`, `voided` |
| `raw_status` | BoldSign's own word for it, **display only**, never filtered on |
| `mode` | `merged` \| `split` \| `single` |
| `template_ids[]` | every template that went into the envelope |
| `file_ids` | the files BoldSign holds inside it, from `/v1/document/properties`: `[{ id, name, pages }]` |
| `signers` | per-signer state (pre-existing) — now carries BoldSign's **signer id**, which the edit API addresses recipients by |
| `deal_id` | the parent deal (pre-existing) |
| `mls_number` | snapshotted from the deal's property at send time |
| `correction_of_document_id` | the packet this one corrects; null on an original |
| `download_option` | `Combined` \| `Individually` — fixed by BoldSign at creation |
| `local_files` | the manifest: `[{ kind, path, pages?, form_name }]` with `kind` in `signed_pdf` \| `audit` \| `split_part` \| `mls_bundle` |
| `edit_pending_since` | non-null while an async file edit is still Queued |

`signature_packet_events` is the deal's **signing timeline**: one row per
webhook delivery, plus our own `Edited` / `SignerChanged` / `Revoked` entries.

### Why the spec's status list is not stored verbatim

The product spec names `Draft | InProgress | Completed | Declined | Revoked |
Expired | NeedsAttention | Queued`. The CRM stores a different vocabulary, and
translates for display (`packetState()` in
`src/lib/services/signaturePackets.js`). Two deliberate divergences:

- **`Revoked` is stored as `voided`.** That value predates this module and the
  portal, the reminder sweep and the closing compliance gate all filter on the
  existing strings. Renaming it to match a spec would be a migration across
  three subsystems to change a word the UI can simply translate.

- **`Queued` is not a status at all.** BoldSign answers an async *file* edit
  with a queued document — a property of the **edit**, not of the document's
  lifecycle. Writing it into `status` would take a live, out-for-signature
  document out of the portal, the reminder sweep and the compliance gate for as
  long as the edit took to settle. It is carried by `edit_pending_since` and
  surfaces as a derived label.

`NeedsAttention` **is** stored, as `needs_attention`, ranked alongside
`delivered`: in flight, not terminal. It is kept out of the portal's signable
allow-list and out of the nightly reminder sweep on purpose — chasing a signer
whose link will not open is how a client learns to ignore us.

---

## 1 · Fix a packet in progress

**Button:** `Fix packet` — rendered only when `canFixPacket()` says so (draft or
in flight, and no file edit still settling). On a settled packet it is disabled
with the tooltip **"Use Send correction packet."**

**Preferred UX:** the BoldSign editor in-frame.

```
POST /crm/packets/:id/embedded-edit   →   action: 'packet-edit-url'
  → POST /v1/document/createEmbeddedEditUrl?documentId={id}
      { RedirectUrl, ShowToolbar: true, SendViewOption, ShowSendButton: true,
        ShowPreviewButton: true, ShowNavigationButtons: true, Locale: 'EN',
        LinkValidTill: <now + 24h> }
```

`SendViewOption` is state-dependent — a draft is refused on `PreparePage`, an
in-flight document on `FillingPage` — so `createDraftEditUrl()` prefers the right
one and retries with the other rather than hard-wiring the mapping. On redirect
the UI re-reads `/v1/document/properties` and refreshes.

**Programmatic path** — add an acknowledgement + initials without opening the
designer:

```
POST /crm/packets/:id/add-initials   →   action: 'packet-add-initials'
  1. GET /v1/document/properties → the signerId of the party who has not finished
  2. PUT /v1/document/edit?documentId={id}
       { Message, Signers: [{ EditAction: 'Update', Id: signerId, FormFields: [
           { EditAction:'Add', FieldType:'Label',   PageNumber:n, Bounds:{…}, Value:'Acknowledged correction — initial here' },
           { EditAction:'Add', FieldType:'Initial', PageNumber:n, Bounds:{…}, IsRequired:true } ]}] }
```

`PUT /v1/document/edit` is the confirmed verb and path (BoldSign's own SDK:
`DocumentApi.editDocument`). BoldSign's edit-document reference also documents
it on `/v1-beta`, so a **404/405** from the primary host retries once on the
other. A **400** is not retried — that is BoldSign rejecting the payload, and
asking the other host the same invalid question gets the same answer.

### The hard rules, and where each is enforced

| Rule | Enforced by |
|---|---|
| Never edit a signer who has completed; never touch their fields | `assertEditableSigner()` — checked against BoldSign's **live properties**, not the CRM's row, and answers 409 naming the person |
| Never replace or remove files a signer has already signed | same guard; a file edit is only reachable through the editor, where BoldSign applies its own rules |
| Title, brand and signing order cannot change on an in-progress edit | `stripLockedEditFields()` — dropped and **named in the response**, never sent and silently ignored |
| File Add/Update/Remove is async; the response may be `Queued` | `isQueuedResponse()` / `touchesFiles()` set `edit_pending_since`; the row shows **Queued** and refuses further edits and sends until `packet-sync` or a webhook clears it |
| No Fix packet on Completed / Declined / Revoked / Expired | `canFixPacket()` in the UI **and** a 409 from the endpoint — the CRM's row can be a missed webhook behind the truth |

**Change signer** (`packet-change-signer`) is the narrowest use of the same API:
a recipient who has not signed can be swapped; one who has cannot. A signature is
a legal act and the person who made it is not replaced underneath it.

---

## 2 · Correct a signed packet

**Button:** `Send correction packet`. Offered on `completed`, `declined`,
`expired` and `voided`.

```
POST /crm/packets/:id/embedded-clone   →   action: 'packet-clone-url'
  → POST /v1/document/createEmbeddedCloneUrl?documentId={id}   (multipart)
      ViewOption=PreparePage · ShowSaveButton=true · ShowSendButton=true
      ShowPreviewButton=true · IncludeFormFieldValues=true
      RedirectURL=… · LinkValidTill=<now + 24h>
```

The confirm dialog says, before anything is created:

> Creates a new signature request. The original signed PDF stays on the deal for MLS.

…and gives the prepare checklist the spec fixed: keep filled values on, add a
Label reading "Acknowledged change", add required Initials beside it, Send.

The clone is tracked with `correction_of_document_id` set to the original, so
both PDFs stay on the deal and the MLS packager can offer them as a pair
(`correctionPair()`). BoldSign returns the clone's id on the accounts that
populate it; where it does not, the document is created when the agent sends
from inside the frame and the Sent webhook records it.

`IncludeFormFieldValues` is the reason this is a clone rather than a fresh send
from the template: everything the parties already agreed carries over, so the
only thing anyone has to look at is the change.

---

## 3 · Merge and split — two different layers

### A · Before the send (BoldSign)

**Together** — one envelope from several templates:

```
POST /crm/deals/:id/packets   →   action: 'template-merge-embed-url'  (reviewed)
                              →   action: 'template-merge-send'       (immediate)
  → POST /v1/template/mergeCreateEmbeddedRequestUrl
  → POST /v1/template/mergeAndSend
      { templateIds, title, roles: [{ roleIndex, signerName, signerEmail }],
        enableSigningOrder, documentDownloadOption: 'Individually' }
```

**Separately** — one `POST /v1/template/send` per form, same signers, labelled
`[dealId, formSlug]` so BoldSign's own dashboard groups them. Separate document
ids and statuses on the deal. A partial failure is **reported as a partial and
never rolled back**: the forms that went out are already in front of the client,
and the response names the ones that were not sent.

**`DocumentDownloadOption` is the decision that cannot be undone.** Every
multi-file send asks for `Individually`; when BoldSign refuses it (a paid-plan
feature) the send still succeeds as `Combined`, what was actually used is
recorded on the row, and the response carries a `downloadWarning` saying MLS will
get a single PDF. `isDownloadOptionRejection()` is narrow on purpose — a 400 that
names something else is a real validation failure and must not be papered over
by silently downgrading a packet that can then never be split.

Roles on a merged send are matched **by index across every template**, so the
compose screen uses the longest role list among the selected templates and warns
when their role counts disagree rather than silently mapping "role 2".

### B · After the signing (our PDF layer — required for MLS)

On `Completed`, `archiveCompletedPacket()`:

1. `GET /v1/document/download` and **sniff the bytes** — a `Combined` document
   returns a PDF, an `Individually` one returns a ZIP. Sniffed rather than
   assumed, because an account whose plan silently downgraded the option would
   otherwise have its zip written to storage as `signed-….pdf`.
2. **Combined** → one `signed_pdf` in the manifest.
3. **Individually** → each entry stored as a `split_part` named for its form
   (`Purchase_Agreement.pdf`, `Disclosures.pdf`), **plus** the parts concatenated
   locally into one PDF for `signed_storage_path` — the Signatures tab's
   "Download Signed PDF" resolves that column and must not be a button that
   cannot work.
4. The audit trail is archived as before, and added to the manifest.

If the local concatenation fails, the **parts are still kept**: they are the MLS
deliverable and the only thing that cannot be rebuilt.

The `download` action heals a packet the webhook missed by the same route, so a
Combined-vs-Individually mismatch can never strand a deal.

#### The MLS packager

`Pack for MLS` on the deal. A checklist of every completed file across all the
deal's packets — originals **and** corrections — with three actions:

- **Download separately (zip)** — one PDF per form, for a board that wants one
  form per upload.
- **Merge into one PDF** — concatenated in an order the agent sets, with an
  optional cover sheet (address, MLS number, date, numbered contents).
- **Correction only** — the original and its acknowledgement, original first.

Presets: **Listing file** (agreement + disclosures), **Sold/closed** (purchase +
amendments + lead paint + corrections, in order), **Single-form upload**.

```
POST /crm/deals/:id/mls-pack   →   action: 'mls-pack'
  { deal_id, mode: 'list' | 'zip' | 'merge', fileIds[], order[],
    preset?, correctionOf?, coverSheet?, address? }
```

It runs in `api/_handlers/mls-pack.js`, co-hosted under `/api/boldsign` like the
closing-packet generator (Vercel function cap), and **routed before the
`BOLDSIGN_API_KEY` check** — it never calls BoldSign, so an account whose key is
missing or mid-rotation can still hand an agent the forms they already have. The
test suite enforces that with a `fetch` stub that throws.

Two behaviours worth naming:

- **Nothing partial.** If any selected form cannot be read, *nothing* is packed
  and the response names which and why. An MLS packet quietly missing a
  disclosure is worse than no packet: the agent uploads it, the board accepts it,
  and the gap surfaces at closing.
- **A bundle is recorded, not filed.** Output goes under a `mls/` prefix the
  Documents tab does not list (same reasoning as `print/`), and is added to the
  packet manifest as `mls_bundle` so the deal can say what was handed to MLS and
  when.

The merged PDF is a **new artifact filed on the deal**. It is never flattened
back into the original BoldSign document id.

---

## 4 · CRM UI

The deal's **Signatures** tab (`SignaturesTab` in `src/pages/Pipeline.jsx`).

```
Packet · In progress · 2/3 signed
  [Remind] [Add acknowledgement] [Fix packet] [Recall]      per-signer: Nudge · Change

Correction of Purchase · Completed
  [Download Signed PDF] [Audit Trail] [Pack for MLS] [Send correction packet]
```

Header actions: **Pack for MLS**, **Compose packet** (forms checklist ·
Together \| Separately · Review & send), **Prepare from Template**, **Send for
Signature**.

Overflow by state:

| State | Actions |
|---|---|
| Draft | Download Filled PDF · Print · Save to Deal · Edit Fields · Send for Signature |
| In progress | Remind · Add acknowledgement · Fix packet · Change signer (per unsigned recipient) · Recall |
| Queued | the same, all disabled, with "BoldSign is still applying the last file change" |
| Completed | Download Signed PDF · Audit Trail · Pack for MLS · Send correction packet |
| Declined / Revoked / Expired | Send correction packet |

Every row carries a **timeline** toggle reading `signature_packet_events`.

Rows are badged: `correction` when `correction_of_document_id` is set, and
`packet · per-form` / `packet · combined` on a merged envelope so the MLS
consequence of the download option is visible before MLS time.

---

## 5 · Backend surface

This repo routes `/api/boldsign` by an `action` field rather than by path — the
established convention, and what keeps the Vercel function count under the plan
cap. The spec's REST shape maps one-to-one:

| Spec route | Action |
|---|---|
| `POST /crm/deals/:id/packets` | `template-merge-embed-url` · `template-merge-send` · `packet-split-send` |
| `POST /crm/packets/:id/embedded-prepare` | `template-embed-url` *(pre-existing)* |
| `POST /crm/packets/:id/embedded-edit` | `packet-edit-url` |
| `POST /crm/packets/:id/embedded-clone` | `packet-clone-url` |
| `POST /crm/packets/:id/add-initials` | `packet-add-initials` |
| `POST /crm/packets/:id/remind` | `remind` *(pre-existing)* |
| `POST /crm/packets/:id/revoke` | `document-revoke` |
| `GET /crm/packets/:id` | `status` *(pre-existing)* · `packet-sync` (reads and writes the packet facts) |
| `GET /crm/packets/:id/download` | `download` · `audit-download` *(pre-existing)* |
| `POST /crm/deals/:id/mls-pack` | `mls-pack` |
| — | `packet-change-signer` (the spec's "Change signer" overflow action) |

Auth is the existing `requireAgent()` plus `resolveDocumentRecord()`, which
allows the sender, an admin, or anyone who can see the deal under RLS. The MLS
packager additionally re-checks the deal **with the caller's own credentials**
(`getUserClient`), because "the deal id was in the request body" is not an
authorization check.

Webhook events map to the timeline and the packet row: `Sent`, `Viewed`,
`Signed`, `Completed`, `Declined`, `Revoked`, `Expired`, plus our own `Edited`,
`SignerChanged`, `EditOpened`, `CorrectionStarted` and `PacketPrepared`.
Timeline rows are written on **every** delivery that names a known document, not
only one that advances the lifecycle — "Jane viewed it" does not move a
three-party document off `sent`, and gating on that would discard exactly the
events worth keeping. `dedupe_key` makes a redelivery update one row.

### Degrading before the migration is applied

Every packet column is optional in code. `trackDocument()` and `patchPacket()`
drop a column the database does not have and retry, because an untracked
document is the worst outcome in this integration — it reaches a client and then
never updates, archives, or appears in the Signatures tab. The MLS packager says
which migration to run instead of showing an empty checklist, and the timeline
degrades to "no events" rather than breaking the tab.

---

## 6 · Acceptance tests

The spec's seven, and where each is proved:

| # | Acceptance criterion | Test |
|---|---|---|
| 1 | In-progress Fix packet loads; the unsigned signer gets new initials; a completed signer's fields are unchanged | `api/__tests__/signature-packets.test.js` — `assertEditableSigner`, `buildAcknowledgementEdit` |
| 2 | An edit with a file change shows pending until properties catch up (Queued) | `signaturePackets.test.js` — `isQueuedResponse` / `touchesFiles` / `packetState` → `Queued`, and `canFixPacket` refusing while pending |
| 3 | A completed packet hides Fix packet; the clone creates a new id; the original download still works | `signaturePackets.test.js` — `canFixPacket` / `fixPacketBlockedReason`; `signature-packets.test.js` — `createEmbeddedCloneUrl`, `archiveCompletedPacket` |
| 4 | A multi-template send with `Individually` yields separate downloadable files after completion | `signature-packets.test.js` — `buildMergePayload`, `downloadDocumentParts`, `archiveCompletedPacket` |
| 5 | An MLS merge of two completed PDFs produces one file **without calling BoldSign** | `api/__tests__/mls-pack.test.js` — the `fetch` stub throws if anything calls out |
| 6 | An MLS zip returns one file per selected form | `mls-pack.test.js` — unzipped and asserted by entry name |
| 7 | A correction packet is labelled and stored beside the original | `signaturePackets.test.js` — `packableFiles`, `correctionPair`; `mls-pack.test.js` — the correction-only pack |

Plus `api/__tests__/zip.test.js` for the dependency-free ZIP reader/writer:
round-trips, CRCs, foreign-producer archives, and refusals (ZIP64, encrypted,
truncated, unsupported compression) that name the cause rather than returning
half a packet.

---

## Not implemented, on purpose

- **Drawing-based strike-through as the correction UX.** Corrections are
  acknowledgements plus initials. A line through the old text carries no record
  of who agreed to the change.
- **Mutating a completed BoldSign envelope.** Not possible, not attempted, and
  no button is named as though it were.
- **A page-splitting call against BoldSign.** There is no such endpoint. Splitting
  is decided at send time via `DocumentDownloadOption`, and assembly afterwards is
  local.
- **Rebuilding the field designer.** Field placement stays in BoldSign's editor.
- **Changing title, brand or signing order on an in-progress edit.** Stripped and
  reported.
