# Gateway CRM — Visibility & Permission System Redesign

**Status:** Proposal for review (no schema applied yet)
**Author:** Architecture
**Date:** 2026-07-21
**Supersedes the visibility model in:** `migrations/0002`, `migrations/0011`, `src/lib/schema.sql` (SCOPED RLS POLICIES section)

---

## 0. Where we are today (grounding)

The existing model is well-built but couples three concerns that the new business rules require us to separate:

| Concern | Today | Problem under the new rules |
|---|---|---|
| **Deal ownership** | `deals.agent_id` (single owner column) | Only one agent can be the "owner"; additional agents aren't first-class. |
| **Additional-agent visibility** | *Inferred* from `commissions.participants` jsonb + legacy `deals.co_agent_ids[]` | Visibility is welded to payroll. You can't grant view access without putting someone on the split, and you can't remove view access without touching commissions. |

> **⚠️ Critical drift found while validating against the live pipeline UI.** The avatar chips shown on pipeline cards (`Pipeline.jsx:2607`, `2713`) are computed from **`property.details.co_agent_ids`** — a jsonb array on the *property* — **not** from `commissions.participants`, which is what RLS actually uses to grant visibility. So there are **three disagreeing "co-agent" sources**: `deals.agent_id` (primary chip), `property.details.co_agent_ids` (the extra chips users SEE), and `commissions.participants` + `deals.co_agent_ids` (what the DB ENFORCES). A person can appear as a chip without DB access, or have DB access with no chip. The redesign's whole job is to collapse all three into one source of truth (`deal_agents`) that the chips render from and RLS enforces from — so "the chips are who can see it" becomes literally true.
| **Team visibility** | `team_splits.share_contacts/share_properties/share_deals`, **all default `TRUE`** | Teammates auto-see each other's deals. The brief says the opposite: default OFF. |
| **Cross-team partner sharing** | *Does not exist* | No way for Daniel & Nic (different teams) to share specific records. |

Enforcement lives in Postgres RLS via security-definer helpers — `app_current_agent_id()`, `app_is_admin()`, `app_visible_agent_ids(dimension)`, `app_visible_deal_ids()` — which is exactly the right foundation. **We keep that foundation and re-point it at a cleaner data model.**

### Guiding principles for the redesign
1. **One source of truth for deal visibility: explicit tags.** Not payroll, not team membership.
2. **Visibility is additive and default-deny.** A row is invisible unless a rule grants it.
3. **Enforce in the database (RLS), configure in the app.** The client can never widen access.
4. **Configuration is hierarchical and future-proof:** Brokerage → Team → User, with room for per-property-type / per-deal-type rules without new tables.
5. **Pay ≠ Access.** A referral partner can be paid without seeing the pipeline; a coordinator can see without being paid.

---

## 1. Decisions taken (defaults chosen)

Because these are being applied to a live security model, each is reversible and grandfathered:

1. **Explicit `deal_agents` tag table is the SOLE source of deal visibility.** `commissions.participants` remains for **pay only**.
2. **`team_splits.share_*` defaults flip to `FALSE`**; a team-level `visibility_mode` toggle re-enables team-wide visibility as an *opt-in*. Existing teams are **grandfathered** (current sharing preserved) so nobody loses access on deploy.
3. **Persistent "sharing groups"** model the Daniel×Nic partnership; specific contacts/properties are placed into a group and every member sees exactly those records.
4. **Delivered as this design doc first.** Migrations/code below are complete and ready, but not applied until approved.

---

## 2. New Data Model

### 2.1 `deal_agents` — the tagging table (source of truth)

