# Gateway CRM — Architecture & Process Review

**Date:** August 7, 2026
**Scope:** Full-system decomposition, waste audit, and prioritized action list
**Method:** Direct read of the shipped codebase (35,869 LOC across `src/`, `api/`, `migrations/`)

> **Note on framing.** This review was requested as a from-scratch design exercise. Gateway CRM is not from scratch — it is a mature system with 26 migrations, 8 live integrations, RLS scoping, an e-sign transaction layer, and a broker-review gate. So this document reviews **the system that exists**, which is far more actionable. Every finding below cites real files and line numbers. Nothing here is generic.

---

## Part 1 — System Decomposition

### 1.1 Atomic components, as actually built

| Function | Where it lives | State |
|---|---|---|
| **Identity & access** | `agents`, `app_is_admin()`, `app_visible_deal_ids()`, `agents_guard_privileged()` trigger | Strong. DB-enforced, not just UI-hidden. |
| **Lead capture** | `lead_captures`, `mailing_leads`, `mailing_subscribers`, `cold_call_leads`, `visitor_events`, `LeadCapture.jsx`, 5 landing pages | Fragmented — see §2.1 |
| **People of record** | `contacts` + `deal_contacts` + `property_contacts` junctions | Sound core, five shadow tables around it |
| **Inventory** | `properties` (+ `details` jsonb escape hatch), `property_showings`, `listing_checklist_steps` | Duplicated checklist logic |
| **Pipeline** | `deals.stage` (16 tokens), `stages.js` TRACKS ×4, `Pipeline.jsx` (3,532 LOC) | One live board, three dead ones |
| **Task automation** | `STAGE_AUTO_TASKS` (`stages.js:125`), `tasks`, cron nudges | Good design, stage-coverage gaps |
| **Communication** | `conversations`/`messages` (Twilio), `templates`, `sequences`/`sequence_steps`/`contact_sequences`, `email_log`, Resend, Buffer, Mailchimp | Five overlapping outbound paths |
| **Document handling** | `documents` → `document_versions` → `closing_packets`, `form_packets`, Supabase Storage | Well-layered. Best subsystem in the codebase. |
| **E-signature** | `boldsign_documents`, `boldsign_sender_identities`, `deal_field_layouts`, `api/boldsign.js` (2,043 LOC) | Deeply built; field-layout persistence is genuinely novel |
| **Compliance gate** | `compliance.js` `getClosingGate()` — 6 blockers | Correct shape, two real holes (§2.3) |
| **Broker review** | `deals.review_status`, `AdminReview.jsx`, `REVIEW_STATUS` | Clean |
| **Commission** | `commissions` (legacy flat cols **+** structured `sides`/`participants` jsonb), `commission.js` 4-tier resolution | Dual model carried indefinitely |
| **Reporting** | `agent_dashboard_stats` view, `Reports.jsx` | Thin relative to the data available |
| **Audit** | `audit_log`, `audit.js` | Present and used |

### 1.2 Where friction actually appears

Tracing a real multifamily deal end to end:

```
Cold call list (cold_call_leads)          ← re-typed from a skip-trace CSV
   └─ manual "convert"  (ColdCalls.jsx:320)
      └─ contacts row                     ← name/phone/address re-entered
         └─ manual property create        ← address re-entered a 3rd time
            └─ manual deal create         ← title typed as free text
               └─ prop_category set by hand → decides the pipeline track
                  └─ comp_data.state typed by hand → decides which forms apply
                     └─ RequiredFormsPanel: type the state AGAIN to find forms
                        └─ BoldSign send: signer name/email re-entered
                           └─ commission entered by agent, re-entered by admin
```

**The same address is typed up to four times. The same state is typed twice. The same human is typed twice.** That is the core waste in the system, and it is structural, not cosmetic.

Three additional friction points, each verified in code:

1. **Cold start is O(entire brokerage).** `App.jsx:381` loads contacts, properties, deals, tasks, templates, **all activities unbounded** (`select('*')` with no filter or limit), `deal_contacts`, and `property_contacts` before the first pixel renders. At 20k activities this is a multi-second white screen on every login.
2. **Global search does not exist.** `App.jsx:618` renders `<input placeholder="Search contacts, properties, deals…" />` with **no `onChange`, no state, no handler**. Meanwhile `search_contacts()` and `search_properties()` are defined in `schema.sql:812–841`, indexed with a GIN FTS index, granted to `authenticated` — and **called from zero places in the client**. The backend was built; the frontend never connected to it. On mobile the input is hidden entirely (`app.css:490`), so a phone has no search at all.
3. **The pipeline is desktop-only.** Kanban drag uses HTML5 `draggable`/`onDragStart` (`Pipeline.jsx:3312`), which does not fire on touch devices. An agent on a phone cannot move a deal.

