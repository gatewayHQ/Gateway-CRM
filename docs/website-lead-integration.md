# Website → CRM lead integration (Manus site)

How the brokerage website feeds leads into the CRM's round-robin. Hand this page
to whoever maintains the Manus site — the integration is one HTTP POST.

There are **two** entry points, for two different callers:

| | `POST /api/webhooks/website-lead` | `POST /api/property-public` |
|---|---|---|
| Caller | The Manus **server** (webhook) | A **browser** form on a landing page |
| Auth | Shared secret header, required | None (CORS open) |
| Interest | `residential` / `commercial` / **`both`** | `property_type` only |
| Viewed properties | An array, linked to CRM listings | One free-text address |
| Drip enrollment | Yes | No |

Both share **one** rotation, so they cannot each hand out "the next agent" and
together double-book one person. New integrations should use the webhook.

---

## The webhook

```
POST https://<your-crm-domain>/api/webhooks/website-lead
Content-Type:     application/json
x-gateway-secret: <WEBSITE_LEAD_WEBHOOK_SECRET>
```

```json
{
  "name": "Jane Smith",
  "email": "jane@example.com",
  "phone": "712-555-0142",
  "interest_type": "residential",
  "viewed_properties": [
    "https://gatewayre.com/listing/8f14e45f-ea1c-4b2e-9d3a-77c1b2a4e5d6",
    { "url": "https://gatewayre.com/p/456-oak-ave", "title": "456 Oak Ave", "viewed_at": "2026-08-19T14:02:00Z" },
    "123 Main St, Sioux City"
  ],
  "message": "I'd like a showing this weekend",
  "event_id": "manus-evt-8891"
}
```

### Fields

| Field | Required | Notes |
|---|---|---|
| `name` | ✅ | Or `first_name` + `last_name`. |
| `email` | ✅ | Validated and lower-cased. An invalid address is a `400`. |
| `phone` | — | Any format; stored as digits. |
| `interest_type` | — | `residential` \| `commercial` \| `both`. Anything else falls back to `residential` rather than rejecting the lead. |
| `viewed_properties` | — | Array of strings (URL **or** title) or objects (`url`, `title`, `viewed_at`). Max 25; extras are dropped. |
| `message` | — | Free text, 2000 chars. |
| `event_id` | — | **Send this if you can.** It is the idempotency key — a retry with the same id is a no-op. Without it the CRM hashes the payload with a 10-minute window instead. |
| `source_detail` | — | Campaign / page label. Defaults to `manus-website`. |

### Responses

```json
{ "ok": true, "deduped": false,
  "lead_id": "…", "contact_id": "…", "contact_created": true,
  "assigned_agent_id": "…", "secondary_agent_id": null,
  "interest_type": "residential", "lane": "residential",
  "assignment": "round_robin",
  "properties_linked": 3, "properties_matched": 2,
  "drip_status": "enrolled",
  "notified": { "primary": { "in_app": true, "email": true } } }
```

| Code | Meaning | Retry? |
|---|---|---|
| `200` | The lead is stored. | No |
| `400` | Malformed payload (no name, bad email, `viewed_properties` not an array). | No |
| `401` | Missing or wrong `x-gateway-secret`. | No |
| `413` | Payload over 64 KB. | No |
| `500` | The CRM is misconfigured, or the lead could not be stored. | **Yes** |

Everything after the lead row is best effort and reported per field: a Resend
outage shows as `notified.primary.email: false` on a `200`, **not** a `500`.
Answering `5xx` over a failed email would make the sender replay a lead that is
already in the CRM.

`assignment` says how the owner was chosen:

- `round_robin` — the normal path.
- `existing_contact_owner` — the CRM already knew this person and someone is
  working them, so their agent keeps them and the rotation is untouched.
- `round_robin_legacy` — migration `0037` has not been applied; the old racy
  picker is being used. Apply the migration.
- `unassigned` — nobody is in either rotation. The lead is still stored for an
  admin to claim.

---

## What happens in the CRM

1. **The lead is recorded first**, unassigned. A unique index on the dedupe key
   is what decides whether a delivery is new, so a retry cannot burn a rotation
   turn or send a second email.
2. **An owner is chosen.** If the contact already exists and has an agent, that
   agent keeps them. Otherwise one atomic round-robin step.
3. **The contact** is created (`source: website`, `status: lead`, `type: buyer`)
   or matched by email. A missing phone number on an existing contact is
   backfilled; one already on file is never overwritten.
4. **Viewed properties** are stored and matched to CRM listings where the URL
   or title resolves. An unmatched address is kept, not dropped.
5. **The drip** — the contact is enrolled in the lane's auto-enroll sequence,
   which `/api/cron?task=sequence` already runs each morning.
6. **A timeline activity** is logged on the contact.
7. **The agent is notified** — in-app (bell, realtime, no refresh) and by email
   with the lead details and the properties viewed, most recent first.

---

## The rotation

Two independent rings, `residential` and `commercial`, each with a durable
cursor in `lead_rotations`. Membership is `lead_rotation_members`.

```sql
-- Who is up next, in order, without advancing anything
select m.lane, a.name, m.active, m.sort_order
  from lead_rotation_members m join agents a on a.id = m.agent_id
 order by m.lane, m.sort_order, a.name;

select lane, assigned_count, cursor_agent_id from lead_rotations;
```