```sql
create table if not exists deal_agents (
  id         uuid primary key default uuid_generate_v4(),
  deal_id    uuid not null references deals(id)  on delete cascade,
  agent_id   uuid not null references agents(id) on delete cascade,
  role       text not null check (role in ('primary','additional')) default 'additional',
  -- optional future scoping of WHAT a tagged agent may do (view vs edit)
  can_edit   boolean not null default true,
  added_by   uuid references agents(id) on delete set null,
  created_at timestamptz default now(),
  unique (deal_id, agent_id)                 -- an agent appears once per deal
);
create unique index deal_agents_one_primary
  on deal_agents(deal_id) where role = 'primary';   -- exactly one primary
create index deal_agents_agent_idx on deal_agents(agent_id);
create index deal_agents_deal_idx  on deal_agents(deal_id);
```

- **`deals.agent_id` stays** as a denormalized pointer to the primary agent (hundreds of code paths and landing pages read it). A trigger keeps it in lockstep with the `primary` row so the two never drift.
- Being tagged (either role) = full visibility of the deal + its property, contacts, and commissions. `can_edit` lets us later distinguish view-only additional agents without another migration.

### 2.2 Sharing groups — cross-team partner channel

```sql
create table if not exists sharing_groups (
  id          uuid primary key default uuid_generate_v4(),
  name        text not null,                 -- "Gateway × MAD — Commercial Multifamily"
  description text,
  created_by  uuid references agents(id) on delete set null,
  archived    boolean not null default false,
  created_at  timestamptz default now()
);

create table if not exists sharing_group_members (
  id         uuid primary key default uuid_generate_v4(),
  group_id   uuid not null references sharing_groups(id) on delete cascade,
  agent_id   uuid not null references agents(id)         on delete cascade,
  role       text not null check (role in ('owner','member')) default 'member',
  created_at timestamptz default now(),
  unique (group_id, agent_id)
);

-- Records placed INTO a group. Polymorphic: today contacts + properties,
-- extensible to other entity types without a new table.
create table if not exists sharing_group_records (
  id           uuid primary key default uuid_generate_v4(),
  group_id     uuid not null references sharing_groups(id) on delete cascade,
  entity_type  text not null check (entity_type in ('contact','property')),
  entity_id    uuid not null,
  shared_by    uuid references agents(id) on delete set null,
  created_at   timestamptz default now(),
  unique (group_id, entity_type, entity_id)
);
create index sgr_lookup_idx on sharing_group_records(entity_type, entity_id);
create index sgr_group_idx   on sharing_group_records(group_id);
```

**Why groups, not deal tags, for the partnership:** the brief is explicit — Daniel & Nic share *specific Contacts and Properties* **without** granting deal/team access. Group membership grants read (and optionally write) on the *placed records only*. It never touches `deal_agents`, so no deal, commission, or pipeline leaks across the partnership.

### 2.3 Configuration hierarchy — `visibility_settings`

A single table expresses Brokerage / Team / User configuration, with a jsonb `rules` column for future per-type extensibility.

```sql
create table if not exists visibility_settings (
  id          uuid primary key default uuid_generate_v4(),
  scope       text not null check (scope in ('brokerage','team','user')),
  scope_id    uuid,                          -- null for brokerage; team_id / agent_id otherwise
  -- coarse switches (resolved most-specific-wins)
  team_deal_visibility  text check (team_deal_visibility in ('off','all','leads_only')) default 'off',
  -- future-proof extensibility: per property/deal type overrides, etc.
  rules       jsonb not null default '{}',   -- e.g. {"by_prop_category":{"commercial":"all","residential":"off"}}
  updated_by  uuid references agents(id) on delete set null,
  updated_at  timestamptz default now(),
  unique (scope, scope_id)
);
```

Resolution order for any decision: **User setting → Team setting → Brokerage setting → hard default (`off`)**. `rules` lets a team say "share all *commercial* deals but keep residential private" with zero schema change.

`team_splits.share_*` defaults change to `FALSE` (strict by default); the team-level `team_deal_visibility` toggle is the clean, single opt-in that supersedes the three per-flag columns going forward (the columns remain for backward-compat and per-dimension nuance).