---

## Part 2 — Duplication & Waste

### 2.1 Six tables that are all "a person"

`contacts`, `cold_call_leads`, `lead_captures`, `mailing_leads`, `mailing_recipients`, `mailing_subscribers`. Each has its own name/email/phone/address columns and its own hand-rolled conversion path into `contacts` (`ColdCalls.jsx:320`, `Leads.jsx:46`, `api/campaigns.js:611`, `api/campaigns.js:713`). Four separate dedupe implementations, four separate bugs.

**Collapse to:** `contacts` + a `contact_sources` child table (`source_type`, `source_id`, `captured_at`, `payload jsonb`). One person, many capture events. Deleting five tables removes four conversion code paths and four dedupe bugs.

### 2.2 Duplicated definitions

| Duplication | Evidence |
|---|---|
| Stage lists in two files | `stages.js:65` `ALL_DEAL_STAGES` vs `helpers.js:37` `STAGE_ORDER` — QuickAdd uses the stale one |
| Four pipeline tracks, one live | `stages.js:34` — comment says *"decided 2026-06-12: no res/comm split"*, yet `commercial`, `residential-buyer`, `residential-seller` and a 40-entry `FOREIGN_STAGE_MAP` are all still maintained |
| Two checklist systems | `transaction_steps` (deal) and `listing_checklist_steps` (property) — same shape, separate code |
| Two commission models | Legacy flat columns **and** `sides`/`participants` jsonb, reconciled at runtime by a 4-tier precedence chain (`commission.js:38–49`) |
| Two admin checks | `is_admin === true \|\| role.includes('admin')` — repeated in `App.jsx:267`, `App.jsx:357`, `App.jsx:494`, and `app_is_admin()` |

### 2.3 Features that look impressive and deliver little

- **`Campaigns.jsx` — 2,480 LOC** for QR-tracked postcards with scan heat-tracking, five landing-page builders (`LandingProperty`, `LandingValuation`, `LandingMultifamily`, `LandingMailing`, `PropertyLanding`), and per-agent Mailchimp keys. This is the second-largest file in the codebase serving the lowest-frequency workflow in a brokerage. Freeze it.
- **`option_value_counts`** — queried as a view by `DataManagement.jsx`, never defined. Schema comment at line 1327 admits it: *"the app degrades to zeros."* Ship the view or delete the page.
- **Drip sequences** — full `sequences`/`sequence_steps`/`contact_sequences`/`email_log` stack plus a cron runner, in a brokerage that also has Mailchimp wired up. Pick one.
- **`agents.stats jsonb`** — "public vanity stats curated by the agent." Zero operational value.
- **Toolkit nav item** — opens `gatewayhq.github.io` in a new tab with a separate login. A nav slot spent on an external link.

### 2.4 Compliance gate holes

`compliance.js:53–62` proves signatures like this:

```js
const signSteps = req.filter(s => s.doc_action === 'sign')
const completedSigs = envelopes.filter(e => e.status === 'completed').length
if (signSteps.length > completedSigs) { /* block */ }
```

It compares **counts**, not identities. Three sign-steps and three completed copies of the *same* disclosure passes the gate. There is no foreign key from `transaction_steps` to `boldsign_documents`.

And **`comp_data.state` is never checked against `form_packets.state`.** `RequiredFormsPanel` (`Pipeline.jsx:642`) is a manual search box — the agent types a 2-letter state, gets a download list, and nothing verifies the right IA/SD/NE packet was ever executed. For a three-state brokerage, multi-state compliance is currently a human habit, not a system property.

### 2.5 🔴 Security: eight tables are readable and writable by the anonymous public

`schema.sql` creates these policies with **no `TO` clause**, which in Postgres defaults to `PUBLIC` — including the `anon` role:

```sql
create policy "allow_all" on properties         for all using (true) with check (true);  -- :300
create policy "allow_all" on templates          for all using (true) with check (true);  -- :304
create policy "allow_all" on teams              for all using (true) with check (true);  -- :421
create policy "allow_all" on team_splits        for all using (true) with check (true);  -- :444
create policy "allow_all" on mailings           for all using (true) with check (true);  -- :942
create policy "allow_all" on mailing_recipients for all using (true) with check (true);  -- :977
create policy "allow_all" on mailing_scans      for all using (true) with check (true);  -- :998
create policy "allow_all" on mailing_leads      for all using (true) with check (true);  -- :1024
```