- **Park an agent** (vacation, an admin who never works leads):
  `update lead_rotation_members set active = false where lane = 'residential' and agent_id = '…';`
- **A new agent is enrolled automatically** by a trigger on `agents`, into the
  ring matching their `specialty` (a null specialty goes to residential) — so
  hiring someone cannot silently leave them out of the rotation. Changing their
  specialty later does **not** move them, so curated rings stay curated.
- **Add a second ring** for an agent who genuinely works both:
  `insert into lead_rotation_members (lane, agent_id) values ('commercial', '…');`
- **Reorder** — set `sort_order`; ties fall back to agent name, so the default of
  all zeros is alphabetical (what the rotation always did).

> ⚠️ `assign_lead_round_robin()` is a **write** — calling it to "see who's next"
> consumes a turn. Use the read-only query above.

### `interest_type: "both"`

**One primary owner, plus a notified secondary.**

- One owner, because a lead assigned to two agents is a lead nobody follows up
  on, and two agents cold-calling the same person is worse than one.
  `leads.assigned_agent_id` is always exactly one agent.
- The owner comes from whichever ring has handed out **fewer** leads, so
  ambiguous traffic does not quietly starve one specialty.
- The other lane's next agent gets a clearly-labeled FYI email ("… owns the
  follow-up — reach out only about the commercial side") and is recorded as
  `secondary_agent_id`. Their ring advances too, because a real opportunity did
  reach them.

Set `LEAD_BOTH_NOTIFY_SECONDARY=false` to make `both` a plain single assignment.

---

## Drip campaigns

The lead is drip-ready the moment it lands; enrollment just needs a sequence
flagged for the lane:

```sql
update sequences set auto_enroll_lane = 'residential' where id = '…';
update sequences set auto_enroll_lane = 'commercial'  where id = '…';
```

At most one sequence per lane (enforced by a unique index). Until one is
flagged, leads store `drip_status = 'skipped'` — a normal state, not an error.
Flag one later and enrollment starts with no deploy. A contact already active in
that sequence is not re-enrolled, so nobody gets the drip twice.

---

## Env vars (Vercel)

| Var | Required | Notes |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | ✅ | Already configured. |
| `WEBSITE_LEAD_WEBHOOK_SECRET` | ✅ | The endpoint **refuses all deliveries** without it. Falls back to `GATEWAY_SECRET`. |
| `RESEND_API_KEY`, `RESEND_FROM` | — | Without them the lead still flows; agents get the bell only. |
| `PUBLIC_BASE_URL` | — | Base for the email's CRM links. Defaults to the request host. |
| `LEAD_BOTH_NOTIFY_SECONDARY` | — | `false` disables the cross-specialty FYI. |

---

## Testing

```bash
curl -sS -X POST https://<your-crm-domain>/api/webhooks/website-lead \
  -H "Content-Type: application/json" \
  -H "x-gateway-secret: $WEBSITE_LEAD_WEBHOOK_SECRET" \
  -d '{"name":"Test Lead","email":"test-lead@example.com",
       "phone":"712-555-0142","interest_type":"both",
       "viewed_properties":["123 Main St, Sioux City"],
       "message":"integration test","event_id":"test-1"}' | jq
```

Then check:

- the response names an `assigned_agent_id`;
- that agent's bell shows the notification and they received the email;
- POSTing again with the same `event_id` returns `"deduped": true` and sends
  nothing;
- a POST with a **new** `event_id` assigns the **next** agent in the ring.

Delete test leads afterwards (`delete from leads where email like 'test-%'`) and
the test contacts via admin → Contacts. Deleting leads no longer moves the
rotation — the cursor lives in `lead_rotations`.

---

## Security notes

- **No CORS on the webhook.** It authenticates with a shared secret, so it is
  not browser-callable by design: an endpoint a page could call would need that
  secret in page source, and the rotation would be forgeable by anyone who
  viewed source. The browser-callable form remains `POST /api/property-public`.
- **Fails closed.** With no secret configured the endpoint returns `500` and
  stores nothing, rather than accepting anonymous deliveries.
- **No anon database access.** `leads`, `lead_property_views`, `lead_rotations`
  and `lead_rotation_members` have **no** `anon` policy — every write comes from
  the service key. Agents get read-only access to their own leads; only admins
  can reassign a lead or touch a rotation cursor. The rotation functions are
  `service_role`-only, so an authenticated agent cannot spin the rotation onto
  themselves.
- **There is no HMAC option.** The handler is co-hosted with
  `api/property-public.js`, whose other actions need Vercel's body parser, so the
  exact received bytes are not recoverable and any signature would have to be
  computed over a re-serialization. A rotatable shared secret over TLS is the
  control.

## Not built yet (planned)

- **Rotation management UI.** Today parking/adding/reordering agents is SQL (see
  above). The tables are shaped for a simple admin screen.
- **Miss rule / re-routing.** If the assigned agent logs no activity on the lead
  within a window, bounce it to the next agent and notify both. Needs a cron
  task; `leads.assigned_at` and `leads.status` are already there for it.
- **Rate limiting.** The dedupe key absorbs retries and double-clicks, but there
  is no per-sender throttle. Vercel WAF or an edge rule is the right layer.