---

## 3. Updated Visibility Matrix

| Actor | Deals / Properties / Commissions / Contacts they see | Explicitly cannot see |
|---|---|---|
| **Regular Agent** | Deals they are tagged on (`deal_agents`, primary **or** additional) + that deal's property, contacts, commission. Their own assigned contacts/properties. Records shared to a group they belong to. | Every untagged deal — **including teammates'** (unless team override is ON). |
| **Daniel (you)** | Your tagged deals + linked records; plus contacts/properties Nic placed in your shared group. | Nic's private deals, his team, his other contacts/properties. |
| **Nic** | His tagged deals + linked records; plus items you placed in the shared group. | Your private deals, your team, your other records. |
| **Team Lead / Broker** | Default = same as a regular agent (own tagged deals). If `visibility_mode='all'` set for their team → all that team's deals. Configurable per property/deal type via `rules`. | Other teams' deals unless separately granted. |
| **Admin** (`agents.is_admin`) | Everything, firm-wide (unchanged). | — |

**Commissions** remain **admin-only at the row level** (your 2026-06-12 decision), with each agent's own slice delivered via `/api/my-earnings` (service key). Tagging changes *who sees the deal*, not who sees the money math.

### Worked examples

1. **Strict default.** Agent A and Agent B are both on "Team Prairie" (`visibility_mode='off'`). A creates a deal, tagged only to A. B sees nothing — not in pipeline, not in search, not via the API. ✔ per-deal only.

2. **Additional-agent tag.** A adds B as an *additional agent* on the deal (a row in `deal_agents`, `role='additional'`). B now sees the deal, its property, its contacts. B is **not** on the commission split, so B still sees no earnings. Pay and access are independent. ✔

3. **Partner sharing (Daniel × Nic).** Daniel places Property P and Contact C into group "Gateway × MAD." Nic sees P and C in his Contacts/Properties lists and can collaborate. Nic's deal that references P is still invisible to Daniel — only the *record* is shared, not Nic's deal. ✔

4. **Team override, scoped by type.** Team Prairie's lead sets `rules = {"by_prop_category":{"commercial":"all"}}`. Now every Prairie member sees each other's **commercial** deals, but residential deals stay strictly per-tag. ✔ future-proof.

5. **Removing a tag.** A removes B from `deal_agents`. On B's next query the deal, its commissions, documents, and contacts vanish atomically — because RLS derives every child from `app_visible_deal_ids()`, which is now tag-driven. No orphaned access. ✔

---

## 4. Implementation

### 4.1 Migration `0024_tagging_and_sharing.sql` (Phase A — additive, zero behavior change)