The `anon` key and project URL are hardcoded as fallbacks in `src/lib/supabase.js:3–4` and ship in the browser bundle — as they are designed to, because RLS is supposed to be the boundary. Here the boundary is open.

Consequence: anyone on the internet can `SELECT`, `INSERT`, `UPDATE`, and `DELETE` the entire property database, every team's split percentages, and **`mailing_recipients` — the name, street address, city, state, and ZIP of every person the brokerage has ever mailed.**

This nullifies the careful scoping work done on `contacts`, `deals`, and `commissions`. It is the single highest-risk item in the system.

---

#### ⚠️ Correction — what the live database actually shows (2026-08-07)

The section above was written from `src/lib/schema.sql`. A read-only `pg_policies` diagnostic against **production** was run afterwards, and the live picture differs materially. `schema.sql` is what a *fresh install* gets, so the findings above remain accurate for that — but they are not an accurate description of the running system, and the difference cuts both ways.

**Narrower than stated.** `templates`, `teams`, `team_splits`, `mailing_recipients`, `mailing_scans` and `mailing_leads` are **not** anon-reachable in production. **The mailing-address exposure described above does not exist in the live database.** `properties` and `mailings` are anon-`SELECT` only — the 2026-06-10 Phase A bundle had already closed the writes.

**Wider than stated.** Seven tables unknown to `schema.sql` are open to `PUBLIC` with `ALL` (read *and* write):

| Table | Why it matters |
|---|---|
| `canva_connections` | Orphan, no code references. The name implies stored OAuth credentials, anonymously readable and writable. The most serious single row in the diagnostic. |
| `deal_contacts` | The repo defines this deal-scoped; production had it wide open, leaking which contacts sit on which deals. |
| `mail_sends`, `mail_campaigns`, `mail_suppressions` | The legacy v1 mailing tables migration `0001` was written to drop. `mail_sends` holds send history keyed to `cold_call_leads` — **this is the real mailing-PII exposure, and it is writable.** |
| `campaign_scans` | Orphan, no code references. |
| `option_values` | Low sensitivity, but anonymously writable means anyone can pollute every dropdown in the CRM. |

Also confirmed live: `agents_public_read` is `SELECT` to `PUBLIC`, exposing every agent's `cap_amount`, `default_split_pct` and `no_brokerage_split`.

**The methodological lesson is the point.** `migrations/production/README.md` records that the live database predates this codebase and never received the numbered migrations. Any finding in this document derived from `schema.sql` alone describes the repo's *intent*, not production's *state* — the two have been diverging since 2026-06-10. Migration `0027` was rewritten to discover anon-reachable policies from `pg_policies` **by role rather than by name** for exactly this reason: a name-based drop would have silently no-opped against the live policy names (`prop_select`, `properties_public_read`, `"Allow all"`) while reporting success.

---

## Part 3 — What Must Be Better Than kvCORE, FUB, Chime, Sierra, BoomTown

Gateway will never win on breadth. It wins on these six, or it has no reason to exist:

**1. Speed of data entry — one address, typed once.**
FUB and kvCORE both make you re-key a property into a deal. Gateway should parse a pasted address once and fan it out to property + deal + forms + BoldSign prefill. Target: **a new multifamily pursuit created in under 30 seconds from a pasted address**, versus ~3 minutes of retyping today.

**2. Mobile-first where the work actually happens — the car.**
kvCORE's mobile app is a read-only shell. Gateway's is currently worse: no search, no drag. The Midwest edge case is real — agents drive 90 minutes between Sioux Falls, Omaha, and Des Moines showings. Voice-note-to-activity and one-thumb stage advance beat every feature on this list.

**3. Transaction coordination as a gate, not a checklist.**
BoomTown and Chime treat closing checklists as suggestions. Gateway already has `getClosingGate()` blocking the `closed` stage — that is genuinely ahead of the market. Finish it by binding each sign-step to its actual envelope and each deal to its state's required packet.

**4. Multi-state compliance as a system property.**
No commercial CRM knows that an Iowa listing needs different disclosures than a South Dakota one. Gateway has `OPERATING_STATES` and `form_packets(state, transaction_type)` — the data model is already there. Wire it into the gate and this becomes a defensible moat no national vendor will build for a three-state footprint.

