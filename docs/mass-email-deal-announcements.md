# Mass Email & Deal Announcements

A one-time, manual send to a segment of the contact database, delivered through
the **agent's own connected Microsoft 365 mailbox**. Two halves that stand on
their own:

* **Audience segmentation** — pick contacts by the asset types in their buyer
  and/or seller criteria (`src/lib/audience.js`, `src/components/AudienceFilter.jsx`).
* **Deal announcements** — a property-backed email (Just Closed, Under Contract,
  New Listing, Price Reduced, Coming Soon) built from the property record
  (`src/lib/dealAnnouncement.js`, `src/pages/MassEmail.jsx`).

This is **not** drip automation — that is Drip Sequences (`src/pages/Sequences.jsx`)
— and no third-party bulk email service is involved.

---

## The flow

`Mass Email` in the Tools nav, or **Announce** on a property in the Properties
drawer (which pre-selects that property):

1. **Property + deal status** — the property record supplies the address, asset
   type, unit count, price and photo.
2. **Message** — optionally start from a saved `Deal Announcement` template,
   choose the photo, **choose which details to include**, write the custom note,
   insert merge tokens, preview the rendered email.
3. **Audience** — asset-type chips × buyer/seller sides, with a live count, the
   matched list, hand add/remove, **and a pasted or uploaded list of addresses
   that need not be contacts**.
4. **Review & send** — the send runs in paced batches with live progress.

**Past sends** (top right of the page) is the report: sent, opened, replied,
unsubscribed per send, and per recipient.

## Segmentation rules

`contacts.asset_types` is the criteria field; whether it reads as *buyer* or
*seller* criteria is decided by `contacts.type` — the same thing the contact
drawer does when it labels the field. So:

| Audience side | Contact types |
|---|---|
| Buyer criteria  | `buyer`, `investor` |
| Seller criteria | `seller`, `landlord` |

Selecting both sides with `multifamily` means *"everyone who buys multifamily OR
sells multifamily"*. Multiple asset types OR together.

Deliberately strict, matching `src/lib/matching.js`:

* A contact with **no** asset types matches nothing. Silence is not consent to be
  included in a blast.
* An **empty filter selects nobody**, never everybody — a mis-click must not
  become a send to the whole database.
* No email, `email_opt_out`, or `status = 'closed'` is never a recipient, and the
  UI names the reason rather than quietly shrinking the count.

## Which details to include

The rows under the photo — **Address, Asset type, Units, Price, Terms** — are
each a switch (`ANNOUNCEMENT_FACT_FIELDS` in `src/lib/dealAnnouncement.js`).

The case this exists for is a property **under contract**: the address and unit
count are the pitch, but the number the seller accepted is their business, and
printing it in a mass email hands every other buyer in the market a reference
point. So `under-contract` starts with **Price switched off**
(`defaultHiddenFacts()`); every other status starts with everything on, exactly
as before. Like the wording, the switches follow the chosen status until the
agent sets them by hand, after which their choice is never overwritten.

Two things it does **not** do, both deliberate:

* **It does not rewrite the agent's words.** A hidden row whose merge token is
  still typed into the subject or body still prints — a token the agent typed is
  a choice. The wizard says so, on the Message step and again on Review, because
  it is the one way to withhold a price and mail it anyway.
* **It does not hide the headline.** Switching off the *Address* row removes the
  duplicate detail line, not the address the email leads with.

The choice is stored on the blast (`email_blasts.hidden_facts`, migration 0047),
not applied only in the browser, for two reasons: a blast is delivered in paced
batches and resumed after a timeout or the next day, and every batch has to
withhold exactly what the first one did; and *"did this announcement publish the
contract price?"* is an audit question about mail that has already gone out.

## Recipients who are not contacts

An agent pasting a 122-row county roll used to be told *"122 addresses · 0
matched a contact · 122 new"* and then mailed the 12 people the asset-type
filter found. The list did nothing.

Now a pasted or uploaded list is matched against the contact book by email and
**"Add all N to this send"** takes the whole thing: rows that match a contact
join as contacts, rows that match nobody join as themselves.