```sql
-- 0024 — Tag-based deal visibility + cross-team sharing groups + config hierarchy
-- Phase A creates tables, backfills, and REFRESHES the helper functions so they
-- read the new model. Because legacy allow_all is already dropped, refreshing
-- app_visible_deal_ids() is the switch — so we backfill FIRST, then refresh.

-- 1) Tables (section 2 above) ------------------------------------------------
--    [deal_agents, sharing_groups, sharing_group_members,
--     sharing_group_records, visibility_settings]  -- see full DDL above
alter table deal_agents            enable row level security;
alter table sharing_groups         enable row level security;
alter table sharing_group_members  enable row level security;
alter table sharing_group_records  enable row level security;
alter table visibility_settings    enable row level security;

-- 2) Backfill tags from ALL THREE existing sources so the tags match what
--    users SEE on the cards AND what RLS currently enforces (see drift note §0).
--    Primary = current deals.agent_id
insert into deal_agents (deal_id, agent_id, role)
  select id, agent_id, 'primary' from deals where agent_id is not null
  on conflict (deal_id, agent_id) do nothing;
--    Additional (a) = the chips users actually see: property.details.co_agent_ids,
--    mapped onto every deal that references that property.
insert into deal_agents (deal_id, agent_id, role)
  select d.id, (ca)::uuid, 'additional'
  from deals d
  join properties pr on pr.id = d.property_id
  cross join lateral jsonb_array_elements_text(coalesce(pr.details->'co_agent_ids','[]'::jsonb)) ca
  where (ca) ~ '^[0-9a-f-]{36}$'
  on conflict (deal_id, agent_id) do nothing;
--    Additional (b) = commission participants (what RLS enforced) + legacy co_agent_ids
insert into deal_agents (deal_id, agent_id, role)
  select c.deal_id, (p->>'agent_id')::uuid, 'additional'
  from commissions c
  cross join lateral jsonb_array_elements(coalesce(c.participants,'[]'::jsonb)) p
  where (p->>'agent_id') ~ '^[0-9a-f-]{36}$'
  on conflict (deal_id, agent_id) do nothing;
insert into deal_agents (deal_id, agent_id, role)
  select id, unnest(co_agent_ids), 'additional' from deals
  where co_agent_ids is not null
  on conflict (deal_id, agent_id) do nothing;
-- NOTE: the union of these sources may GRANT access that RLS didn't give before
-- (chip-only agents who weren't commission participants). That is the intended
-- reconciliation — it makes access match what the pipeline already displays.
-- Review the diff (query in the verification checklist) before Phase B.

-- 3) Grandfather team sharing: seed a team-level setting mirroring today -----
insert into visibility_settings (scope, scope_id, team_deal_visibility)
  select 'team', team_id, 'all'
  from team_splits where share_deals is not false
  group by team_id
  on conflict (scope, scope_id) do nothing;
-- New default for future rows is strict:
alter table team_splits alter column share_contacts   set default false;
alter table team_splits alter column share_properties set default false;
alter table team_splits alter column share_deals       set default false;

-- 4) Keep deals.agent_id in lockstep with the primary tag -------------------
create or replace function sync_primary_deal_agent()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.agent_id is not null then
    insert into deal_agents (deal_id, agent_id, role)
      values (new.id, new.agent_id, 'primary')
    on conflict (deal_id) where role='primary'
      do update set agent_id = excluded.agent_id;
  end if;
  return new;
end $$;
drop trigger if exists trg_sync_primary_deal_agent on deals;
create trigger trg_sync_primary_deal_agent
  after insert or update of agent_id on deals
  for each row execute function sync_primary_deal_agent();
```

### 4.2 Refreshed permission helpers (the actual switch)

```sql
-- Deals visible to the current user: tag-based, + team override, + admin.
create or replace function app_visible_deal_ids()
returns setof uuid
language sql stable security definer set search_path = public as $$
  -- admin: everything
  select id from deals where app_is_admin()
  union
  -- explicitly tagged (primary or additional) -- THE PRIMARY RULE
  select deal_id from deal_agents where agent_id = app_current_agent_id()
  union
  -- team override: deals owned by a teammate when the resolved team setting says so
  select d.id
  from deals d
  join deal_agents da on da.deal_id = d.id and da.role='primary'
  join team_splits owner_ts on owner_ts.agent_id = da.agent_id
  join team_splits me_ts     on me_ts.team_id   = owner_ts.team_id
                            and me_ts.agent_id  = app_current_agent_id()
  where app_team_deal_visibility(owner_ts.team_id, d.prop_category) = 'all';
$$;

-- Resolve team deal-visibility with user>team>brokerage precedence + type rules.
create or replace function app_team_deal_visibility(p_team uuid, p_prop_category text)
returns text
language sql stable security definer set search_path = public as $$
  with settings as (
    select scope, team_deal_visibility, rules from visibility_settings
    where (scope='team' and scope_id = p_team)
       or (scope='brokerage')
  )
  select coalesce(
    -- per-type override first
    (select rules->'by_prop_category'->>p_prop_category from settings where scope='team'),
    (select team_deal_visibility from settings where scope='team'),
    (select rules->'by_prop_category'->>p_prop_category from settings where scope='brokerage'),
    (select team_deal_visibility from settings where scope='brokerage'),
    'off'
  );
$$;

-- Contacts shared to me via any sharing group I belong to.
create or replace function app_shared_contact_ids()
returns setof uuid language sql stable security definer set search_path=public as $$
  select r.entity_id::uuid
  from sharing_group_records r
  join sharing_group_members m on m.group_id = r.group_id
  join sharing_groups g        on g.id = r.group_id and not g.archived
  where r.entity_type='contact' and m.agent_id = app_current_agent_id();
$$;

-- Properties shared to me via any sharing group (mirror of the above).
create or replace function app_shared_property_ids()
returns setof uuid language sql stable security definer set search_path=public as $$
  select r.entity_id::uuid
  from sharing_group_records r
  join sharing_group_members m on m.group_id = r.group_id
  join sharing_groups g        on g.id = r.group_id and not g.archived
  where r.entity_type='property' and m.agent_id = app_current_agent_id();
$$;

grant execute on function app_visible_deal_ids()              to authenticated;
grant execute on function app_team_deal_visibility(uuid,text) to authenticated;
grant execute on function app_shared_contact_ids()           to authenticated;
grant execute on function app_shared_property_ids()          to authenticated;
```