**5. Commercial multifamily is a first-class citizen.**
Every named competitor is residential-first; commercial is bolted on. Gateway has LOI → PSA → Due Diligence stages, unit-count fields, and OM workflow. That is the actual differentiator — and it is currently the part of the system the automation ignores (see A1).

**6. Cost structure: fixed, not per-seat.**
kvCORE runs $1,200–$1,500/mo for a mid-size office; FUB is $70–$100/seat. Gateway's marginal cost per agent is roughly zero on Vercel + Supabase Pro. **Adding the 15th agent should cost $0.** Protect that by refusing per-agent third-party keys — `agents.twilio_number` and per-agent Mailchimp keys already violate it.

**7. Agent adoption is the only metric that matters.**
Every commercial CRM dies the same way: agents keep their real pipeline in a spreadsheet. The counter-metric: **percentage of closed deals whose stage history shows ≥3 stage transitions logged in-system**. If deals appear already at `under-contract`, agents are using the CRM as a filing cabinet and nothing else you build matters.

---

## Part 4 — Action Lists

### A. Five Things to Fix Right Away

---

**A1. Lock down the eight publicly-writable tables.**

Eight `allow_all` policies omit the `TO authenticated` clause, exposing properties, teams, team_splits, templates, and all four mailing tables — including every mailing recipient's home address — to anonymous read *and write* via the public anon key.

*Why it matters:* This is unauthenticated PII exposure plus destructive write access to the property database. It also silently defeats the RLS scoping already built for contacts, deals, and commissions — the security model reads as sound but has an open side door.

*Implementation:* One migration adding `to authenticated` to all eight policies and dropping the anon fallback credentials from `supabase.js:3–4`. `properties` needs the public landing-page read preserved — move that behind the existing service-key route in `api/property-public.js` (which already exists) rather than granting anon table access. **Success metric: `select * from pg_policies where schemaname='public' and roles = '{public}'` returns only the intended public-read rows.**

---

**A2. Deadline reminders never fire for commercial or seller-side deals.**

`api/cron.js:51` defines `ACTIVE_STAGES = ['lead','qualified','showing','offer','under-contract']` and the reminder query filters `.in('stage', ACTIVE_STAGES)` — omitting all seven commercial stages (`pursuit`, `om-marketing`, `listing-agreement`, `on-market`, `loi`, `psa`, `due-diligence`) and both residential-seller stages (`pre-list`, `active`).

*Why it matters:* Gateway is a commercial multifamily brokerage. The deadline engine is blind to the majority of the pipeline — every DD expiration, financing contingency, and PSA deadline on a commercial deal passes unannounced. A missed DD deadline is a lost earnest money deposit and a legal exposure, and the system currently reports success while doing nothing.

*Implementation:* Replace the hardcoded array with `ALL_DEAL_STAGES.filter(isOpenStage)` imported from `stages.js`. Add a regression test asserting every open stage is covered. **Success metric: a seeded `due-diligence` deal with a key date 3 days out produces a reminder send.**

---

**A3. The reminder SMS texts the client, not the agent.**

`api/cron.js` sends the deadline SMS with `To: contact.phone` — the *client's* number — carrying the body *"Gateway CRM reminder: Closing for '123 Main' is TOMORROW. Log in to review your deal."*

*Why it matters:* Two failures in one line. Operationally, the person who needs the deadline never gets the text. Legally, it is an automated commercial SMS to a consumer with no captured opt-in and no STOP language — squarely in TCPA and A2P 10DLC territory, at $500–$1,500 statutory damages per message.

*Implementation:* Change the recipient to the agent's mobile. If client-facing SMS is wanted later, it needs a consent column on `contacts`, a suppression check, and STOP handling in `api/twilio-webhook.js` first. **Success metric: zero cron-originated SMS to a `contacts.phone` number.**

---

**A4. Connect the global search box that was built but never wired.**

`App.jsx:618` renders a search input with no `onChange` and no handler. The Postgres functions `search_contacts()` and `search_properties()` exist, are GIN-indexed, and are granted to `authenticated` — with zero callers in the client. On mobile the input is hidden entirely.

*Why it matters:* Search is the single highest-frequency action in any CRM, and agents currently navigate to Contacts, then filter, to find one person. A dead search bar is also the fastest way to teach agents the system is unfinished — which is how CRMs lose adoption. The backend work is already done and paid for.

*Implementation:* Wire the input to the existing RPCs behind the `useDebounce` hook already in `src/hooks/`, render a grouped result dropdown, bind to `Cmd/Ctrl+K` via the existing `useKeyboard` hook, and unhide it on mobile. **Success metric: any contact, property, or deal reachable in ≤2 keystrokes-plus-Enter from any page, on any device.**