**No contact records are created, by design.** 122 unqualified addresses would
bury a working contact book, and the importer on the Contacts page (column
mapping, de-duplication, agent assignment) is still the only way a real contact
gets made. `email_blast_recipients.contact_id` was already nullable and the row
already snapshotted the address and name, so a list recipient needs no new
table — the row *is* their record:

| | Contact recipient | List recipient |
|---|---|---|
| Individually addressed message | ✅ | ✅ |
| Working unsubscribe link | ✅ | ✅ |
| Opens / replies / opt-out tracked | ✅ | ✅ |
| Contact timeline + Emails tab | ✅ | ✗ (no contact to attach to) |
| Where you read the result | Contact record **or** Past sends | **Past sends** |

Both kinds pass the same address validation, the same suppression check and the
same de-duplication. When an address is in the contact book *and* the file, the
contact row wins — so the send lands on that person's timeline instead of
becoming an anonymous delivery, and they get one email, not two.

## Opt-out is per address, not per contact

`email_suppressions` (migration 0048) is keyed by **address** and gates every
send. It replaces nothing — `contacts.email_opt_out` is still set, because every
screen in the CRM already reads it — but it is now the authority, for two
reasons:

* A list recipient has no contact record, so there was nowhere to record that
  they asked us to stop.
* `email_opt_out` quietly under-protected even the people it covered. The same
  human on a second address, or re-imported as a new contact row, came back
  mailable.

An opt-out is **global**, not per agent or per send: *"he unsubscribed from
Daniel's list but not mine"* is not a distinction a recipient would recognise.

The token behind `/u/:token` carries the address (v2). v1 contact-only tokens
are still read forever — a link sitting in somebody's inbox is not something we
get to re-issue. One click suppresses the address, stamps the recipient row so
the send's report shows who left, and sets `email_opt_out` when a contact owns
that address.

**One fixed defect worth naming:** the unsubscribe link used to be minted only
when a row had a `contact_id`. A recipient the CRM had no record for would have
received a bulk email with no way out of it.

## Open tracking, and what it is worth

A 1×1 GIF at `/e/:token.gif`, rewritten into `api/campaigns.js?action=open`,
stamps `first_opened_at` / `last_opened_at` / `open_count` on the recipient row.
The token is signed, so nobody can fabricate opens for a send they never
received, and the endpoint **always returns the image** — valid token, forged
token or dead database alike. A broken image in a marketing email is a visible
defect the recipient blames the sender for, and a response that varied with
whether the token resolved would let anyone probe which tokens are real.

**Outlook and Gmail block or proxy remote images by default, and some proxies
fetch the pixel on delivery whether or not a human looked.** So a recorded open
is weak evidence somebody read it, and a missing open is no evidence at all.
Obvious machine traffic is filtered with the same classifier the QR scan path
uses, which improves the number without making it trustworthy. Read it as a
floor, never as a read receipt — the UI says so next to the number.

## Replies

The nightly `inbox-sync` cron (`api/_lib/inboxSync.js`) already imports mail
from known contacts onto their timeline. The same pass now also matches inbound
senders against recipients of sends from the last 30 days and stamps
`replied_at` + `reply_subject`.

Separate from the contact import because it has to be: a list recipient has no
timeline for a reply to appear on. Only the flag and the subject are stored for
them, never the body — the sync's narrowness is a privacy property worth
keeping, and the agent has the reply in their own inbox already. The **first**
reply wins; later messages are left alone, because `replied_at` answers "did
this send get a response", not "when did they last email me".

## Merge tokens

`{{firstName}}` `{{lastName}}` `{{agentName}}` `{{propertyAddress}}`
`{{assetType}}` `{{unitCount}}` `{{price}}` `{{terms}}` `{{dealStatus}}`
`{{customMessage}}`

An unknown token renders **as itself** — a visible `{{propertyAdress}}` in the
preview is a typo the agent can fix; a silent blank is one they cannot.

The preview and the delivered email come from the same `renderAnnouncementHtml()`
call, so what is approved is what is sent.