### 4.3 Updated RLS policies (deltas only)

```sql
-- CONTACTS — assigned to a visible agent, OR tagged onto a visible deal,
--            OR shared to me via a group. (Admins keep firm-wide.)
drop policy if exists contacts_agent_scope on contacts;
create policy contacts_agent_scope on contacts for all to authenticated
  using (
    app_is_admin()
    or assigned_agent_id in (select app_visible_agent_ids('contacts'))
    or id in (select app_shared_contact_ids())
    or id in (select contact_id from deal_contacts where deal_id in (select app_visible_deal_ids()))
    or id in (select contact_id from deals where id in (select app_visible_deal_ids()) and contact_id is not null)
  )
  with check (
    app_is_admin()
    or assigned_agent_id in (select app_visible_agent_ids('contacts'))
  );

-- PROPERTIES — currently allow_all for public landing reads. Split the posture:
--   • anon/public SELECT stays (landing pages) — route through service key ideally
--   • authenticated writes/visibility scope to owner + deal-linked + shared.
--   (Deferred to Phase B for properties; see §5 performance note.)

-- DEALS — now purely tag-driven via the refreshed function.
drop policy if exists deals_agent_scope on deals;
create policy deals_agent_scope on deals for all to authenticated
  using (id in (select app_visible_deal_ids()))
  with check (
    app_is_admin()
    or id in (select app_visible_deal_ids())
    or agent_id = app_current_agent_id()   -- create a deal owned by yourself
  );

-- Sharing-group tables: members see their groups; owners/admins manage.
create policy sg_member_read on sharing_groups for select to authenticated
  using (app_is_admin() or id in (
    select group_id from sharing_group_members where agent_id = app_current_agent_id()));
create policy sgm_scope on sharing_group_members for all to authenticated
  using (app_is_admin() or group_id in (
    select group_id from sharing_group_members where agent_id = app_current_agent_id()))
  with check (app_is_admin() or group_id in (
    select group_id from sharing_group_members where agent_id = app_current_agent_id() and role='owner'));
create policy sgr_scope on sharing_group_records for all to authenticated
  using (app_is_admin() or group_id in (
    select group_id from sharing_group_members where agent_id = app_current_agent_id()))
  with check (app_is_admin() or group_id in (
    select group_id from sharing_group_members where agent_id = app_current_agent_id()));

-- deal_agents: you can see tag rows for deals you can see; you can add/remove
-- tags on deals you can see (primary can always manage; admins always).
create policy deal_agents_scope on deal_agents for all to authenticated
  using (app_is_admin() or deal_id in (select app_visible_deal_ids()))
  with check (app_is_admin() or deal_id in (select app_visible_deal_ids()));
```