---

**A5. Stop loading the entire brokerage database on every login.**

`App.jsx:381–400` fetches contacts, properties, deals, tasks, templates, **all activities with no limit**, and both junction tables before rendering. For an admin this is every row in the firm.

*Why it matters:* Login latency is the first impression every agent gets every morning, and it degrades linearly with the brokerage's success — the system gets slower the more deals you close. Activities alone grow unbounded forever.

*Implementation:* Load agents + the active route's data only; move activities to per-record lazy fetch (`ActivityTab.jsx` already fetches its own); paginate contacts and properties behind the search from A4. The `queryCache.js` primitives for this already exist. **Success metric: time-to-interactive under 1.5s for an admin account with 50,000 activity rows.**

---

### B. Five Things to Implement Next

---

**B1. Address-first intake — type the address once, everything else fans out.**

A single paste-an-address field that creates the property, the deal, the state assignment, and the required-forms binding in one action, with the deal title auto-composed.

*Why it matters:* This is the "one address, typed once" promise from Part 3 and the largest single time saving available — it removes three of the four re-entry points traced in §1.2. It is also the feature agents will feel on day one, which is what drives adoption.

*Implementation:* Extend `QuickAdd.jsx` (which today creates deals with no `contact_id`, no `property_id`, and no `prop_category` — orphans that can never pass the closing gate). Parse the address, derive `state` into `comp_data.state`, and set `prop_category` from the property type. **Success metric: new multifamily pursuit, from paste to saved deal, in under 30 seconds and under 6 keystrokes beyond the address.**

---

**B2. Bind the compliance gate to state-required forms and to actual envelopes.**

Two changes to `getClosingGate()`: add a `deal_required_forms` join so each sign-step points at the specific `boldsign_documents` row that satisfies it, and add a seventh blocker asserting every `form_packets` row marked required for `(comp_data.state, transaction_type)` has a completed envelope.

*Why it matters:* This converts the gate from a counter into a proof, and makes multi-state compliance a property of the system rather than a habit of the transaction coordinator. It is also the moat from Part 3 §4 — no national vendor will build IA/SD/NE form logic for a three-state brokerage.

*Implementation:* Add `required boolean` to `form_packets`, a `satisfied_by uuid references boldsign_documents(id)` column on `transaction_steps`, and extend `compliance.js`. The `compliance.test.js` suite already exists to extend. **Success metric: an Iowa listing cannot reach `closed` without an executed Iowa listing agreement, verified by envelope ID, not by count.**

---

**B3. Mobile pipeline that actually works with a thumb.**

Replace HTML5 drag with a tap-to-advance stage control, add voice-note-to-activity, and surface today's tasks plus deadline blockers on the mobile dashboard.

*Why it matters:* Agents in the IA/SD/NE corridor spend hours driving between markets, and that is exactly when pipeline hygiene happens or doesn't. Today the phone can't search (A4) and can't move a deal — so the day's updates get entered at 9pm, or never. Every competitor's mobile app is a read-only shell; a genuinely write-capable mobile CRM is a real advantage.

*Implementation:* A stage-advance sheet on tap (no drag), reusing `STAGE_AUTO_TASKS` so the follow-up task still fires. Voice notes via the browser MediaRecorder API into `activities` — no native app required. **Success metric: ≥40% of stage transitions originate from a mobile viewport within 60 days.**

---

**B4. Delete the dead tracks, the duplicate stage list, and the shadow lead tables.**

Remove `TRACKS.commercial`, `residential-buyer`, `residential-seller` and the 40-entry `FOREIGN_STAGE_MAP` now that `unified` is the decided board; delete `helpers.js:37 STAGE_ORDER`; collapse `cold_call_leads`, `lead_captures`, `mailing_leads`, `mailing_recipients`, and `mailing_subscribers` into `contacts` + a `contact_sources` child.

*Why it matters:* This is the highest-ROI work on the list because it is pure subtraction. Five tables and four hand-rolled conversion paths become one table and one insert — removing four independent dedupe bugs and roughly 800 lines. Every future feature that touches "a person" then has exactly one place to touch.

*Implementation:* Migration to backfill into `contacts` + `contact_sources(source_type, source_id, payload jsonb)`, then drop. `scripts/check-enums.mjs` already guards stage-token drift and will catch mistakes. **Success metric: one `INSERT INTO contacts` path in the entire codebase; net LOC change negative.**

