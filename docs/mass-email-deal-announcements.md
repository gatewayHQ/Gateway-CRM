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
   matched list, and hand add/remove.
4. **Review & send** — the send runs in paced batches with live progress.

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

Blast reads follow the standard visibility model (own + sharing team peers +
admin); writes belong to the service key, so an agent cannot hand-edit a
`sent_count` or repoint a recipient row after the fact. Only the agent who
created a blast can send it — the mail leaves *their* mailbox.
