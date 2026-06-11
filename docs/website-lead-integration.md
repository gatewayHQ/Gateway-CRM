# Website → CRM lead integration (Manus site)

How the brokerage website's "Contact Agent" form feeds the CRM's round-robin.
Hand this page to whoever maintains the Manus site — the integration is one
HTTP POST.

## The endpoint

```
POST https://<your-crm-domain>/api/property-public
Content-Type: application/json
```

```json
{
  "name": "Jane Smith",
  "email": "jane@example.com",
  "phone": "712-555-0142",
  "message": "I'd like a showing this weekend",
  "property_address": "123 Main St, Sioux City",
  "property_type": "residential"
}
```

- `name` (or `first_name` + `last_name`) and `email` are **required**; everything else optional.
- `property_type`: `"residential"` or `"commercial"` — picks which agents the
  lead rotates between. Omit it and the lead round-robins residential agents.
- `agent_id` (uuid, optional): pass it to BYPASS the round-robin — for "Contact
  THIS agent" buttons on an agent's own profile page. The lead goes straight
  to that agent.
- CORS is open, so the form can POST directly from the browser.

Success response: `{ "ok": true, "contactId": "…", "isNew": true, "assignedAgentId": "…" }`

## What happens in the CRM (automatically)

1. **Round-robin assignment** — agents of the matching specialty, alphabetical
   rotation, advancing one agent per lead. (Falls back to the other specialty,
   then any agent, if the pool is empty.)
2. **Contact created** (or matched by email if they already exist), assigned to
   that agent, with source `website` and the message in their notes.
3. **Activity logged** on the contact's timeline.
4. **Lead record stored** (`lead_captures`) — this is also what advances the
   rotation. *Fixed 2026-06-12: previously only stored when the form sent a
   `session_key`, which silently froze the rotation on one agent for plain
   website forms.*
5. **The agent is notified** *(added 2026-06-12)*:
   - instantly in-app (the bell icon — realtime push, no refresh needed), and
   - by email via Resend ("New website lead: Jane Smith" with the details).

## Env vars required (Vercel)

Already configured for the CRM: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`.
For the email alert: `RESEND_API_KEY` (+ optional `RESEND_FROM`). If the
Resend key is absent the lead still flows — agents just get the in-app
notification only.

## Testing the integration

```bash
curl -X POST https://<your-crm-domain>/api/property-public \
  -H "Content-Type: application/json" \
  -d '{"name":"Test Lead","email":"test-lead@example.com","property_type":"residential","message":"integration test"}'
```

Then check: the contact exists and is assigned; the agent's bell shows the
notification; a second POST assigns the NEXT agent alphabetically.
Delete test contacts afterward (admin → Contacts).

## Not built yet (planned)

- **Miss rule / re-routing**: if the assigned agent logs no activity on the
  lead within a time window, bounce it to the next agent and notify both.
  Needs a cron task — scheduled with the back-office milestone.
- **Rotation pool management UI**: today the pool is "all agents of the
  specialty"; an admin toggle per agent ("in lead rotation") is planned.