---

**B5. Deal-velocity reporting: where deals stall and which sources actually close.**

Stage-duration tracking (`deal_stage_history`) feeding two reports: average days-in-stage by stage, and closed-volume by original lead source.

*Why it matters:* This is the only thing on either list that changes *management* behavior rather than agent behavior. Knowing that commercial deals sit 47 days in Due Diligence, or that cold calls close at 3× the rate of QR postcards, redirects agent time and marketing spend — which is worth more than any workflow saving. It also finally answers whether `Campaigns.jsx`'s 2,480 lines earn their keep.

*Implementation:* Requires fixing a prerequisite: `QuickAdd.jsx:17` hardcodes `source: 'other'` on every quick-added contact, destroying attribution at the point of capture. Then a stage-change trigger writing `deal_stage_history`, and two queries in `Reports.jsx`. **Success metric: cost-per-closed-deal by source, computable per agent per quarter.**

---

## North Star

An agent opens Gateway on their phone in a driveway in Sioux Falls, hits Cmd-K or the search field, types four letters of a street name, and the deal is on screen in under a second. They tap once to advance it from LOI to PSA — the follow-up task creates itself, the deadline reminder arms itself, and the state's required disclosure is already queued for signature because the system knows the property is in South Dakota and knows what South Dakota requires. They hold the mic button, say what happened in the meeting, and drive to the next one. Nothing was typed twice. Nothing was filed. Nothing was remembered. At closing, the deal cannot move to `closed` until every required document is genuinely executed — not counted, *executed* — so the transaction coordinator's job stops being chasing and starts being reviewing. The CRM never asks the agent for data it could have derived, never shows a screen that isn't the next action, and never once makes them think about the CRM.

---

## Appendix — Findings Index

| # | File | Severity | Finding |
|---|---|---|---|
| 1 | `schema.sql:300,304,421,444,942,977,998,1024` | 🔴 Critical | 8 RLS policies default to `PUBLIC` — anon read+write. **Fresh installs only; see the §2.5 correction for live state** |
| 1a | live DB (`pg_policies`, 2026-08-07) | 🔴 Critical | `canva_connections` open to anon `ALL` — orphan table, name implies stored OAuth credentials |
| 1b | live DB (`pg_policies`, 2026-08-07) | 🔴 Critical | `mail_sends`/`mail_campaigns`/`mail_suppressions` open to anon `ALL` — legacy v1 PII, writable. Fix: run migration `0001` |
| 1c | live DB (`pg_policies`, 2026-08-07) | 🟠 High | `deal_contacts` open to anon `ALL`; repo defines it deal-scoped |
| 1d | live DB (`pg_policies`, 2026-08-07) | 🟠 High | `agents_public_read` exposes `cap_amount` / `default_split_pct` to anon |
| 1e | live DB (`pg_policies`, 2026-08-07) | 🟡 Medium | `campaign_scans`, `option_values` open to anon `ALL` |
| 2 | `api/cron.js:51` | 🔴 Critical | Reminders skip all commercial + seller stages |
| 3 | `api/cron.js` (runReminders) | 🔴 Critical | Deadline SMS sent to client; TCPA/A2P exposure |
| 4 | `App.jsx:618` | 🟠 High | Global search input has no handler; RPCs unused |
| 5 | `App.jsx:381` | 🟠 High | Unbounded full-DB load on login |
| 6 | `compliance.js:53` | 🟠 High | Signature gate compares counts, not envelope identity |
| 7 | `Pipeline.jsx:642` | 🟠 High | State forms are a manual search; never gate-enforced |
| 8 | `Pipeline.jsx:3312` | 🟠 High | Kanban drag is desktop-only (no touch) |
| 9 | `QuickAdd.jsx:80` | 🟡 Medium | Quick deals orphaned — no contact/property/category |
| 10 | `QuickAdd.jsx:17` | 🟡 Medium | `source: 'other'` hardcoded; destroys attribution |
| 11 | `helpers.js:37` | 🟡 Medium | Duplicate stage list; QuickAdd uses the stale one |
| 12 | `stages.js:34` | 🟡 Medium | 3 dead tracks + 40-entry foreign-stage map |
| 13 | `schema.sql:1327` | 🟡 Medium | `option_value_counts` view undefined; page shows zeros |
| 14 | `commission.js:38` | 🟡 Medium | Dual commission model with 4-tier runtime precedence |
| 15 | `QuickAdd.jsx:199` | 🟢 Low | Full-table refetch after every quick add |