### 4.4 Service layer — `src/lib/services/deals.js`

Replace payroll-derived co-listing with the tag table:

```js
// IDs of deals the agent is TAGGED on (primary or additional) — the new,
// canonical visibility source. Replaces fetchCoListedDealIds().
export async function fetchTaggedDealIds(client, agentId) {
  if (!agentId) return { data: [], error: null }
  const { data, error } = await client
    .from('deal_agents').select('deal_id').eq('agent_id', agentId)
  return { data: (data || []).map(r => r.deal_id), error }
}

// Every deal the agent may see, newest first. Admins get the firm; everyone
// else gets tagged deals (+ team-override deals, which RLS already includes,
// so a single id-based fetch is sufficient and always matches the DB).
export async function fetchVisibleDeals(client, { isAdmin }) {
  // RLS does the scoping; the client just asks for "all" and receives its slice.
  return client.from('deals').select('*').order('created_at', { ascending: false })
}
```

> Because RLS is now the single authority, the client no longer needs to reconstruct the visibility set (`visibleAgentIds`, `dealAgentIds`, chunked co-list merges in `App.jsx`). It fetches `select('*')` and receives exactly its slice. That deletes a whole class of client/DB drift bugs. The `deal_agents` fetch is only needed for *editing* the tag list on the Deal page.

### 4.5 Pipeline card chips — re-source from `deal_agents`

Today `Pipeline.jsx` builds card chips from `deal.agent_id + property.details.co_agent_ids` (lines ~2607 and ~2713). Change both to render from the deal's tags so the chips = the visibility set exactly:

```js
// was: [deal.agent_id, ...(propertyMap[deal.property_id]?.details?.co_agent_ids || [])]
const tagAgents = (dealAgentsMap[deal.id] || [])      // rows from deal_agents
  .sort((a,b) => (a.role==='primary'?-1:1))            // primary first
  .map(t => agentMap[t.agent_id]).filter(Boolean)
```