## Photos

Defaults to the first image on the property (`properties.details.photos[]`,
`property-photos` bucket). The agent can pick another of the property's photos or
upload one **for this send only**, which goes to the existing `campaign-images`
bucket and is stored on the blast — the property record is not modified.

## Sending, and why it is chunked

Endpoints (folded into `api/email-send.js`, because the Vercel Hobby plan caps
this project at 12 serverless functions and it is already at the limit):

| Action | Purpose |
|---|---|
| `?action=blast-create` | Create the blast + one row per recipient. Sends nothing. |
| `?action=blast-send`   | Send one batch, return progress. Called in a loop by the client. |
| `?action=blast-status` | Progress for one blast. |
| `?action=blast-cancel` | Stop the remaining recipients. |

Two more are **public** (no login — they are reached from inside an email):

| Path | Purpose |
|---|---|
| `/u/:token` | One-click unsubscribe → `campaigns?action=unsubscribe` |
| `/e/:token.gif` | Open pixel → `campaigns?action=open` |

Both fold into `api/campaigns.js` via `vercel.json` rewrites. Nothing here gets
its own file: the project sits on exactly the **12 serverless functions** the
Vercel Hobby plan allows, and a 13th fails the deploy.

Each message is a separate `/me/sendMail` to a single address — never one message
with many recipients, which would leak the whole segmented list to everyone on it.

**Throttling** (`api/_lib/massEmail.js`, all env-overridable):

| Limit | Default | Why |
|---|---|---|
| `MASS_EMAIL_INTERVAL_MS` | 2000 | ~30 msg/min, the Exchange Online per-mailbox rate |
| `MASS_EMAIL_BATCH_MS` | 40 000 | Under the function's 60s `maxDuration` |
| `MASS_EMAIL_BATCH_MAX` | 25 | Ceiling per batch regardless of time |
| `MASS_EMAIL_DAILY_LIMIT` | 1000 | Well under Microsoft's 10 000/day; being throttled costs the agent their ordinary mail too |
| `MASS_EMAIL_MAX_RECIPIENTS` | 500 | A four-figure audience is a mis-set filter, not a campaign |

**Nobody is mailed twice.** The recipient row is the cursor: only `pending` rows
are picked up, and each is marked immediately after its own send. A batch that
times out, a closed tab, or a re-run resumes from what is still pending. Hitting
the daily cap leaves the rest pending and resumable tomorrow.

**A partial send says so.** A failed address keeps its Graph error on its row,
does not stop the batch, and shows in the counts. Only a send where *every*
message failed is reported as failed.

## Logging

Every delivered message writes, exactly like a one-off send does:

* an `activities` row (`type = 'email'`) → the contact's timeline, and
* an `email_messages` row tagged with `blast_id` → the contact's Emails tab.

So "which of my contacts got the 1200 Grand closing announcement, and when" is
answerable from the contact record, from the blast record, or from either
direction of the join.

## Schema

`migrations/0039_mass_email_deal_announcements.sql` — `email_blasts`,
`email_blast_recipients`, `email_messages.blast_id`, `contacts.email_opt_out`,
and `templates.category` widened for `'deal-announcement'`.

`migrations/0047_announcement_hidden_facts.sql` — `email_blasts.hidden_facts`,
the detail rows withheld from a send (empty array = the original behavior, so
blasts sent before it read back exactly as they rendered).

`migrations/0048_mass_email_list_recipients.sql` — `email_suppressions`,
`email_blast_recipients.source` + open/reply/opt-out stamps, and the roll-up
counters the Past sends report reads. Suppression reads are open to any
authenticated user (every agent needs to know an address is off-limits, and the
UI has to be able to say *why* somebody was skipped); writes stay with the
service key, so an agent cannot delete somebody's opt-out.

Blast reads follow the standard visibility model (own + sharing team peers +
admin); writes belong to the service key, so an agent cannot hand-edit a
`sent_count` or repoint a recipient row after the fact. Only the agent who
created a blast can send it — the mail leaves *their* mailbox.