Load `dealAgentsMap` once alongside deals (a single `select('deal_id,agent_id,role')` from `deal_agents`, already RLS-scoped to visible deals). `property.details.co_agent_ids` is then deprecated for visibility — keep it only if it drives anything else (it shouldn't after this).

### 4.6 Deal-page tagging UI

On `src/pages/DealPage.jsx`, add an **"Agents on this deal"** panel:
- Primary Agent selector (single, required) → writes `deals.agent_id` (trigger syncs the tag).
- Additional Agents multi-select (reuse `OptionMultiSelect`/`ContactMultiSelect` patterns) → upserts/deletes `deal_agents` rows with `role='additional'`.
- A subtle note: *"Tagged agents can view this deal and its records. Paying an agent is set separately in Commissions."* — reinforcing pay≠access.

### 4.7 Admin configuration UI (`src/pages/Settings.jsx`)

- **Brokerage tab (admin):** default team-deal-visibility (`off` recommended), and per-property-type defaults.
- **Team tab (lead/admin):** toggle "Members see all team deals" → writes `visibility_settings(scope='team')`; optional per-type matrix (commercial/residential × on/off) → `rules.by_prop_category`.
- **Sharing Groups tab:** create a group, add member agents (searchable across teams), and a records inspector showing shared contacts/properties with per-record revoke. This is where Daniel adds Nic and drops in commercial multifamily records.
- **User tab:** a read-only "What can I see?" explainer that calls the helpers so an agent can self-diagnose access.

---

## 5. Security, performance, edge cases

### Security
- **Default-deny everywhere.** Every policy is `using(false)`-equivalent until a union branch grants the row. No `allow_all` remains on scoped tables.
- **Helpers are `security definer` + `set search_path=public`** — matches existing hardening; prevents search-path injection.
- **Pay≠access enforced structurally:** commissions stay admin-only; tagging never grants commission-row access.
- **No privilege escalation via `with check`:** an agent can only tag/insert against deals already in their visible set (or their own new deal).
- **Service-key APIs bypass RLS** (unchanged) — cron, portal, BoldSign, Twilio keep working.

### Performance
- All lookups are indexed: `deal_agents(agent_id)`, `deal_agents(deal_id)`, `sharing_group_records(entity_type, entity_id)`, `sharing_group_members(agent_id)`.
- `app_visible_deal_ids()` is `stable`, so Postgres caches it per-statement. The team-override branch only joins for users whose team has an override — the common (strict) path is a single indexed `deal_agents` scan.
- The client-side simplification (drop the chunked `.in()` merges) removes URL-length risk and N round-trips.
- **Properties note:** properties are still `allow_all` for anonymous landing-page reads. Scope them only after routing that read through a service-key API (tracked as Phase B / follow-up), exactly as `migrations/0002` planned — don't break public pages.

### Edge cases
| Case | Behavior |
|---|---|
| **Removing an additional-agent tag** | Deal + all children (commissions, docs, activities, contacts) drop from that agent's view atomically (all derive from `app_visible_deal_ids()`). |
| **Reassigning primary** | Trigger updates the single `primary` tag; old primary loses access unless separately kept as `additional`. |
| **Agent leaves a team** | `team_splits` row gone → team-override branch stops matching; tagged deals unaffected. |
| **Deleting an agent** | `on delete cascade` clears their tags and group memberships; deals remain (owned by whoever's left / admin). |
| **Archived deals/properties** | Visibility is orthogonal to status — archived items remain visible to tagged agents; add a status filter in the UI, not in RLS. |
| **Commission recalculation** | Untouched — participants still drive math; tags drive sight. Removing someone from the split no longer blinds them if they're still tagged (and vice-versa). |
| **Shared record later un-shared** | Delete the `sharing_group_records` row → the record leaves the partner's view on next query. Archiving the whole group revokes all its records at once. |
| **Duplicate tags / two primaries** | Prevented by `unique(deal_id, agent_id)` and the partial unique index on `role='primary'`. |

### Best practices baked in
- **Phased rollout (A then B)** identical to `0002`/`0011`: create + backfill + refresh helpers (A), verify in staging, then it's live (no separate B needed here since `allow_all` is already gone — the function refresh is the atomic switch, and the backfill guarantees continuity).
- **Grandfathering** means zero surprise access loss on deploy.
- **Reversible:** a rollback block restores the previous `app_visible_deal_ids()` definition verbatim.
- **Auditability:** `deal_agents.added_by`, `sharing_group_records.shared_by`, and the existing `audit_log` (already deal-scoped) record who granted what.

---

## 6. Rollout checklist

1. Apply `0024` Phase A in **staging**; run the verification checklist (below).
2. As a non-admin: pipeline shows only tagged deals; a teammate's untagged deal is invisible; commissions unchanged.
3. Tag yourself as additional on a peer deal → it appears with property + contacts, no earnings.
4. Create a sharing group, add a second agent, drop in a contact + property → they appear for that agent only.
5. Flip a team's `visibility_mode='all'` → members see team deals; flip back → strict.
6. Confirm public landing pages and `/api/*` endpoints unaffected.
7. Deploy app build (tagging UI + simplified `deals.js`) **with** the migration.
8. Promote to production; monitor `audit_log` and the "What can I see?" explainer.

---

## 7. Open follow-ups (post-approval)
- Route public property reads behind a service-key API, then scope `properties` by owner/deal-link/share (finishes the `0002` deferral).
- Optional `can_edit=false` view-only additional agents (schema already supports it).
- Extend `sharing_group_records.entity_type` to `deal` if a future partnership wants true co-deals (kept out now per the brief).
