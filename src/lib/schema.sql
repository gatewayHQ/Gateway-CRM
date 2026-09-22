-- Gateway CRM — Full Database Schema
-- Run in Supabase SQL Editor (Table Editor → SQL Editor → New Query → Run)
-- Safe to re-run: uses IF NOT EXISTS and IF EXISTS guards throughout

create extension if not exists "uuid-ossp";

-- ─────────────────────────────────────────────────────────────────────────────
-- AGENTS
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists agents (
  id         uuid primary key default uuid_generate_v4(),
  auth_id    uuid unique,                  -- links to Supabase Auth user
  name       text not null,
  initials   text not null,
  role       text not null,
  email      text unique not null,
  color      text default '#2d3561',
  team_id    uuid,                         -- future: multi-team support
  specialty  text check (specialty in ('residential', 'commercial')),
  phone      text,                         -- shown on landing-page advisor card
  photo_url  text,                         -- headshot (public URL)
  bio        text,                         -- short advisor bio for landing pages
  tagline    text,                          -- one-line positioning for the advisor profile page
  stats      jsonb not null default '[]',   -- [{label,value}] public vanity stats curated by the agent
  default_split_pct  numeric default 70,   -- agent's default % share of a commission allocation
  no_brokerage_split boolean default false,-- true = keeps 100% (capped / no split)
  is_admin   boolean default false,        -- office admin: sees all deals/docs/commissions
  nav_hidden text[] default '{}',          -- nav item IDs hidden from this agent's sidebar
  -- Personal pipeline column headers: { stage_token: 'Custom Label' }. Display
  -- only — deals.stage always keeps its canonical token (src/lib/stageLabels.js).
  stage_labels jsonb not null default '{}'::jsonb
    constraint agents_stage_labels_object check (jsonb_typeof(stage_labels) = 'object'),
  cap_amount      numeric,                 -- brokerage cap in dollars; null = no cap configured
  cap_anniversary date,                    -- cap year resets on this month/day; null = calendar year
  created_at timestamptz default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- CONTACTS
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists contacts (
  id                uuid primary key default uuid_generate_v4(),
  first_name        text not null,
  last_name         text not null,
  email             text,
  phone             text,
  type              text check (type in ('buyer','seller','landlord','tenant','investor')) default 'buyer',
  status            text check (status in ('active','cold','closed','lead','opportunity','pending')) default 'active',
  -- 'mailing-landing' / 'om-download' are written by api/campaigns.js when a QR
  -- landing page captures someone (see migration 0045 — they were previously
  -- missing here, and the contact insert failed silently because of it).
  source            text check (source in ('referral','website','open house','social','cold call','team','paid service','other',
                                           'mailing-landing','om-download')) default 'other',
  assigned_agent_id uuid references agents(id) on delete set null,
  notes             text,
  tags              text[],
  last_contacted_at timestamptz,
  -- Where the contact lives / is originally from
  owner_address     text,
  owner_city        text,
  owner_state       text,
  owner_zip         text,
  -- Annual reminders
  birthday          date,
  anniversary_date  date,
  -- Spouse / significant other (household relationship)
  spouse_name       text,
  spouse_phone      text,
  spouse_notes      text,
  -- Buyer / investor search criteria (for matching)
  submarket         text,          -- target area / county
  asset_types       text[],        -- e.g. ['multifamily','office']
  size_min          numeric,
  size_max          numeric,
  size_unit         text default 'sqft',  -- sqft | acres | units
  -- Bulk-email suppression. A contact who has asked not to be included in mass
  -- sends is filtered out of every audience (src/lib/audience.js) and skipped by
  -- the send loop even if they were on the list when it was built. Distinct from
  -- mailing_subscribers.status, which opts out of one QR/landing mailing list.
  email_opt_out     boolean not null default false,
  created_at        timestamptz default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- PROPERTIES
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists properties (
  id                uuid primary key default uuid_generate_v4(),
  address           text not null,
  -- Suite / unit / space inside the building at `address` ('Suite 120', '#4',
  -- 'Bldg C') — a space for lease in a strip mall is its own listing, not the
  -- whole building (migration 0042). Free text, because that is what leases and
  -- signage read. Composed for display as "address, unit", and deliberately
  -- LEFT OUT of geocoding queries — see src/lib/address.js.
  unit              text,
  city              text,
  state             text,
  zip               text,
  county            text,
  type              text check (type in (
                      'residential','rental','multifamily',
                      'office','land','retail','industrial','mixed-use','commercial'
                    )) default 'residential',
  status            text check (status in (
                      'active','pending','sold','off-market','leased','cancelled'
                    )) default 'active',
  list_price        numeric,
  sqft              numeric,
  beds              integer,
  baths             numeric,
  garage            integer default 0,
  mls_number        text,
  linked_contact_id uuid references contacts(id) on delete set null,
  assigned_agent_id uuid references agents(id) on delete set null,
  notes             text,
  details           jsonb default '{}',   -- flexible commercial / type-specific fields
  -- Append-only mirror of this listing's price changes, kept for the public
  -- landing page and the pipeline card's "price reduced" badge. `pricing_history`
  -- (below) is the canonical log with an actor on every row — see migration 0040.
  price_history     jsonb not null default '[]'::jsonb,
  comps             jsonb not null default '[]'::jsonb,   -- [{address, price, sqft, ...}]
  created_at        timestamptz default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- DEALS  (Pipeline)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists deals (
  id                  uuid primary key default uuid_generate_v4(),
  title               text not null,
  -- The primary contact of the side we represent. Unchanged, and still what
  -- every single-contact reader uses (BoldSign prefill, portal, mass email).
  contact_id          uuid references contacts(id) on delete set null,
  -- The primary contact PER SIDE (migration 0040). A deal representing both the
  -- buyer and the seller has two client sets that must not overwrite each other;
  -- `contact_id` mirrors whichever of these belongs to the represented side.
  buyer_contact_id    uuid references contacts(id) on delete set null,
  seller_contact_id   uuid references contacts(id) on delete set null,
  property_id         uuid references properties(id) on delete set null,
  agent_id            uuid references agents(id) on delete set null,
  -- Agents sharing this deal's commission alongside `agent_id` (never includes
  -- it). Copied from properties.details.co_agent_ids when a property is
  -- converted into a deal — see migration 0025 and src/lib/coAgents.js.
  co_agent_ids        uuid[] not null default '{}',
  -- stage tokens cover all three boards (src/lib/stages.js): shared/legacy,
  -- the commercial track, and the residential seller track (Milestone 1)
  stage               text check (stage in (
                        'lead','qualified','showing','offer',
                        'under-contract','closed','lost',
                        'pursuit','om-marketing','listing-agreement','on-market',
                        'loi','psa','due-diligence',
                        'pre-list','active'
                      )) default 'lead',
  value               numeric constraint deals_value_nonneg
                        check (value is null or value >= 0),
  probability         integer default 0 constraint deals_probability_range
                        check (probability is null or (probability >= 0 and probability <= 100)),
  expected_close_date date,
  notes               text,
  prop_category       text,                 -- 'residential' | 'commercial' (deal-level category)
  prop_subtype        text,                 -- commercial subtype: multifamily, office, land, retail, industrial
  comp_data           jsonb default '{}',   -- { key_dates:[{type,date}], portal_docs:[name], state, transaction_type }
  -- The ASSIGNED AGENT's commission entry (Details tab) — what the client is
  -- charged, not how it is split. `commissions` is admin-only, so this is the
  -- agent-writable input the back office builds the split from. Resolution order
  -- lives in src/lib/commission.js.
  commission_type     text default 'percent' constraint deals_commission_type_check
                        check (commission_type is null or commission_type in ('percent','flat')),
  commission_pct      numeric constraint deals_commission_pct_range
                        check (commission_pct is null or (commission_pct >= 0 and commission_pct <= 100)),
  commission_flat     numeric constraint deals_commission_flat_nonneg
                        check (commission_flat is null or commission_flat >= 0),
  portal_token        uuid,                 -- client portal share token (unguessable)
  portal_enabled      boolean default false,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);
create unique index if not exists deals_portal_token_idx
  on deals(portal_token) where portal_token is not null;
create index if not exists idx_deals_buyer_contact  on deals(buyer_contact_id);
create index if not exists idx_deals_seller_contact on deals(seller_contact_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- ADDITIONAL CONTACTS  (multi-contact deals & properties — husband/wife,
-- co-buyers, co-owners). deals.contact_id / properties.linked_contact_id stay
-- the PRIMARY contact; these junction rows hold the extra ones, so every
-- existing feature that reads the single contact keeps working.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists deal_contacts (
  id         uuid primary key default uuid_generate_v4(),
  deal_id    uuid not null references deals(id)    on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  -- Which side of the table this person sits on (migration 0040). Null means
  -- "recorded before sides existed" and reads as the side the deal represents,
  -- so a legacy co-signer is never dropped. The unique key deliberately stays
  -- (deal_id, contact_id): one person, one side of one deal.
  side       text constraint deal_contacts_side_check
               check (side is null or side in ('buyer','seller')),
  created_at timestamptz default now(),
  unique (deal_id, contact_id)
);
create index if not exists idx_deal_contacts_deal    on deal_contacts(deal_id);
create index if not exists idx_deal_contacts_contact on deal_contacts(contact_id);
alter table deal_contacts enable row level security;
-- (scoped policy — see "SCOPED RLS POLICIES" at the end of this file)

create table if not exists property_contacts (
  id          uuid primary key default uuid_generate_v4(),
  property_id uuid not null references properties(id) on delete cascade,
  contact_id  uuid not null references contacts(id)   on delete cascade,
  created_at  timestamptz default now(),
  unique (property_id, contact_id)
);
create index if not exists idx_property_contacts_property on property_contacts(property_id);
create index if not exists idx_property_contacts_contact  on property_contacts(contact_id);
-- properties themselves are allow_all (public landing page reads) — the link
-- rows match that posture.
alter table property_contacts enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='property_contacts' and policyname='allow_all') then
    create policy "allow_all" on property_contacts for all to authenticated using (true) with check (true);
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- PRICING HISTORY  (migration 0040)
--
-- One append-only log behind both the property drawer's Pricing History tab and
-- the deal drawer's. A price lives on two records — `properties.list_price` and
-- `deals.value` — and both drawers edit it, so the log is anchored to the
-- PROPERTY (a price belongs to a building) with `deal_id` recording which deal
-- the edit was typed on. `properties.price_history` is still written as a jsonb
-- mirror for the public landing page and the pipeline card's badge.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists pricing_history (
  id              uuid primary key default gen_random_uuid(),
  property_id     uuid references properties(id) on delete cascade,
  -- `set null`, not cascade: the price change is property history and outlives
  -- the deal it was typed on.
  deal_id         uuid references deals(id) on delete set null,
  price           numeric constraint pricing_history_price_nonneg
                    check (price is null or price >= 0),
  previous_price  numeric constraint pricing_history_previous_nonneg
                    check (previous_price is null or previous_price >= 0),
  source          text not null default 'property' constraint pricing_history_source_check
                    check (source in ('deal','property','import','system')),
  changed_by      uuid references agents(id) on delete set null,
  -- Denormalized so an audit line still reads correctly after the agent leaves.
  changed_by_name text,
  note            text,
  created_at      timestamptz not null default now()
);
create index if not exists idx_pricing_history_property on pricing_history(property_id, created_at desc);
create index if not exists idx_pricing_history_deal     on pricing_history(deal_id, created_at desc);
-- Matches the allow_all posture of `properties` itself; property scoping lives
-- in src/lib/services/properties.js.
alter table pricing_history enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='pricing_history' and policyname='allow_all') then
    create policy "allow_all" on pricing_history for all to authenticated using (true) with check (true);
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- TASKS
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists tasks (
  id         uuid primary key default uuid_generate_v4(),
  title      text not null,
  type       text check (type in ('call','email','showing','follow-up','document','other')) default 'other',
  priority   text check (priority in ('high','medium','low')) default 'medium',
  due_date   timestamptz,
  completed  boolean default false,
  contact_id uuid references contacts(id) on delete set null,
  deal_id    uuid references deals(id) on delete set null,
  agent_id   uuid references agents(id) on delete set null,
  notes      text,
  created_at timestamptz default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- EMAIL TEMPLATES
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists templates (
  id          uuid primary key default uuid_generate_v4(),
  name        text not null,
  subject     text not null,
  body        text not null,
  -- Mirrored by TEMPLATE_CATEGORIES in src/lib/enums.js; scripts/check-enums.mjs
  -- fails the build if the form offers a value this constraint would reject.
  category    text check (category in ('intro','follow-up','offer','closing','nurture','deal-announcement')) default 'follow-up',
  agent_id    uuid references agents(id) on delete set null,
  usage_count integer default 0,
  created_at  timestamptz default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- ACTIVITIES  (timeline — calls, notes, emails, meetings, showings)
-- An activity can attach to a contact, a deal, or both (e.g. a call about a
-- specific deal logs to the contact's history AND the deal's timeline).
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists activities (
  id         uuid primary key default uuid_generate_v4(),
  contact_id uuid references contacts(id) on delete cascade,
  deal_id    uuid references deals(id) on delete set null,
  agent_id   uuid references agents(id) on delete set null,
  type       text check (type in ('note','call','email','meeting','showing')) default 'note',
  body       text not null,
  created_at timestamptz default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- DOCUMENTS  (files attached to deals)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists documents (
  id          uuid primary key default uuid_generate_v4(),
  deal_id     uuid references deals(id) on delete cascade,
  agent_id    uuid references agents(id) on delete set null,
  name        text not null,
  size        bigint,
  mime_type   text,
  storage_path text,               -- Supabase Storage object path
  created_at  timestamptz default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- COMMISSIONS
-- ─────────────────────────────────────────────────────────────────────────────
-- Canonical model: one commission row per deal (keyed by deal_id). Two layers:
--   • Legacy flat columns (gross_pct … transaction_fee) — kept for backward
--     compatibility; the app upgrades them on the fly via src/lib/commission.js.
--   • Structured columns (sides, participants) — the complex model: two-sided
--     deals, per-side referrals, and per-agent brokerage arrangements. When
--     these are non-empty they are authoritative. Dollar amounts are always
--     derived in the app from the deal value — never stored.
create table if not exists commissions (
  id              uuid primary key default uuid_generate_v4(),
  deal_id         uuid references deals(id) on delete cascade unique not null,
  gross_pct       numeric not null default 3.0,    -- legacy: gross commission % of deal value
  broker_pct      numeric not null default 30.0,   -- legacy: brokerage share of the split
  agent_pct       numeric not null default 70.0,   -- legacy: agent share of the split
  referral_pct    numeric not null default 0,      -- legacy: referral fee off the top
  co_agent_pct    numeric not null default 0,      -- legacy: co-agent share of agent gross
  transaction_fee numeric not null default 0,      -- flat per-deal brokerage fee, split across agents, charged on top of cap
  sides           jsonb not null default '[]',     -- [{ key,label,rate_pct,flat,referral_pct,referral_flat }] (flat > 0 replaces rate_pct)
  participants    jsonb not null default '[]',     -- [{ id,agent_id,name,role,allocation_pct,split_pct,no_split,fee }] (fee = per-agent override of the flat-fee share)
  notes           text,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- ROW LEVEL SECURITY
-- RLS is enabled here for the core tables. Policies come in two flavors:
--   • SHARED tables (agents, properties, templates, …) keep a permissive
--     allow_all policy — created just below.
--   • SCOPED tables (contacts, deals, commissions, activities, tasks, and the
--     deal-children: documents, boldsign_documents, transaction_steps,
--     deadline_reminders, agent_notifications) are governed by the agent/team/
--     co-listing policies defined in the "SCOPED RLS POLICIES" section at the
--     END of this file (they depend on tables created later). Fresh installs
--     are scoped from day one; existing databases reach the same state via
--     migrations 0002 + 0011.
-- ─────────────────────────────────────────────────────────────────────────────
alter table agents      enable row level security;
alter table contacts    enable row level security;
alter table properties  enable row level security;
alter table deals       enable row level security;
alter table tasks       enable row level security;
alter table templates   enable row level security;
alter table activities  enable row level security;
alter table documents   enable row level security;
alter table commissions enable row level security;

-- Open access for all authenticated users on intentionally-shared tables.
-- NOTE the `to authenticated` clause on every policy below: omitting it makes
-- the policy apply to PUBLIC, which includes `anon` — and the anon key ships in
-- the browser bundle. See migration 0027, which closed exactly that hole on
-- eight tables. Never write `for all using (true)` without a role here.
do $$ begin
  -- properties: READ stays firm-wide for signed-in agents, but the WRITES are
  -- scoped to the agents on the listing — see PROPERTIES in the RLS section at
  -- the bottom of this file (migration 0055), which is where those policies
  -- live because they call the helper functions defined down there. The legacy
  -- wide-open policies are dropped here and are NOT recreated.
  -- (The public landing pages read properties through the service-key
  -- api/property-public.js, which bypasses RLS — so no anon policy is needed.)
  drop policy if exists allow_all               on properties;
  drop policy if exists allow_all_authenticated on properties;
  -- templates (shared across all agents by design)
  drop policy if exists allow_all on templates;
  if not exists (select 1 from pg_policies where tablename='templates' and policyname='allow_all_authenticated') then
    create policy "allow_all_authenticated" on templates for all to authenticated using (true) with check (true);
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- AGENTS — role-based access (RBAC). See migration 0023.
--
-- The roster stays READABLE by every SIGNED-IN user (pickers, avatars). The
-- public landing/advisor pages read the column-limited `agents_public` view
-- instead — the base table would hand anon every agent's cap_amount,
-- default_split_pct and no_brokerage_split (migration 0027). WRITES are locked:
--   • a user may edit ONLY their own row (auth_id = auth.uid())
--   • an office admin (app_is_admin()) may edit/insert/delete anyone
--   • an unclaimed row (auth_id is null) may be claimed by the matching email
--     — this is the onboarding "claim your seat" flow in App.jsx
-- A BEFORE-UPDATE trigger additionally prevents a non-admin from escalating
-- privilege: is_admin / role / commission fields revert to their old values
-- unless the caller is an admin. Enforcement lives in the database, so it holds
-- regardless of which client (or a hand-crafted API call) issues the write.
-- ─────────────────────────────────────────────────────────────────────────────

-- Helper functions (also created in migrations 0002 and 0055; repeated
-- idempotently here so a fresh install has them before the policies below
-- reference them). See the IDENTITY notes in the RLS section at the bottom for
-- why these resolve by email as well as by auth_id.
create or replace function app_jwt_email()
returns text language plpgsql stable security definer set search_path = public as $$
declare claims text; found text;
begin
  -- PostgREST puts the whole verified token in `request.jwt.claims`.
  claims := current_setting('request.jwt.claims', true);
  if claims is not null and claims <> '' then
    found := lower(nullif(claims::jsonb ->> 'email', ''));
    if found is not null then return found; end if;
  end if;
  -- Older PostgREST (and the repo's own validation shim) set each claim
  -- separately instead. Checked second so the token always wins.
  return lower(nullif(current_setting('request.jwt.claim.email', true), ''));
exception when others then
  return null;
end $$;

-- Every agents row belonging to the caller: the row linked to their login, and
-- any UNLINKED row carrying the same verified email. A row already linked to a
-- different login is that person's, whatever its email column says.
create or replace function app_my_agent_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select a.id from agents a where a.auth_id = auth.uid()
  union
  select a.id from agents a
   where a.auth_id is null
     and app_jwt_email() is not null
     and lower(a.email) = app_jwt_email();
$$;

create or replace function app_current_agent_id()
returns uuid language sql stable security definer set search_path = public as $$
  select a.id from agents a
   where a.auth_id = auth.uid()
      or (a.auth_id is null
          and app_jwt_email() is not null
          and lower(a.email) = app_jwt_email())
   order by (a.auth_id = auth.uid()) desc nulls last, a.created_at
   limit 1;
$$;
-- Office admin: the explicit agents.is_admin flag, plus a legacy role-string
-- fallback for profiles created before that column (migration 0005). The
-- fallback is skipped for the two accounts that own the office-admin toggle —
-- when they switch themselves off, RLS has to narrow with them (migration 0032;
-- the list mirrors src/lib/officeAdmins.js).
create or replace function app_is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(bool_or(
    is_admin
    or (role ilike '%admin%'
        and lower(coalesce(email, '')) not in ('erin@gatewayreadvisors.com', 'daniel@gatewayreadvisors.com'))
  ), false)
  from agents where id in (select app_my_agent_ids());
$$;
grant execute on function app_jwt_email()        to authenticated;
grant execute on function app_my_agent_ids()     to authenticated;
grant execute on function app_current_agent_id() to authenticated;
grant execute on function app_is_admin()         to authenticated;

do $$ begin
  -- Drop the legacy wide-open policy if it exists (older installs).
  drop policy if exists allow_all on agents;

  -- READ: roster is readable by signed-in users. Anonymous visitors go through
  -- the `agents_public` view defined just below.
  drop policy if exists agents_public_read on agents;
  if not exists (select 1 from pg_policies where tablename='agents' and policyname='agents_read_authenticated') then
    create policy "agents_read_authenticated" on agents for select to authenticated using (true);
  end if;

  -- INSERT: onboarding creates your own row; admins can add teammates.
  if not exists (select 1 from pg_policies where tablename='agents' and policyname='agents_insert_self_or_admin') then
    create policy "agents_insert_self_or_admin" on agents for insert to authenticated
      with check (app_is_admin() or auth_id = auth.uid());
  end if;

  -- UPDATE: your own row, an admin, or claiming an unclaimed row that matches
  -- your verified email (onboarding). Column-level escalation is blocked by the
  -- trigger below, not here.
  if not exists (select 1 from pg_policies where tablename='agents' and policyname='agents_update_self_or_admin') then
    create policy "agents_update_self_or_admin" on agents for update to authenticated
      using (
        app_is_admin()
        or auth_id = auth.uid()
        or (auth_id is null and lower(email) = lower(auth.jwt() ->> 'email'))
      )
      with check (
        app_is_admin()
        or auth_id = auth.uid()
      );
  end if;

  -- DELETE: admins only. (The Team UI also hides the control for everyone else.)
  if not exists (select 1 from pg_policies where tablename='agents' and policyname='agents_delete_admin') then
    create policy "agents_delete_admin" on agents for delete to authenticated
      using (app_is_admin());
  end if;
end $$;

-- Privilege guard: a non-admin can never set/change role / is_admin / commission
-- settings — on INSERT (self-onboarding) or UPDATE (editing own row) — so nobody
-- can self-promote to admin. The service-key API (which does its own role checks)
-- and existing admins are trusted and pass through untouched.
--
-- Trusted-caller detection must not depend on the API key FORMAT. Checking only
-- `auth.jwt() ->> 'role'` worked for the legacy service_role JWT but returned
-- null for the newer `sb_secret_…` keys, which made the guard freeze commission
-- splits written by the brokerage's own admin endpoint — a silent no-op UPDATE
-- that still reported success. `current_user` reflects PostgREST's
-- `SET LOCAL ROLE service_role` regardless of key format. (Migration 0027.)
create or replace function agents_guard_privileged()
returns trigger language plpgsql as $$
declare
  is_service boolean;
begin
  is_service :=
       current_user = 'service_role'
    or coalesce(current_setting('role', true), '') = 'service_role'
    or coalesce(auth.jwt() ->> 'role', '') = 'service_role'
    or coalesce(current_setting('request.jwt.claim.role', true), '') = 'service_role'
    or auth.uid() is null and current_user in ('postgres', 'supabase_admin');

  -- Trusted callers: the service role (server API) and existing office admins.
  if is_service or app_is_admin() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    -- A brand-new user claiming their seat cannot mint an admin/privileged row.
    new.is_admin := false;
    if new.role is not null and new.role ilike '%admin%' then new.role := 'Agent'; end if;
    return new;
  end if;
  -- UPDATE by a non-admin (incl. their own row): privileged fields are frozen.
  -- stage_labels is deliberately NOT frozen — renaming your own pipeline column
  -- headers is a display preference, not a permission.
  new.is_admin           := old.is_admin;
  new.role               := old.role;
  new.default_split_pct  := old.default_split_pct;
  new.no_brokerage_split := old.no_brokerage_split;
  new.cap_amount         := old.cap_amount;
  new.cap_anniversary    := old.cap_anniversary;
  return new;
end $$;

drop trigger if exists agents_guard_privileged_trg on agents;
create trigger agents_guard_privileged_trg
  before insert or update on agents
  for each row execute function agents_guard_privileged();

-- ─────────────────────────────────────────────────────────────────────────────
-- AGENTS_PUBLIC — the anonymous roster read (advisor cards on /advisor/:id,
-- /lp/* and /lead). Exactly the ten columns those pages render; everything
-- else on `agents` — cap_amount, default_split_pct, no_brokerage_split,
-- is_admin, auth_id, twilio_sid — stays behind authentication.
-- Deliberately NOT security_invoker: the view runs with the owner's rights so
-- anon can read it while the base table stays authenticated-only.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace view agents_public as
  select id, name, role, tagline, bio, photo_url, color, phone, email, stats
  from agents;
grant select on agents_public to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- TEAMS  (collaboration and split-commission team types)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists teams (
  id          uuid primary key default uuid_generate_v4(),
  name        text not null,
  type        text check (type in ('collaboration','split')) default 'collaboration',
  description text,
  created_at  timestamptz default now()
);

alter table teams enable row level security;
do $$ begin
  -- `to authenticated` is load-bearing: without it the policy applies to
  -- PUBLIC (incl. anon, whose key ships in the bundle). See migration 0027.
  drop policy if exists allow_all on teams;
  if not exists (select 1 from pg_policies where tablename='teams' and policyname='allow_all_authenticated') then
    create policy "allow_all_authenticated" on teams for all to authenticated using (true) with check (true);
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- TEAM SPLITS  (per-member split % for split-type teams)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists team_splits (
  id               uuid primary key default uuid_generate_v4(),
  team_id          uuid references teams(id) on delete cascade,
  agent_id         uuid references agents(id) on delete cascade,
  split_pct        numeric default 0 check (split_pct >= 0 and split_pct <= 100),
  is_lead          boolean default false,
  share_contacts   boolean default true,   -- peer can see this member's contacts
  share_properties boolean default true,   -- peer can see this member's properties
  share_deals      boolean default true,   -- peer can see this member's pipeline deals
  created_at       timestamptz default now(),
  unique(team_id, agent_id)
);

alter table team_splits enable row level security;
do $$ begin
  -- `to authenticated` is load-bearing: without it the policy applies to
  -- PUBLIC (incl. anon, whose key ships in the bundle). See migration 0027.
  drop policy if exists allow_all on team_splits;
  if not exists (select 1 from pg_policies where tablename='team_splits' and policyname='allow_all_authenticated') then
    create policy "allow_all_authenticated" on team_splits for all to authenticated using (true) with check (true);
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- AGENT NOTIFICATIONS
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists agent_notifications (
  id          uuid primary key default uuid_generate_v4(),
  agent_id    uuid references agents(id) on delete cascade,
  deal_id     uuid references deals(id) on delete set null,
  envelope_id text,
  title       text,
  message     text,
  type        text default 'general',
  read        boolean default false,
  created_at  timestamptz default now()
);

alter table agent_notifications enable row level security;
-- (scoped policy — see "SCOPED RLS POLICIES" at the end of this file)

-- ─────────────────────────────────────────────────────────────────────────────
-- BOLDSIGN DOCUMENTS  (e-signature requests tracked per deal)
-- document_id holds the BoldSign document id returned by /v1/document/send.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists boldsign_documents (
  id            uuid primary key default uuid_generate_v4(),
  deal_id       uuid references deals(id) on delete cascade,
  document_ref  uuid references documents(id) on delete set null,
  agent_id      uuid references agents(id) on delete set null,
  document_id   text not null,
  status        text default 'sent',
  subject       text,
  -- Legacy comma-joined roll calls, kept for rows written before per-signer
  -- state existed. Everything reads `signers` first and falls back to these.
  signer_name   text,
  signer_email  text,
  document_name text,
  -- PER-SIGNER STATE, normalized: [{ name, email, role, order, status,
  -- signedAt, viewedAt }] with status in queued|waiting|viewed|signed|declined|
  -- expired|revoked. Seeded at send time from the signer list and then kept
  -- current by the webhook (written on ANY delivery that carries signer
  -- details, monotonically — a retried early event must not overwrite three
  -- signatures with one) and by an explicit status refresh.
  --
  -- This is what makes "waiting on John Doe" possible. The document's own
  -- `status` says whether it is finished; only this says who is holding it up,
  -- which is the fact an agent acts on and the list a reminder is aimed at.
  -- `queued` is derived, not BoldSign's: on a sequential send it means BoldSign
  -- has not emailed that person yet, so they must never be chased.
  -- See src/lib/services/boldsignSigners.js.
  signers           jsonb default '[]',
  sent_at           timestamptz default now(),
  completed_at      timestamptz,
  audit_trail_saved boolean default false,
  -- Where THIS document's completed PDF + audit trail were archived. Recorded
  -- so the UI resolves a row to its own file instead of guessing by filename
  -- (which returned the wrong PDF on any deal with several signed documents),
  -- and so large PDFs are served as signed storage URLs rather than base64
  -- through a serverless function (4.5 MB payload cap).
  signed_storage_path text,
  audit_storage_path  text,
  -- Reminder ledger — nightly auto-reminder sweep + the manual Remind button.
  last_reminded_at  timestamptz,
  reminder_count    integer default 0,
  -- Which form_packets/BoldSign template this document was built from. The key a
  -- saved per-deal field layout hangs on (see deal_field_layouts); null for an
  -- ad-hoc PDF send.
  boldsign_template_id text,

  -- ── Signature packet columns (migration 0046) ──────────────────────────────
  -- The row above already IS the packet; these are the facts the packet module
  -- acts on that a single send never had to record.
  --
  -- How it was composed: 'merged' (one envelope from several templates),
  -- 'split' (one of several envelopes, one per form, same signers), or
  -- 'single' (the ordinary one-template / one-PDF send).
  mode              text,
  -- Every template that went into this envelope, in send order. A superset of
  -- boldsign_template_id, which stays because deal_field_layouts keys on it.
  template_ids      text[],
  -- The files BoldSign holds INSIDE this document, read from
  -- /v1/document/properties: [{ id, name, pageCount }]. This is what makes
  -- "download the disclosures on their own" answerable at all.
  file_ids          jsonb default '[]'::jsonb,
  -- Snapshotted, not joined through properties. An MLS upload is a record of
  -- what was filed; a listing re-keyed under a new MLS number later must not
  -- silently rewrite what an already-filed packet says it was.
  mls_number        text,
  -- The BoldSign document id this packet CORRECTS. A completed envelope is
  -- immutable, so an acknowledgement + initials is a clone — a new envelope
  -- that has to stay attached to the one it corrects. Null on an original.
  correction_of_document_id text,
  -- 'Combined' | 'Individually' — BoldSign's DocumentDownloadOption, fixed at
  -- creation and never changeable afterwards. Decides whether the completed
  -- download is one merged PDF or a zip with one file per form.
  download_option   text,
  -- Everything archived for this packet:
  --   [{ kind: 'signed_pdf'|'audit'|'split_part'|'mls_bundle',
  --      path, pages?, form_name }]
  -- signed_storage_path / audit_storage_path above stay the canonical pointers
  -- the download action resolves; this is the full manifest the MLS packager
  -- picks from, including the per-form split parts those two have no room for.
  local_files       jsonb default '[]'::jsonb,
  -- Non-null while an async BoldSign file edit (Add/Update/Remove) is still
  -- QUEUED. A packet with this set is not safe to send — the file change has
  -- not landed — so the UI shows it pending instead of a success toast.
  edit_pending_since timestamptz,
  -- BoldSign's own status word, for DISPLAY only, never filtered on. `status`
  -- stays the normalized forward-only lifecycle column every other query reads.
  raw_status        text,

  created_at        timestamptz default now()
);
-- Status values written by the app (deliberately NOT a check constraint: an
-- unrecognized future BoldSign status would otherwise hard-fail the webhook,
-- and BoldSign stops retrying after a 200):
--   draft | sent | delivered | completed | declined | expired | voided

alter table boldsign_documents enable row level security;
-- (scoped policy — see "SCOPED RLS POLICIES" at the end of this file)

-- ─────────────────────────────────────────────────────────────────────────────
-- DEAL FIELD LAYOUTS  (per-deal BoldSign field placement, so it stops evaporating)
-- Field placement happens inside BoldSign's embedded editor and lives on the
-- DOCUMENT — so it survived only as long as one draft, and the next packet for
-- the same deal came back with the blank template's defaults. This table holds
-- the arrangement per (deal, template): captured from BoldSign's own document
-- properties when an editing session ends, re-applied to the next draft built
-- for that deal. Deliberately NOT written back to the shared template, which is
-- brokerage-wide and compliance-relevant.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists deal_field_layouts (
  id            uuid primary key default uuid_generate_v4(),
  deal_id       uuid not null references deals(id) on delete cascade,
  -- '' for an ad-hoc (uploaded PDF) send. NOT NULL because the unique key below
  -- is (deal_id, template_id) and Postgres treats every NULL as distinct — a
  -- nullable column would add a row per capture instead of updating one.
  template_id   text not null default '',
  document_name text,
  -- { signers: [{ signerRole, signerName, signerEmail, order, formFields: [...] }],
  --   commonFields: [...], unrestorableIds: [...] } — shape defined by
  --   normalizeCapturedLayout() in api/boldsign.js. JSON because it is read and
  --   written whole.
  -- `unrestorableIds` names the fields a capture could NOT represent (types
  -- outside EDITABLE_FIELD_TYPES — Name, Email, Phone — and fields with no
  -- bounds). The restore needs it to tell "the agent deleted this" apart from
  -- "we lost this"; without it, it deleted both. Rows written before it existed
  -- have no such key and the restore removes nothing from them, which is the
  -- safe reading. No migration: additive within an existing jsonb, and every
  -- row heals on its next capture.
  layout        jsonb not null default '{}'::jsonb,
  field_count   integer not null default 0,
  captured_from text,                                    -- BoldSign document id it was read from
  captured_by   uuid references agents(id) on delete set null,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);
create unique index if not exists idx_deal_field_layouts_key
  on deal_field_layouts(deal_id, template_id);

alter table deal_field_layouts enable row level security;
-- (scoped policy — see "SCOPED RLS POLICIES" at the end of this file)

-- ─────────────────────────────────────────────────────────────────────────────
-- SIGNATURE PACKET EVENTS  (the deal's signing timeline — migration 0046)
--
-- One row per BoldSign webhook delivery worth remembering, plus our own
-- 'Edited' entries for a document changed through the edit API.
--
-- Why not `audit_log`: that records what an AGENT did. Why not
-- `agent_notifications`: that says what an agent should look at, and is deleted
-- when they clear it. Neither records "BoldSign told us Jane viewed it at
-- 14:02" — which is the record a compliance question actually asks for. Why not
-- `activities`: that table's CHECK constrains `type` to the five human activity
-- kinds, and machine events do not belong in the call/note feed.
--
-- Append-only by convention. `dedupe_key` makes a webhook redelivery — which
-- BoldSign performs on any non-2xx, and the completion handler invites by doing
-- two downloads and two uploads — update one row instead of adding a duplicate
-- to the timeline.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists signature_packet_events (
  id          uuid primary key default uuid_generate_v4(),
  deal_id     uuid references deals(id) on delete cascade,
  -- `set null`, not cascade: the event happened even if the (unsigned)
  -- document is later removed, and document_id still identifies it.
  packet_id   uuid references boldsign_documents(id) on delete set null,
  document_id text not null,
  -- BoldSign's event name AS DELIVERED — Sent, Viewed, Signed, Completed,
  -- Declined, Revoked, Expired — stored verbatim, not normalized: a timeline
  -- that rewrites what it was told is not a timeline.
  event       text not null,
  -- The normalized lifecycle status this event implied, when it implied one.
  status      text,
  signer_name  text,
  signer_email text,
  -- When BoldSign says it happened, not when we processed it.
  occurred_at timestamptz,
  dedupe_key  text not null,
  payload     jsonb default '{}'::jsonb,
  created_at  timestamptz default now()
);
create unique index if not exists uq_signature_packet_events_dedupe
  on signature_packet_events(dedupe_key);
create index if not exists idx_signature_packet_events_deal
  on signature_packet_events(deal_id, occurred_at desc);
create index if not exists idx_signature_packet_events_doc
  on signature_packet_events(document_id, occurred_at desc);

alter table signature_packet_events enable row level security;
-- (scoped policy — see "SCOPED RLS POLICIES" at the end of this file)

-- ─────────────────────────────────────────────────────────────────────────────
-- DEAL TEMPLATE DRAFTS  (saved work-in-progress on the prepare-from-template
-- screen — migration 0044)
-- Preparing a packet is where an agent decides what the agreement SAYS: who
-- signs it, which boxes are ticked, the client's name where the deal record
-- needs correcting, the expiry, the copy to the lender. All of it used to live
-- in React state and nowhere else, so closing the modal discarded every one of
-- those decisions with no warning, and reopening the template re-seeded from the
-- deal. One row per (deal, template), holding the screen's own state; shape
-- defined by serializeTemplateWork() in src/lib/services/templateWork.js.
-- Distinct from deal_field_layouts on purpose: that records where fields SIT on
-- a document read back out of BoldSign, this records what the agent ANSWERED on
-- our screen before any document exists.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists deal_template_drafts (
  id            uuid primary key default uuid_generate_v4(),
  deal_id       uuid not null references deals(id) on delete cascade,
  -- '' is never used here in practice (this screen always has a template), but
  -- the column is NOT NULL for the same reason as deal_field_layouts: the unique
  -- key below is (deal_id, template_id) and Postgres treats every NULL as
  -- distinct, which would add a row per save instead of updating the one there.
  template_id   text not null default '',
  template_name text,
  work          jsonb not null default '{}'::jsonb,
  field_count   integer not null default 0,
  -- The BoldSign draft this work last produced. Every save also puts a real,
  -- filled draft on the Signatures tab; this is how the next save supersedes
  -- that one instead of leaving a second half-finished row behind.
  document_id   text,
  saved_by      uuid references agents(id) on delete set null,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);
create unique index if not exists idx_deal_template_drafts_key
  on deal_template_drafts(deal_id, template_id);
create index if not exists idx_deal_template_drafts_document
  on deal_template_drafts(document_id)
  where document_id is not null;

alter table deal_template_drafts enable row level security;
-- (scoped policy — see "SCOPED RLS POLICIES" at the end of this file)

-- ─────────────────────────────────────────────────────────────────────────────
-- BOLDSIGN SENDER IDENTITIES  (one per agent — "send on behalf of" delegation)
-- Each agent is registered in BoldSign so their signature requests come from
-- them. Approval is out-of-band (agent clicks an emailed link); we track status.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists boldsign_sender_identities (
  id          uuid primary key default uuid_generate_v4(),
  agent_id    uuid references agents(id) on delete cascade not null,
  email       text not null,
  name        text,
  status      text default 'pending' check (status in ('pending','approved','declined')),
  is_default  boolean default false,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);
create unique index if not exists uq_boldsign_identity_agent on boldsign_sender_identities(agent_id);
create index if not exists idx_boldsign_identity_email on boldsign_sender_identities(email);
-- Only one org-wide default sender identity (fallback OnBehalfOf) at a time.
create unique index if not exists uq_boldsign_identity_default
  on boldsign_sender_identities(is_default) where is_default;
alter table boldsign_sender_identities enable row level security;
drop policy if exists boldsign_sender_identities_scope on boldsign_sender_identities;
create policy boldsign_sender_identities_scope on boldsign_sender_identities for all to authenticated
  using      (app_is_admin() or agent_id = app_current_agent_id())
  with check (app_is_admin());

-- ─────────────────────────────────────────────────────────────────────────────
-- MICROSOFT GRAPH (OUTLOOK) INTEGRATION  (migration 0034)
--
-- Per-agent "Connect Outlook" via OAuth 2.0 Authorization Code + PKCE against
-- an Azure App Registration with DELEGATED Graph permissions (User.Read,
-- Mail.Send, Mail.ReadWrite, Mail.ReadBasic, offline_access, Calendars.Read,
-- Calendars.ReadWrite, Contacts.Read). Full scope set is requested up front so
-- calendar/contacts sync can be built later without forcing a reconnect.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists ms_graph_connections (
  id                 uuid primary key default uuid_generate_v4(),
  agent_id           uuid not null unique references agents(id) on delete cascade,
  microsoft_user_id  text not null,
  email              text not null,
  display_name       text,
  -- AES-256-GCM ciphertext (iv || authTag || ciphertext, base64) — see
  -- api/_lib/msGraph.js. Never selected by a client role; service key only.
  access_token_enc   text not null,
  refresh_token_enc  text not null,
  token_expires_at   timestamptz not null,
  scopes             text[] not null default '{}',
  status             text not null default 'connected'
                       check (status in ('connected', 'disconnected', 'error')),
  last_error         text,
  connected_at       timestamptz not null default now(),
  last_synced_at     timestamptz,
  -- Microsoft Graph delta query cursor (migration 0036) — lets the nightly
  -- inbox-sync task (api/_lib/inboxSync.js) ask for only what changed since
  -- the last run instead of re-scanning the whole inbox. Null until first sync.
  mail_delta_link    text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create unique index if not exists uq_ms_graph_connections_ms_user on ms_graph_connections(microsoft_user_id);
create index if not exists idx_ms_graph_connections_agent on ms_graph_connections(agent_id);

alter table ms_graph_connections enable row level security;
-- Deliberately NO policy for `authenticated`/`anon` — deny by default. Every
-- access is server-side via the service key (api/email-send.js, ?action=outlook-*).
-- Even AES-256-GCM ciphertext should never reach the browser.

drop trigger if exists ms_graph_connections_updated_at on ms_graph_connections;
create trigger ms_graph_connections_updated_at
  before update on ms_graph_connections
  for each row execute function set_updated_at();

-- Non-secret connection status, readable by the owning agent (or an admin)
-- directly from the browser. NOT security_invoker — like `agents_public`, the
-- view runs with the owner's privileges, which bypass the base table's
-- policy-less RLS, so the row filter below is load-bearing, not decorative.
create or replace view ms_graph_connection_status as
  select
    agent_id, microsoft_user_id, email, display_name, status,
    scopes, connected_at, last_synced_at, token_expires_at, last_error
  from ms_graph_connections
  where agent_id = app_current_agent_id() or app_is_admin();
grant select on ms_graph_connection_status to authenticated;

-- Short-lived PKCE state, keyed by the OAuth `state` param. Also service-role
-- only: this is where code_verifier lives between the redirect to Microsoft
-- and the callback, and it identifies WHICH agent started the flow (the
-- callback is a bare GET redirect from Microsoft — no Authorization header).
-- One-time use; the callback deletes it immediately.
create table if not exists ms_oauth_states (
  state          text primary key,
  agent_id       uuid not null references agents(id) on delete cascade,
  code_verifier  text not null,
  redirect_uri   text not null,
  return_path    text,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null default (now() + interval '10 minutes')
);
create index if not exists idx_ms_oauth_states_expires on ms_oauth_states(expires_at);
alter table ms_oauth_states enable row level security;

-- The CRM's own record of every email sent through the integration, linked to
-- contacts/deals. A companion `activities` row (type='email') is inserted by
-- the send handler so sent emails also show up in the existing timeline.
create table if not exists email_messages (
  id                 uuid primary key default uuid_generate_v4(),
  agent_id           uuid references agents(id) on delete set null,
  contact_id         uuid references contacts(id) on delete set null,
  deal_id            uuid references deals(id) on delete set null,
  activity_id        uuid references activities(id) on delete set null,
  direction          text not null default 'outbound' check (direction in ('outbound', 'inbound')),
  subject            text,
  body_preview       text,
  body_html          text,
  to_recipients      jsonb not null default '[]',
  cc_recipients      jsonb not null default '[]',
  -- 'received' (migration 0036) = an inbound message matched to a contact by
  -- inbox-sync — never "sent" by this CRM, so reusing 'sent' would mislead.
  status             text not null default 'sent' check (status in ('sent', 'failed', 'draft', 'received')),
  error_message      text,
  graph_message_id   text,
  conversation_id    text,
  -- Mirrored-message columns (migration 0038). An outbound CRM send always came
  -- from the connected mailbox, so it never needed a FROM; a message mirrored
  -- out of the mailbox for the contact Emails panel does.
  from_address       text,
  from_name          text,
  web_link           text,             -- deep link to open the message in Outlook
  has_attachments    boolean not null default false,
  -- 'crm'   — this CRM sent (or attempted) the message; it owns the outcome.
  -- 'graph' — a copy of a message merely OBSERVED in the mailbox, mirrored for
  --           the contact's correspondence history. Keeping the two apart is
  --           what lets the panel show lifetime history without the CRM
  --           claiming credit for mail it had nothing to do with.
  source             text not null default 'crm' check (source in ('crm', 'graph')),
  sent_at            timestamptz default now(),
  created_at         timestamptz default now()
);
create index if not exists idx_email_messages_agent   on email_messages(agent_id, sent_at desc);
create index if not exists idx_email_messages_contact on email_messages(contact_id, sent_at desc);
create index if not exists idx_email_messages_deal    on email_messages(deal_id, sent_at desc);
create unique index if not exists uq_email_messages_graph_id
  on email_messages(graph_message_id) where graph_message_id is not null;

alter table email_messages enable row level security;
-- (scoped policy — see "SCOPED RLS POLICIES" at the end of this file)

-- ─────────────────────────────────────────────────────────────────────────────
-- CONTACT EMAIL SYNC  (migration 0038 — the contact panel's Outlook "Emails"
-- tab). One row per (contact, agent): the history is drawn from THAT agent's
-- mailbox, so two agents corresponding with the same contact have different
-- correspondence, cursors, and refresh clocks.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists contact_email_sync (
  id                uuid primary key default uuid_generate_v4(),
  contact_id        uuid not null references contacts(id) on delete cascade,
  agent_id          uuid not null references agents(id)   on delete cascade,
  -- The address the history was pulled for — editing a contact's email
  -- invalidates the cursor instead of silently paging the old address.
  email             text not null,
  next_link         text,              -- Graph @odata.nextLink for the next OLDER page
  backfill_complete boolean not null default false,
  mode              text,              -- 'search' (both directions) | 'filter' (received-only fallback)
  message_count     integer not null default 0,
  last_synced_at    timestamptz,
  last_error        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index if not exists uq_contact_email_sync_pair
  on contact_email_sync(contact_id, agent_id);

alter table contact_email_sync enable row level security;
-- Deliberately NO policy for `authenticated`/`anon` — deny by default, same as
-- ms_graph_connections. A Graph nextLink encodes the mailbox query and has no
-- business reaching a browser; api/email-send.js (?action=outlook-messages)
-- returns only the sync facts the panel needs, never the cursor.

drop trigger if exists contact_email_sync_updated_at on contact_email_sync;
create trigger contact_email_sync_updated_at
  before update on contact_email_sync
  for each row execute function set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- DEAL CALENDAR EVENTS  (migration 0035 — deal key dates -> agent's Outlook
-- calendar). Ledger of one Graph event id per (deal, agent, date_type), plus a
-- hash of the fields that would change the event so a sync run can skip
-- anything unchanged. Written only by the service key (api/_lib/calendarSync.js,
-- called from api/cron.js's nightly sweep and api/email-send.js's on-demand
-- action=outlook-calendar-sync) — never directly by the client.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists deal_calendar_events (
  id              uuid primary key default uuid_generate_v4(),
  deal_id         uuid not null references deals(id) on delete cascade,
  agent_id        uuid not null references agents(id) on delete cascade,
  date_type       text not null,
  graph_event_id  text not null,
  event_hash      text not null,
  last_synced_at  timestamptz not null default now(),
  created_at      timestamptz not null default now()
);
create unique index if not exists uq_deal_calendar_events_key
  on deal_calendar_events(deal_id, agent_id, date_type);
create index if not exists idx_deal_calendar_events_deal  on deal_calendar_events(deal_id);
create index if not exists idx_deal_calendar_events_agent on deal_calendar_events(agent_id);

alter table deal_calendar_events enable row level security;
-- (scoped policy — see "SCOPED RLS POLICIES" at the end of this file)

-- ─────────────────────────────────────────────────────────────────────────────
-- TASK CALENDAR EVENTS  (migration 0041 — task due dates -> assigned agent's
-- Outlook calendar). The task-side companion to deal_calendar_events above:
-- one Graph event id per (task, agent) — a task has a single due_date, so one
-- row per task, keyed with the agent too so a reassignment can delete the old
-- event off the previous assignee's calendar. Row and event go away when the
-- task is completed, loses its due date, is unassigned or is deleted. Written
-- only by the service key (api/_lib/calendarSync.js, called from api/cron.js's
-- nightly sweep and api/email-send.js's on-demand
-- action=outlook-task-calendar-sync) — never directly by the client.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists task_calendar_events (
  id              uuid primary key default uuid_generate_v4(),
  task_id         uuid not null references tasks(id) on delete cascade,
  agent_id        uuid not null references agents(id) on delete cascade,
  graph_event_id  text not null,
  event_hash      text not null,
  last_synced_at  timestamptz not null default now(),
  created_at      timestamptz not null default now()
);
create unique index if not exists uq_task_calendar_events_key
  on task_calendar_events(task_id, agent_id);
create index if not exists idx_task_calendar_events_task  on task_calendar_events(task_id);
create index if not exists idx_task_calendar_events_agent on task_calendar_events(agent_id);

alter table task_calendar_events enable row level security;
-- (scoped policy — see "SCOPED RLS POLICIES" at the end of this file)

-- ─────────────────────────────────────────────────────────────────────────────
-- MASS EMAIL / DEAL ANNOUNCEMENTS  (migration 0039)
--
-- A one-time bulk send through the agent's OWN connected Microsoft 365 mailbox
-- (ms_graph_connections). Not a drip sequence — that is `sequences` — and not a
-- third-party bulk mail service: every message is a personalised /me/sendMail
-- from the agent, logged into email_messages + activities like any other send.
--
-- WHY A ROW PER RECIPIENT (email_blast_recipients). A blast is N independent
-- Graph calls, and the Graph write paths deliberately do not retry
-- (api/_lib/msGraph.js) because a resent email is worse than a surfaced error.
-- Per-recipient status is therefore the send cursor: a batch that dies halfway
-- leaves 'sent' rows sent and 'pending' rows pending, so resuming continues
-- exactly where it stopped and no contact is mailed twice. It is also the audit
-- trail — who received which announcement about which property, and when.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists email_blasts (
  id               uuid primary key default gen_random_uuid(),
  agent_id         uuid not null references agents(id)     on delete cascade,
  property_id      uuid          references properties(id) on delete set null,
  template_id      uuid          references templates(id)  on delete set null,
  -- The announcement headline ('closed', 'under-contract', …) — its own
  -- vocabulary, not properties.status or deals.stage. Free text (no CHECK) so a
  -- new announcement type needs no migration; the app offers the fixed list in
  -- DEAL_ANNOUNCEMENT_STATUSES (src/lib/dealAnnouncement.js).
  deal_status      text,
  subject          text not null,
  -- The body WITH its {{tokens}} intact: the reproducible source of the send.
  -- The rendered, per-recipient HTML lands on each email_messages row instead.
  body             text not null default '',
  photo_url        text,                       -- hero image (property default or per-send override)
  terms            text,                       -- free-text price/terms note
  custom_message   text,                       -- the agent's free-text block
  -- Detail rows the agent switched OFF for this send — a jsonb array of field
  -- keys from ANNOUNCEMENT_FACT_FIELDS ('price' on an under-contract
  -- announcement being the case it exists for). A property of the SEND, not of
  -- the wording: a blast is delivered in paced, resumable batches and every
  -- batch has to withhold exactly what the first one did, and "did this
  -- announcement publish the contract price?" is answerable only from here.
  hidden_facts     jsonb not null default '[]',
  -- { assetTypes: [...], sides: [...], manual: { added: [], removed: [] } }
  audience         jsonb not null default '{}',
  status           text not null default 'draft'
                     check (status in ('draft','sending','sent','failed','cancelled')),
  recipient_count  integer not null default 0,
  sent_count       integer not null default 0,
  failed_count     integer not null default 0,
  skipped_count    integer not null default 0,
  -- Engagement roll-ups for the per-send report (migration 0048). Recomputed
  -- from the recipient rows, never incremented, so a retried batch cannot
  -- double-count. Opens are directional only — most clients block the pixel.
  opened_count     integer not null default 0,
  replied_count    integer not null default 0,
  unsubscribed_count integer not null default 0,
  -- How many recipients came off a pasted/uploaded list rather than the contact
  -- book, and what that list was called, so the send is recognisable later.
  list_recipient_count integer not null default 0,
  list_source      text,
  last_error       text,
  started_at       timestamptz,
  completed_at     timestamptz,
  created_at       timestamptz default now()
);
create index if not exists idx_email_blasts_agent    on email_blasts(agent_id, created_at desc);
create index if not exists idx_email_blasts_property on email_blasts(property_id, created_at desc);
create index if not exists idx_email_blasts_status   on email_blasts(status) where status in ('draft','sending');

alter table email_blasts enable row level security;
-- (scoped policy — see "SCOPED RLS POLICIES" at the end of this file)

create table if not exists email_blast_recipients (
  id               uuid primary key default gen_random_uuid(),
  blast_id         uuid not null references email_blasts(id) on delete cascade,
  contact_id       uuid          references contacts(id)     on delete set null,
  -- Snapshotted rather than joined: the address this send actually went to,
  -- even if the contact's email is edited (or the contact deleted) later.
  email            text not null,
  first_name       text,
  last_name        text,
  status           text not null default 'pending'
                     check (status in ('pending','sent','failed','skipped')),
  error_message    text,
  skip_reason      text,
  email_message_id uuid references email_messages(id) on delete set null,
  sent_at          timestamptz,
  -- Where this recipient came from (migration 0048). 'contact' — the audience
  -- filter or a hand add. 'list' — an address off a pasted CSV with no contact
  -- record, which mass email can now mail directly. It changes what the CRM can
  -- tell you afterwards: a 'contact' send also lands on somebody's timeline, a
  -- 'list' send exists only on this row.
  source           text not null default 'contact'
                     check (source in ('contact','list')),
  -- Opens. Kept as first/last rather than one column because "did it land?" and
  -- "are they still coming back to it?" are different questions, and a re-open
  -- must not overwrite the answer to the first.
  first_opened_at  timestamptz,
  last_opened_at   timestamptz,
  open_count       integer not null default 0,
  -- Stamped on the row that carried the message, so a send's own report can say
  -- who left and who wrote back.
  unsubscribed_at  timestamptz,
  replied_at       timestamptz,
  reply_subject    text,
  created_at       timestamptz default now()
);
-- The double-send guard: one row per (blast, contact) and per (blast, address),
-- so a retried batch cannot add a second copy of a recipient.
create unique index if not exists uq_blast_recipient_contact
  on email_blast_recipients(blast_id, contact_id) where contact_id is not null;
-- Excludes 'skipped' rows: two contacts sharing one address both get a row (one
-- mailed, one skipped as a duplicate), and the skipped one keeps the real
-- address for the audit trail rather than a mangled unique variant.
create unique index if not exists uq_blast_recipient_email
  on email_blast_recipients(blast_id, lower(email)) where status <> 'skipped';
create index if not exists idx_blast_recipients_blast   on email_blast_recipients(blast_id, status);
create index if not exists idx_blast_recipients_contact on email_blast_recipients(contact_id, sent_at desc);
-- Reply matching (api/_lib/inboxSync.js) looks recipients up by address across
-- recent sends, so the address needs an index of its own.
create index if not exists idx_blast_recipients_email
  on email_blast_recipients(lower(email));

alter table email_blast_recipients enable row level security;
-- (scoped policy — see "SCOPED RLS POLICIES" at the end of this file)

-- Which blast produced a logged message (null for one-off sends). Added here
-- rather than in the email_messages definition above because the FK target is
-- defined in this block.
alter table email_messages add column if not exists blast_id uuid references email_blasts(id) on delete set null;
create index if not exists idx_email_messages_blast on email_messages(blast_id) where blast_id is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- EMAIL SUPPRESSIONS  (migration 0048)
--
-- One row per address that must not be mailed, and the gate every bulk send
-- passes through. Keyed by ADDRESS rather than contact because mass email can
-- now go to a pasted list whose addresses are deliberately not contacts — and
-- because contacts.email_opt_out quietly under-protected even the people it
-- covered: the same human on a second address, or re-imported as a new row,
-- came back mailable. The recipient opted out a mailbox, not a database row.
--
-- Not scoped to an agent or a blast: an opt-out is global. "He unsubscribed
-- from Daniel's list but not mine" is not a distinction a recipient would
-- recognise, and acting on it is how a domain earns a spam reputation.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists email_suppressions (
  id              uuid primary key default gen_random_uuid(),
  email           text not null,
  -- 'unsubscribed' (they clicked the link), 'manual' (asked an agent directly),
  -- 'bounced' (dead address). Free text so a new reason needs no migration.
  reason          text not null default 'unsubscribed',
  -- Provenance, all nullable — a suppression stands on its own without any of it.
  blast_id        uuid references email_blasts(id)           on delete set null,
  recipient_id    uuid references email_blast_recipients(id) on delete set null,
  contact_id      uuid references contacts(id)               on delete set null,
  unsubscribed_at timestamptz not null default now(),
  created_at      timestamptz default now()
);
-- Addresses are stored LOWER-CASED (api/campaigns.js lower-cases before every
-- write, and the CHECK below makes that an invariant rather than a habit), so a
-- plain unique index on the column does two jobs at once: it de-duplicates
-- case-insensitively, AND it is a valid ON CONFLICT target for the upsert the
-- unsubscribe path uses. A unique index on lower(email) would do only the
-- first — Postgres cannot infer a conflict target from a column name when the
-- index is on an expression, so every second click on an opt-out link would
-- have raised "no unique or exclusion constraint matching the ON CONFLICT
-- specification" and shown the recipient an error instead of confirming they
-- were unsubscribed. Same reasoning as mailing_subscribers_unique.
alter table email_suppressions drop constraint if exists email_suppressions_lower_check;
alter table email_suppressions add  constraint email_suppressions_lower_check
  check (email = lower(email));
create unique index if not exists uq_email_suppressions_email
  on email_suppressions(email);
create index if not exists idx_email_suppressions_blast on email_suppressions(blast_id);

alter table email_suppressions enable row level security;
-- Reads are open to any authenticated user: every agent needs to see that an
-- address is off-limits, and the audience UI has to be able to say WHY somebody
-- was skipped. Writes stay with the service key — an agent must not be able to
-- delete somebody's opt-out.
drop policy if exists email_suppressions_read on email_suppressions;
create policy email_suppressions_read on email_suppressions for select to authenticated
  using (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- BOLDSIGN TEMPLATES  (reusable documents with fields; CRM prefills by field id)
-- template_id is the BoldSign template id; field_tokens lists the label/id set
-- the template expects so the app can prefill (e.g. property_address, list_price).
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists boldsign_templates (
  id           uuid primary key default uuid_generate_v4(),
  template_id  text not null,
  name         text not null,
  doc_type     text,                 -- state-agnostic key: listing_agreement, buyer_rep, disclosure
  state        text,                 -- 2-letter code (IA/SD/NE); null = applies to any state
  description  text,
  field_tokens jsonb default '[]',
  active       boolean default true,
  created_by   uuid references agents(id) on delete set null,
  created_at   timestamptz default now()
);
create unique index if not exists uq_boldsign_template_tid on boldsign_templates(template_id);
create index if not exists idx_boldsign_templates_active on boldsign_templates(active) where active;
alter table boldsign_templates enable row level security;
drop policy if exists boldsign_templates_scope on boldsign_templates;
create policy boldsign_templates_scope on boldsign_templates for all to authenticated
  using      (true)
  with check (app_is_admin());

-- ─────────────────────────────────────────────────────────────────────────────
-- TRANSACTION STEPS  (closing checklists per deal)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists transaction_steps (
  id            uuid primary key default uuid_generate_v4(),
  deal_id       uuid references deals(id) on delete cascade,
  title         text not null,
  completed     boolean default false,
  completed_at  timestamptz,
  sort_order    integer default 0,
  doc_action    text    default 'manual',  -- manual | upload | forms | sign | admin
  doc_status    text    default 'pending', -- pending | complete | approved | na
  if_applicable boolean default false,     -- conditional document ("if applicable")
  -- Which BoldSign envelope proves this sign-step (migration 0028). Null on
  -- legacy rows; the closing gate then falls back to distinct-envelope
  -- matching. Before this column the gate compared COUNTS, so three copies of
  -- one disclosure satisfied three separate sign-steps.
  satisfied_by  uuid references boldsign_documents(id) on delete set null,
  created_at    timestamptz default now()
);
create index if not exists idx_txn_steps_satisfied_by
  on transaction_steps(satisfied_by) where satisfied_by is not null;

alter table transaction_steps enable row level security;
-- (scoped policy — see "SCOPED RLS POLICIES" at the end of this file)

-- ─────────────────────────────────────────────────────────────────────────────
-- TRANSACTION MANAGEMENT LAYER (audit log, doc versions, closing packets,
-- nudge ledger). Broker-review columns live directly on deals — added by the
-- alter blocks below for existing installs; fresh installs see them on the
-- deals create above.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists audit_log (
  id          uuid primary key default uuid_generate_v4(),
  table_name  text not null,
  record_id   uuid,
  deal_id     uuid references deals(id) on delete cascade,
  actor_id    uuid references agents(id) on delete set null,
  action      text not null,
  old_values  jsonb,
  new_values  jsonb,
  summary     text,
  created_at  timestamptz default now()
);
create index if not exists idx_audit_log_deal      on audit_log(deal_id, created_at desc);
create index if not exists idx_audit_log_actor     on audit_log(actor_id, created_at desc);
create index if not exists idx_audit_log_table_rec on audit_log(table_name, record_id);
alter table audit_log enable row level security;
-- (scoped policy — see "SCOPED RLS POLICIES" at the end of this file)

create table if not exists document_versions (
  id            uuid primary key default uuid_generate_v4(),
  deal_id       uuid references deals(id) on delete cascade not null,
  document_name text not null,
  storage_path  text not null,
  size          bigint,
  mime_type     text,
  version_num   integer not null default 1,
  pinned_as     text check (pinned_as in ('final','signed','superseded') or pinned_as is null),
  source        text default 'upload' check (source in ('upload','boldsign','signwell','closing_packet','import')),
  uploaded_by   uuid references agents(id) on delete set null,
  note          text,
  created_at    timestamptz default now()
);
create index if not exists idx_docver_deal      on document_versions(deal_id);
create index if not exists idx_docver_deal_name on document_versions(deal_id, document_name, version_num desc);
create index if not exists idx_docver_pinned    on document_versions(deal_id, pinned_as) where pinned_as is not null;
alter table document_versions enable row level security;
-- (scoped policy — see "SCOPED RLS POLICIES" at the end of this file)

create table if not exists closing_packets (
  id           uuid primary key default uuid_generate_v4(),
  deal_id      uuid references deals(id) on delete cascade not null,
  storage_path text not null,
  size         bigint,
  doc_count    integer default 0,
  generated_by uuid references agents(id) on delete set null,
  notes        text,
  created_at   timestamptz default now()
);
create index if not exists idx_closing_packets_deal on closing_packets(deal_id, created_at desc);
alter table closing_packets enable row level security;
-- (scoped policy — see "SCOPED RLS POLICIES" at the end of this file)

create table if not exists agent_nudges (
  id          uuid primary key default uuid_generate_v4(),
  agent_id    uuid references agents(id) on delete cascade not null,
  deal_id     uuid references deals(id) on delete cascade not null,
  nudge_kind  text not null,
  sent_at     timestamptz default now(),
  sent_on     date generated always as ((sent_at at time zone 'UTC')::date) stored
);
create unique index if not exists uq_agent_nudges_per_day
  on agent_nudges(agent_id, deal_id, nudge_kind, sent_on);
create index if not exists idx_agent_nudges_deal on agent_nudges(deal_id, sent_at desc);
alter table agent_nudges enable row level security;
-- (scoped policy — see "SCOPED RLS POLICIES" at the end of this file)

-- ─────────────────────────────────────────────────────────────────────────────
-- MIGRATION  (run this block if upgrading an existing database)
-- ─────────────────────────────────────────────────────────────────────────────
-- alter table agents      add column if not exists auth_id uuid unique;
-- alter table agents      add column if not exists team_id uuid;
-- alter table contacts    add column if not exists owner_address    text;
-- alter table contacts    add column if not exists owner_city       text;
-- alter table contacts    add column if not exists owner_state      text;
-- alter table contacts    add column if not exists owner_zip        text;
-- alter table contacts    add column if not exists birthday         date;
-- alter table contacts    add column if not exists anniversary_date date;
-- alter table contacts    add column if not exists spouse_name      text;
-- alter table contacts    add column if not exists spouse_phone     text;
-- alter table contacts    add column if not exists spouse_notes     text;
-- alter table properties  add column if not exists unit    text;
-- alter table properties  add column if not exists county  text;
-- alter table properties  add column if not exists garage  integer default 0;
-- alter table properties  add column if not exists details jsonb   default '{}';
-- alter table deals       add column if not exists prop_category text;
-- alter table deals       add column if not exists prop_subtype  text;
-- alter table deals       add column if not exists comp_data     jsonb default '{}';
-- alter table teams       add column if not exists type text check (type in ('collaboration','split')) default 'collaboration';
-- alter table teams       add column if not exists description text;
-- -- Fix properties type constraint to include full set
-- alter table properties drop constraint if exists properties_type_check;
-- alter table properties add  constraint properties_type_check
--   check (type in ('residential','rental','multifamily','office','land','retail','industrial','mixed-use','commercial'));
-- -- Fix properties status constraint to include 'leased'
-- alter table properties drop constraint if exists properties_status_check;
-- alter table properties add  constraint properties_status_check
--   check (status in ('active','pending','sold','off-market','leased'));
-- -- Fix contacts source constraint to include 'cold call'
-- alter table contacts drop constraint if exists contacts_source_check;
-- alter table contacts add  constraint contacts_source_check
--   check (source in ('referral','website','open house','social','cold call','other'));
-- -- Team sharing flags: run after deploying Team refactor (2026-05)
-- alter table team_splits add column if not exists share_contacts   boolean default true;
-- alter table team_splits add column if not exists share_properties boolean default true;
-- alter table team_splits add column if not exists share_deals      boolean default true;
-- -- Remove legacy team column from agents (no longer used for membership)
-- alter table agents drop column if exists team_id;
-- -- Buyer/investor search criteria (for buyer matching feature)
-- alter table contacts add column if not exists submarket   text;
-- alter table contacts add column if not exists asset_types text[];
-- alter table contacts add column if not exists size_min    numeric;
-- alter table contacts add column if not exists size_max    numeric;
-- alter table contacts add column if not exists size_unit   text default 'sqft';

-- ─────────────────────────────────────────────────────────────────────────────
-- PERFORMANCE INDEXES
-- Run this migration block to enable production-scale query performance.
-- Each index here targets a specific query pattern used by the app.
-- Expected improvement: 10–100x on filtered queries over large datasets.
-- ─────────────────────────────────────────────────────────────────────────────

-- contacts — primary lookup patterns
create index if not exists idx_contacts_agent        on contacts(assigned_agent_id);
create index if not exists idx_contacts_created      on contacts(created_at desc);
create index if not exists idx_contacts_status       on contacts(status);
create index if not exists idx_contacts_type         on contacts(type);
create index if not exists idx_contacts_agent_status on contacts(assigned_agent_id, status);
-- Full-text search on contact name (used by search inputs)
create index if not exists idx_contacts_name_fts     on contacts using gin(to_tsvector('english', first_name || ' ' || last_name));

-- properties — primary lookup patterns
create index if not exists idx_properties_agent        on properties(assigned_agent_id);
create index if not exists idx_properties_created      on properties(created_at desc);
create index if not exists idx_properties_status       on properties(status);
create index if not exists idx_properties_type         on properties(type);
create index if not exists idx_properties_agent_status on properties(assigned_agent_id, status);
create index if not exists idx_properties_contact      on properties(linked_contact_id);

-- deals — primary lookup patterns
create index if not exists idx_deals_agent    on deals(agent_id);
create index if not exists idx_deals_stage    on deals(stage);
create index if not exists idx_deals_created  on deals(created_at desc);
create index if not exists idx_deals_contact  on deals(contact_id);
create index if not exists idx_deals_property on deals(property_id);
create index if not exists idx_deals_close    on deals(expected_close_date) where stage not in ('closed','lost');
-- co-listing lookups run as array containment (RLS + fetchCoListedDealIds)
create index if not exists idx_deals_co_agents on deals using gin (co_agent_ids);

-- tasks — always queried by agent + completion state
create index if not exists idx_tasks_agent          on tasks(agent_id);
create index if not exists idx_tasks_agent_complete on tasks(agent_id, completed);
create index if not exists idx_tasks_due            on tasks(due_date asc) where completed = false;
create index if not exists idx_tasks_contact        on tasks(contact_id);
create index if not exists idx_tasks_deal           on tasks(deal_id);

-- activities — contact + deal timeline queries
create index if not exists idx_activities_contact on activities(contact_id, created_at desc);
create index if not exists idx_activities_deal    on activities(deal_id, created_at desc);
create index if not exists idx_activities_agent   on activities(agent_id);

-- commissions
-- commissions are keyed uniquely by deal_id (the unique constraint already
-- provides the lookup index); no agent_id/paid columns in the canonical model.
create index if not exists idx_commissions_deal    on commissions(deal_id);

-- agent_notifications — real-time inbox queries
create index if not exists idx_notif_agent_unread on agent_notifications(agent_id, read) where read = false;
create index if not exists idx_notif_created      on agent_notifications(created_at desc);

-- boldsign_documents — deal document queries
create index if not exists idx_boldsign_docs_deal   on boldsign_documents(deal_id);
create index if not exists idx_boldsign_docs_agent  on boldsign_documents(agent_id);
create index if not exists idx_boldsign_docs_status on boldsign_documents(status) where status not in ('completed','voided');
create index if not exists idx_boldsign_docs_docid  on boldsign_documents(document_id);
-- One CRM row per BoldSign document. A duplicate made every server-side
-- `.maybeSingle()` lookup throw — and in the webhook that throw was answered 200,
-- so BoldSign never redelivered and the document stopped updating permanently.
create unique index if not exists uq_boldsign_documents_document_id
  on boldsign_documents(document_id);
-- Nightly reminder sweep + "what's still outstanding" queries: in-flight only,
-- ordered by age.
create index if not exists idx_boldsign_docs_awaiting on boldsign_documents(sent_at)
  where status in ('sent','delivered');
-- Every correction of a packet, without scanning the deal (migration 0046).
create index if not exists idx_boldsign_docs_correction_of
  on boldsign_documents(correction_of_document_id)
  where correction_of_document_id is not null;
-- The "is any async file edit still settling?" sweep (migration 0046).
create index if not exists idx_boldsign_docs_edit_pending
  on boldsign_documents(edit_pending_since)
  where edit_pending_since is not null;

-- transaction_steps — deal checklist queries
create index if not exists idx_txn_steps_deal  on transaction_steps(deal_id, sort_order);

-- templates — agent-scoped queries
create index if not exists idx_templates_agent on templates(agent_id, created_at desc);

-- team_splits — team resolution (hot path on every login)
create index if not exists idx_team_splits_agent on team_splits(agent_id);
create index if not exists idx_team_splits_team  on team_splits(team_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- FULL-TEXT SEARCH FUNCTION
-- Enables server-side contact/property search without fetching all rows.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function search_contacts(search_term text, agent_ids uuid[], result_limit int default 50)
returns setof contacts
language sql stable
as $$
  select * from contacts
  where assigned_agent_id = any(agent_ids)
    and (
      to_tsvector('english', first_name || ' ' || last_name) @@ plainto_tsquery('english', search_term)
      or lower(email)   like '%' || lower(search_term) || '%'
      or lower(phone)   like '%' || lower(search_term) || '%'
      or lower(owner_city) like '%' || lower(search_term) || '%'
    )
  order by created_at desc
  limit result_limit;
$$;

create or replace function search_properties(search_term text, agent_ids uuid[], result_limit int default 50)
returns setof properties
language sql stable
as $$
  select * from properties
  where assigned_agent_id = any(agent_ids)
    and (
      lower(address) like '%' || lower(search_term) || '%'
      -- The suite is part of how an agent looks a listing up, both on its own
      -- ("120") and as they'd say it out loud ("okoboji 120") — migration 0042.
      or lower(coalesce(unit, '')) like '%' || lower(search_term) || '%'
      or lower(coalesce(address, '') || ' ' || coalesce(unit, '')) like '%' || lower(search_term) || '%'
      or lower(city)  like '%' || lower(search_term) || '%'
      or lower(mls_number) like '%' || lower(search_term) || '%'
    )
  order by created_at desc
  limit result_limit;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- UPDATED_AT TRIGGER  (auto-stamp deals.updated_at on every update)
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists deals_updated_at on deals;
create trigger deals_updated_at
  before update on deals
  for each row execute function set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- DASHBOARD STATS VIEW
-- Pre-aggregated stats for the dashboard — single query instead of 6.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace view agent_dashboard_stats as
select
  a.id                                                   as agent_id,
  count(distinct c.id)                                   as total_contacts,
  count(distinct c.id) filter (where c.status = 'active') as active_contacts,
  count(distinct p.id)                                   as total_properties,
  count(distinct d.id) filter (where d.stage not in ('closed','lost')) as open_deals,
  count(distinct d.id) filter (where d.stage = 'closed') as closed_deals,
  coalesce(sum(d.value) filter (where d.stage = 'closed'), 0) as closed_volume,
  count(distinct t.id) filter (where t.completed = false and t.due_date < now()) as overdue_tasks
from agents a
left join contacts    c    on c.assigned_agent_id = a.id
left join properties  p    on p.assigned_agent_id = a.id
left join deals       d    on d.agent_id = a.id
left join tasks       t    on t.agent_id = a.id
group by a.id;

-- Grant read access to authenticated users
grant select on agent_dashboard_stats to authenticated;
grant execute on function search_contacts(text, uuid[], int) to authenticated;
grant execute on function search_properties(text, uuid[], int) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- MAILINGS (v2) — QR-first mailing campaigns & tracking.
--
-- This is the canonical mailing system. The legacy v1 tables
-- (mail_campaigns / mail_sends / mail_suppressions) have been removed — see
-- migrations/0001_drop_mailing_v1.sql to drop them from an existing database.
-- ═════════════════════════════════════════════════════════════════════════════

create table if not exists mailings (
  id                     uuid primary key default uuid_generate_v4(),
  name                   text not null,
  description            text,
  agent_id               uuid references agents(id) on delete set null,
  property_id            uuid references properties(id) on delete set null,
  mailing_type           text check (mailing_type in ('postcard','letter','flyer','door-hanger','other')) default 'postcard',
  status                 text check (status in ('draft','active','sent','archived')) default 'draft',
  qr_token               text not null unique,                -- short slug → /m/{token}
  landing_type           text check (landing_type in ('property','valuation','custom','multifamily','mailing')) default 'property',
  landing_custom_url     text,                                -- only used when landing_type='custom'
  landing_config         jsonb default '{}',                  -- collage/headline/highlights for custom + multifamily + mailing landings
  send_date              date,                                -- when the mailer was/will be dropped
  recipient_count        integer default 0,                   -- denormalized counter
  scan_count             integer default 0,                   -- denormalized cache; truth is mailing_scans (reconciled nightly)
  lead_count             integer default 0,                   -- denormalized cache; truth is mailing_leads
  last_scan_at           timestamptz,                         -- most recent non-bot scan
  created_at             timestamptz default now(),
  updated_at             timestamptz default now()
);

-- Migration for existing installs: add landing_config + multifamily/mailing landing_type
alter table mailings add column if not exists landing_config jsonb default '{}';
do $$ begin
  alter table mailings drop constraint if exists mailings_landing_type_check;
  alter table mailings add constraint mailings_landing_type_check
    check (landing_type in ('property','valuation','custom','multifamily','mailing'));
exception when others then null; end $$;

-- Allow 'multifamily' + 'mailing' as valid lead source_landing values for existing installs
do $$ begin
  alter table mailing_leads drop constraint if exists mailing_leads_source_landing_check;
  alter table mailing_leads add constraint mailing_leads_source_landing_check
    check (source_landing in ('property','valuation','custom','multifamily','mailing'));
exception when others then null; end $$;

create index if not exists mailings_agent_id_idx     on mailings(agent_id);
create index if not exists mailings_status_idx       on mailings(status);
create index if not exists mailings_property_id_idx  on mailings(property_id);
-- NOTE: no separate qr_token index — the UNIQUE constraint above is already
-- backed by one. (migrations/0031 drops the duplicate from existing installs.)

drop trigger if exists mailings_updated_at on mailings;
create trigger mailings_updated_at before update on mailings
  for each row execute function set_updated_at();

alter table mailings enable row level security;
do $$ begin
  -- `to authenticated` is load-bearing: without it the policy applies to
  -- PUBLIC (incl. anon, whose key ships in the bundle). See migration 0027.
  drop policy if exists allow_all on mailings;
  if not exists (select 1 from pg_policies where tablename='mailings' and policyname='allow_all_authenticated') then
    create policy "allow_all_authenticated" on mailings for all to authenticated using (true) with check (true);
  end if;
end $$;

create table if not exists mailing_recipients (
  id                uuid primary key default uuid_generate_v4(),
  mailing_id        uuid not null references mailings(id) on delete cascade,
  contact_id        uuid references contacts(id) on delete set null,
  -- Snapshotted address fields (so CSV imports work + history survives contact edits)
  recipient_name    text,
  address_line1     text,
  address_line2     text,
  city              text,
  state             text,
  zip               text,
  source            text check (source in ('database','csv_import','manual')) default 'database',
  -- Scan tracking
  scan_count        integer default 0,
  first_scanned_at  timestamptz,
  last_scanned_at   timestamptz,
  -- Response tracking
  responded         boolean default false,
  response_type     text check (response_type in ('lead_captured','called','emailed','interested','not_interested','converted')),
  responded_at      timestamptz,
  response_notes    text,
  created_at        timestamptz default now()
);

create index if not exists mailing_recipients_mailing_idx  on mailing_recipients(mailing_id);
create index if not exists mailing_recipients_contact_idx  on mailing_recipients(contact_id);
create index if not exists mailing_recipients_responded_idx on mailing_recipients(mailing_id, responded);

alter table mailing_recipients enable row level security;
do $$ begin
  -- `to authenticated` is load-bearing: without it the policy applies to
  -- PUBLIC (incl. anon, whose key ships in the bundle). See migration 0027.
  drop policy if exists allow_all on mailing_recipients;
  if not exists (select 1 from pg_policies where tablename='mailing_recipients' and policyname='allow_all_authenticated') then
    create policy "allow_all_authenticated" on mailing_recipients for all to authenticated using (true) with check (true);
  end if;
end $$;

-- Every hit on /m/{token} lands here — including bots, link previews and rapid
-- repeats. They are FLAGGED rather than dropped (is_bot / is_duplicate) so the
-- headline counts stay honest without ever destroying an event. See
-- migrations/0031_qr_scan_reliability.sql for the reasoning and the RPCs that
-- read this table.
create table if not exists mailing_scans (
  id            uuid primary key default uuid_generate_v4(),   -- supplied by the API, so a retry/replay is idempotent
  mailing_id    uuid not null references mailings(id) on delete cascade,
  recipient_id  uuid references mailing_recipients(id) on delete set null,
  ip_hash       text,                          -- sha256(ip + daily-salt) — privacy-preserving uniqueness
  visitor_hash  text,                          -- sha256(ip + ua + monthly-salt) — unique-people counting
  visit_id      text,                          -- stitches scan → landing page → captured lead
  user_agent    text,
  referrer      text,
  country       text,                          -- inferred from Vercel headers
  region        text,
  city          text,
  latitude      text,
  longitude     text,
  timezone      text,
  device_type   text,                          -- mobile | tablet | desktop
  os            text,
  browser       text,
  is_bot        boolean default false,         -- crawler / scanner / prefetch — stored, not counted
  bot_reason    text,
  is_duplicate  boolean default false,         -- same visitor within the dedupe window
  source        text default 'qr',             -- qr | crawler | replay
  latency_ms    integer,
  scanned_at    timestamptz default now()
);

create index if not exists mailing_scans_mailing_idx    on mailing_scans(mailing_id, scanned_at desc);
create index if not exists mailing_scans_recipient_idx  on mailing_scans(recipient_id);
-- The dashboard's rolling-window query filters on scanned_at alone.
create index if not exists mailing_scans_scanned_at_idx on mailing_scans(scanned_at desc);
-- The shape every analytics query uses: one campaign's real scans, newest first.
create index if not exists mailing_scans_real_idx       on mailing_scans(mailing_id, scanned_at desc)
  where is_bot = false and is_duplicate = false;
create index if not exists mailing_scans_visit_idx      on mailing_scans(visit_id)   where visit_id is not null;
create index if not exists mailing_scans_visitor_idx    on mailing_scans(mailing_id, visitor_hash) where visitor_hash is not null;

alter table mailing_scans enable row level security;
do $$ begin
  -- `to authenticated` is load-bearing: without it the policy applies to
  -- PUBLIC (incl. anon, whose key ships in the bundle). See migration 0027.
  drop policy if exists allow_all on mailing_scans;
  if not exists (select 1 from pg_policies where tablename='mailing_scans' and policyname='allow_all_authenticated') then
    create policy "allow_all_authenticated" on mailing_scans for all to authenticated using (true) with check (true);
  end if;
end $$;

create table if not exists mailing_leads (
  id                uuid primary key default uuid_generate_v4(),
  mailing_id        uuid references mailings(id) on delete set null,
  recipient_id      uuid references mailing_recipients(id) on delete set null,
  contact_id        uuid references contacts(id) on delete set null,
  name              text,
  email             text,
  phone             text,
  message           text,
  property_address  text,                      -- valuation requests only
  property_type     text,
  source_landing    text check (source_landing in ('property','valuation','custom','multifamily','mailing')),
  ip_hash           text,
  visit_id          text,                      -- ties this lead to the scan that produced it
  scan_id           uuid references mailing_scans(id) on delete set null,
  -- True when the lead came from the gated Offering Memorandum download rather
  -- than a plain contact form. See mailing_om_requests below.
  om_requested      boolean default false,
  created_at        timestamptz default now()
);

-- Migration for existing installs (see migrations/0045)
alter table mailing_leads add column if not exists om_requested boolean default false;

create index if not exists mailing_leads_mailing_idx on mailing_leads(mailing_id);
create index if not exists mailing_leads_contact_idx on mailing_leads(contact_id);
create index if not exists mailing_leads_visit_idx   on mailing_leads(visit_id) where visit_id is not null;

alter table mailing_leads enable row level security;
do $$ begin
  -- `to authenticated` is load-bearing: without it the policy applies to
  -- PUBLIC (incl. anon, whose key ships in the bundle). See migration 0027.
  drop policy if exists allow_all on mailing_leads;
  if not exists (select 1 from pg_policies where tablename='mailing_leads' and policyname='allow_all_authenticated') then
    create policy "allow_all_authenticated" on mailing_leads for all to authenticated using (true) with check (true);
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- MAILING SUBSCRIBERS — the durable, deduped list behind a landing_type='mailing'
-- page. Distinct from mailing_leads (one-off property/valuation captures): this
-- is an opt-in email list an agent grows and can manage (unsubscribe, export).
--   • one row per (mailing, email) — the unique index prevents dupes
--   • status tracks the opt-in lifecycle (subscribed → unsubscribed)
--   • unsubscribe_token powers a one-click, no-login /u/{token} opt-out link
-- Writes only ever happen via the service-key API (api/campaigns.js), which is
-- why RLS can be locked down to authenticated reads.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists mailing_subscribers (
  id                uuid primary key default uuid_generate_v4(),
  mailing_id        uuid not null references mailings(id) on delete cascade,
  contact_id        uuid references contacts(id) on delete set null,
  email             text not null,
  name              text,
  phone             text,
  message           text,                           -- what the subscriber wants / to be contacted about
  status            text check (status in ('subscribed','unsubscribed')) default 'subscribed',
  consent           boolean default true,          -- explicit opt-in captured at signup
  source            text default 'landing',        -- landing | manual | import
  ip_hash           text,                           -- privacy-preserving signup fingerprint
  visit_id          text,                           -- ties this subscriber to the scan that produced them
  scan_id           uuid references mailing_scans(id) on delete set null,
  unsubscribe_token text not null unique default replace(uuid_generate_v4()::text, '-', ''),
  subscribed_at     timestamptz default now(),
  unsubscribed_at   timestamptz,
  created_at        timestamptz default now()
);

-- One address can only be on a given list once. Emails are always stored
-- lower-cased by the API, so a plain composite unique index both dedupes
-- case-insensitively AND is a valid ON CONFLICT target for upserts.
create index if not exists mailing_subscribers_visit_idx on mailing_subscribers(visit_id) where visit_id is not null;
create unique index if not exists mailing_subscribers_unique
  on mailing_subscribers(mailing_id, email);
create index if not exists mailing_subscribers_mailing_idx on mailing_subscribers(mailing_id, status);
create index if not exists mailing_subscribers_token_idx    on mailing_subscribers(unsubscribe_token);

alter table mailing_subscribers enable row level security;
do $$ begin
  -- Reads are for signed-in agents (the Campaigns UI). Public signup/unsubscribe
  -- go through the service-key API, which bypasses RLS — so no anon policy needed.
  if not exists (select 1 from pg_policies where tablename='mailing_subscribers' and policyname='subscribers_authenticated_read') then
    create policy "subscribers_authenticated_read" on mailing_subscribers
      for select to authenticated using (true);
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- MAILING OM REQUESTS — who unlocked a campaign's Offering Memorandum.
--
-- The OM is the most valuable thing on a QR landing page, so it sits behind a
-- gate: a visitor gives name + phone + email and the server hands back a
-- short-lived signed URL for the PDF in the PRIVATE `campaign-oms` bucket
-- (below). One row here per unlock, carrying the details they gave and the scan
-- visit that brought them, so "who is reading my deal" is answerable and
-- attributable to a specific piece of mail.
--
-- Written only by api/campaigns.js (action=om_request) on the service key.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists mailing_om_requests (
  id            uuid primary key default uuid_generate_v4(),
  mailing_id    uuid not null references mailings(id) on delete cascade,
  lead_id       uuid references mailing_leads(id) on delete set null,
  contact_id    uuid references contacts(id) on delete set null,
  -- Snapshot of what they typed into the gate — kept even if the contact is
  -- later merged, renamed or deleted, so the audit trail stays truthful.
  name          text,
  email         text,
  phone         text,
  om_path       text,                       -- object key inside `campaign-oms`
  om_filename   text,
  visit_id      text,                       -- ties the unlock back to a scan
  scan_id       uuid references mailing_scans(id) on delete set null,
  ip_hash       text,
  user_agent    text,
  download_count   integer default 1,       -- bumped when the same person re-unlocks
  created_at       timestamptz default now(),
  last_download_at timestamptz default now()
);

create index if not exists mailing_om_requests_mailing_idx on mailing_om_requests(mailing_id, created_at desc);
create index if not exists mailing_om_requests_contact_idx on mailing_om_requests(contact_id);
create index if not exists mailing_om_requests_visit_idx   on mailing_om_requests(visit_id) where visit_id is not null;
-- Clicking download twice is one person, not two leads. This composite is the
-- ON CONFLICT target the API upserts against.
create unique index if not exists mailing_om_requests_dedupe
  on mailing_om_requests(mailing_id, email) where email is not null;

alter table mailing_om_requests enable row level security;
do $$ begin
  -- Reads are for signed-in agents (the Campaigns UI). The public gate writes
  -- through the service-key API, which bypasses RLS — so no anon policy.
  if not exists (
    select 1 from pg_policies
    where tablename='mailing_om_requests' and policyname='om_requests_authenticated_read'
  ) then
    create policy "om_requests_authenticated_read" on mailing_om_requests
      for select to authenticated using (true);
  end if;
end $$;

-- ─── Campaign Images Storage (run once in Supabase SQL Editor) ───────────────
-- Creates a public bucket for direct browser uploads from the landing page
-- builder. Agents upload photos; the public URL is stored in landing_config.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'campaign-images',
  'campaign-images',
  true,
  10485760,  -- 10 MB per file
  array['image/jpeg','image/png','image/webp','image/gif','image/avif']
)
on conflict (id) do nothing;

-- Authenticated users (agents) can upload
do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename='objects' and schemaname='storage'
    and policyname='campaign-images: authenticated upload'
  ) then
    create policy "campaign-images: authenticated upload"
      on storage.objects for insert to authenticated
      with check (bucket_id = 'campaign-images');
  end if;
end $$;

-- Public can read (needed for landing pages served to anonymous visitors)
do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename='objects' and schemaname='storage'
    and policyname='campaign-images: public read'
  ) then
    create policy "campaign-images: public read"
      on storage.objects for select to public
      using (bucket_id = 'campaign-images');
  end if;
end $$;

-- Authenticated users can delete their own uploads
do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename='objects' and schemaname='storage'
    and policyname='campaign-images: authenticated delete'
  ) then
    create policy "campaign-images: authenticated delete"
      on storage.objects for delete to authenticated
      using (bucket_id = 'campaign-images');
  end if;
end $$;

-- ─── Offering Memorandum Storage (PRIVATE — gated downloads) ─────────────────
-- Holds the OM PDFs attached to QR landing pages. `public = false` is
-- load-bearing: an object in here has no working public URL, so the ONLY way to
-- read an OM is a short-lived signed URL that api/campaigns.js mints after the
-- visitor has handed over name + phone + email (action=om_request). Flip this
-- bucket public and the gate becomes decorative — one shared link bypasses it
-- forever.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'campaign-oms',
  'campaign-oms',
  false,
  52428800,  -- 50 MB per file — OMs carry rent rolls and photo pages
  array['application/pdf']
)
on conflict (id) do update
  set public             = false,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Agents upload from the landing-page builder
do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename='objects' and schemaname='storage'
    and policyname='campaign-oms: authenticated upload'
  ) then
    create policy "campaign-oms: authenticated upload"
      on storage.objects for insert to authenticated
      with check (bucket_id = 'campaign-oms');
  end if;
end $$;

-- Signed-in agents can list/preview the attached file. NOTE: no public select
-- policy, on purpose — anonymous reads go through service-key signed URLs.
do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename='objects' and schemaname='storage'
    and policyname='campaign-oms: authenticated read'
  ) then
    create policy "campaign-oms: authenticated read"
      on storage.objects for select to authenticated
      using (bucket_id = 'campaign-oms');
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename='objects' and schemaname='storage'
    and policyname='campaign-oms: authenticated delete'
  ) then
    create policy "campaign-oms: authenticated delete"
      on storage.objects for delete to authenticated
      using (bucket_id = 'campaign-oms');
  end if;
end $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- CONSOLIDATED TABLES (formerly defined ad-hoc in component SQL_SETUP strings)
--
-- These were previously created from "run this SQL" panels inside ColdCalls,
-- Sequences, Integrations, Settings, and Properties. They now live here as the
-- single source of truth. See migrations/0003_consolidate_ghost_tables.sql for
-- applying them to an existing database. All use `if not exists` and are safe
-- to re-run.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─── Cold calling ────────────────────────────────────────────────────────────
create table if not exists cold_call_lists (
  id         uuid primary key default uuid_generate_v4(),
  name       text not null,
  agent_id   uuid references agents(id) on delete set null,
  created_at timestamptz default now()
);

create table if not exists cold_call_leads (
  id               uuid primary key default uuid_generate_v4(),
  list_id          uuid references cold_call_lists(id) on delete cascade,
  property_address text, town text, state text,
  prop_type        text, unit_count int,
  owner_name       text, owner_address text,
  owner_city       text, owner_state text, owner_zip text,
  contact_name     text, age int,
  phones           jsonb default '[]',
  emails           jsonb default '[]',
  remarks          text,
  status           text default 'new',
  call_notes       text, called_at timestamptz, callback_date date,
  call_count       int default 0,
  contact_id       uuid references contacts(id) on delete set null,
  agent_id         uuid references agents(id) on delete set null,
  created_at       timestamptz default now()
);
create index if not exists idx_cold_leads_list   on cold_call_leads(list_id);
create index if not exists idx_cold_leads_status  on cold_call_leads(status);
create index if not exists idx_cold_leads_agent   on cold_call_leads(agent_id);
create index if not exists idx_cold_lists_agent   on cold_call_lists(agent_id);

-- ─── Drip sequences ──────────────────────────────────────────────────────────
create table if not exists sequences (
  id          uuid primary key default uuid_generate_v4(),
  name        text not null,
  description text default '',
  created_at  timestamptz default now()
);

create table if not exists sequence_steps (
  id          uuid primary key default uuid_generate_v4(),
  sequence_id uuid references sequences(id) on delete cascade not null,
  subject     text not null default '',
  body        text not null default '',
  delay_days  int default 0,
  sort_order  int default 0
);
create index if not exists idx_seq_steps_seq on sequence_steps(sequence_id, sort_order);

create table if not exists contact_sequences (
  id           uuid primary key default uuid_generate_v4(),
  contact_id   uuid references contacts(id) on delete cascade not null,
  sequence_id  uuid references sequences(id) on delete cascade not null,
  agent_id     uuid references agents(id) on delete set null,
  started_at   timestamptz default now(),
  current_step int default 0,
  status       text default 'active',
  created_at   timestamptz default now()
);
create index if not exists idx_contact_seq_contact on contact_sequences(contact_id);
create index if not exists idx_contact_seq_status   on contact_sequences(status);

-- ─── Twilio SMS ──────────────────────────────────────────────────────────────
alter table agents add column if not exists twilio_number text;
alter table agents add column if not exists twilio_sid    text;

create table if not exists conversations (
  id                uuid primary key default uuid_generate_v4(),
  contact_id        uuid references contacts(id) on delete set null,
  agent_id          uuid references agents(id)   on delete set null,
  twilio_number     text not null,
  contact_number    text not null,
  contact_name      text,
  last_message_body text,
  last_message_at   timestamptz default now(),
  unread_count      integer default 0,
  created_at        timestamptz default now(),
  unique (twilio_number, contact_number)
);
create index if not exists idx_conversations_agent on conversations(agent_id);

create table if not exists messages (
  id              uuid primary key default uuid_generate_v4(),
  conversation_id uuid references conversations(id) on delete cascade not null,
  direction       text check (direction in ('inbound','outbound')) not null,
  body            text not null,
  status          text default 'sent',
  twilio_sid      text,
  agent_id        uuid references agents(id) on delete set null,
  error_message   text,
  created_at      timestamptz default now()
);
create index if not exists idx_messages_conversation on messages(conversation_id, created_at);

-- ─── Website tracking ────────────────────────────────────────────────────────
create table if not exists visitor_events (
  id               uuid primary key default uuid_generate_v4(),
  session_key      text not null,
  agent_id         uuid references agents(id) on delete set null,
  property_address text,
  property_url     text,
  created_at       timestamptz default now()
);
create index if not exists idx_visitor_events_session on visitor_events(session_key);

create table if not exists lead_captures (
  id                   uuid primary key default uuid_generate_v4(),
  session_key          text,
  agent_id             uuid references agents(id) on delete set null,
  first_name           text not null,
  last_name            text not null,
  email                text not null,
  phone                text,
  property_address     text,
  message              text,
  converted_contact_id uuid references contacts(id) on delete set null,
  created_at           timestamptz default now()
);
create index if not exists idx_lead_captures_agent on lead_captures(agent_id);

-- ─── Property add-ons ────────────────────────────────────────────────────────
create table if not exists property_showings (
  id               uuid primary key default uuid_generate_v4(),
  property_id      uuid references properties(id) on delete cascade,
  agent_id         uuid references agents(id) on delete set null,
  showing_date     timestamptz not null,
  buyer_agent_name text,
  feedback         text,
  rating           int check (rating between 1 and 5),
  created_at       timestamptz default now()
);
create index if not exists idx_showings_property on property_showings(property_id);

create table if not exists listing_checklist_steps (
  id           uuid primary key default uuid_generate_v4(),
  property_id  uuid references properties(id) on delete cascade,
  title        text not null,
  completed    boolean default false,
  completed_at timestamptz,
  sort_order   int default 0,
  created_at   timestamptz default now()
);
create index if not exists idx_listing_checklist_property on listing_checklist_steps(property_id, sort_order);

-- ─── Integrations & automation (reverse-engineered from usage) ───────────────
-- Columns inferred from how the app reads/writes these; verify vs the live DB.
create table if not exists integrations (
  id         uuid primary key default uuid_generate_v4(),
  type       text not null unique,
  config     jsonb default '{}',
  active     boolean default false,
  updated_at timestamptz default now(),
  created_at timestamptz default now()
);

create table if not exists webhook_configs (
  id         uuid primary key default uuid_generate_v4(),
  name       text not null,
  url        text not null,
  events     text[] default '{}',
  active     boolean default false,
  created_at timestamptz default now()
);

create table if not exists email_log (
  id               uuid primary key default uuid_generate_v4(),
  enrollment_id    uuid references contact_sequences(id) on delete set null,
  sequence_id      uuid references sequences(id) on delete set null,
  sequence_step_id uuid references sequence_steps(id) on delete set null,
  contact_id       uuid references contacts(id) on delete set null,
  agent_id         uuid references agents(id) on delete set null,
  to_email         text,
  subject          text,
  status           text check (status in ('sent','failed')),
  provider_id      text,
  error            text,
  created_at       timestamptz default now()
);
create index if not exists idx_email_log_contact  on email_log(contact_id);
create index if not exists idx_email_log_sequence on email_log(sequence_id);

create table if not exists option_values (
  id         uuid primary key default uuid_generate_v4(),
  field_key  text not null,
  value      text not null,
  created_at timestamptz default now(),
  unique (field_key, value)
);
create index if not exists idx_option_values_field on option_values(field_key);

-- TODO: `option_value_counts` is queried as a VIEW by DataManagement.jsx but its
-- cross-table counting logic is field-specific and not knowable from the client
-- code. The app degrades to zeros when it is absent. Define it once the counting
-- rules are confirmed. (See migrations/0003_consolidate_ghost_tables.sql.)

-- ─── RLS for consolidated tables ─────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'cold_call_lists','cold_call_leads','sequences','sequence_steps',
    'contact_sequences','conversations','messages','property_showings',
    'listing_checklist_steps','integrations','webhook_configs','email_log',
    'option_values'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists allow_all on %I', t);
    execute format('create policy allow_all on %I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;

-- visitor_events & lead_captures accept anonymous inserts (landing pages),
-- authenticated read only.
alter table visitor_events enable row level security;
drop policy if exists public_insert on visitor_events;
drop policy if exists auth_read     on visitor_events;
create policy public_insert on visitor_events for insert to anon, authenticated with check (true);
create policy auth_read     on visitor_events for select to authenticated using (true);

alter table lead_captures enable row level security;
drop policy if exists public_insert on lead_captures;
drop policy if exists auth_read     on lead_captures;
create policy public_insert on lead_captures for insert to anon, authenticated with check (true);
create policy auth_read     on lead_captures for select to authenticated using (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- FORM PACKETS (BoldTrail-style document library)
--
-- Form Library is the CRM's document catalog. An entry that carries a
-- boldsign_template_id is "e-sign ready" — sendable from a deal's Signatures
-- tab. BoldSign remains the source of truth for the template's fields/roles;
-- doc_type + field_tokens here are just the CRM-side pointer + prefill map
-- (mirrors the retired boldsign_templates registry, now folded in here).
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists form_packets (
  id                   uuid primary key default uuid_generate_v4(),
  state                text not null,
  transaction_type     text not null check (transaction_type in ('buyer','seller','lease','general')),
  name                 text not null,
  description          text,
  storage_path         text,             -- primary/first source file (back-compat)
  storage_paths        jsonb default '[]', -- all source files in a package (listing agreement + disclosures, …)
  boldsign_template_id text,
  doc_type             text,
  field_tokens         jsonb default '[]',
  active               boolean default true,
  -- When true, a deal in this (state, transaction_type) cannot reach 'closed'
  -- until a COMPLETED boldsign_documents row built from this packet's template
  -- exists on it (migration 0028). This is what makes IA/SD/NE compliance a
  -- property of the system instead of something the coordinator remembers.
  required             boolean not null default false,
  -- The sender decisions this packet asks for before it can be sent —
  -- Representation, Term, agency Policy — as a declarative spec bound to THIS
  -- packet's template (migration 0043). Each option names a BoldSign field id
  -- and an `expect` regex source matched against the caption read off the page,
  -- so a template edit that moves a box is caught instead of locking a wrong
  -- term onto an agreement.
  --
  -- Null means no declared panel. It must stay per-packet: BoldSign auto-names
  -- checkboxes CheckBox1, CheckBox2, … on every template it creates, so those
  -- ids are shared across the whole catalog and a panel applied by anything
  -- broader than one packet writes one form's terms onto another's boxes.
  -- See src/lib/services/boldsignPacketPanel.js.
  signing_panel        jsonb,
  created_at           timestamptz default now()
);
create index if not exists idx_form_packets_required
  on form_packets(state, transaction_type)
  where required and active and boldsign_template_id is not null;
alter table form_packets enable row level security;
-- The catalog of state-required forms is brokerage-wide and compliance-relevant:
-- every agent must READ it to send from it, but only an admin may add, change or
-- remove an entry — or repoint one at a different BoldSign template. It used to
-- be `for all to authenticated using (true) with check (true)`, i.e. any signed-in
-- agent could delete a required form; the UI hid the buttons, the database did not.
drop policy if exists "form_packets_all" on form_packets;
drop policy if exists form_packets_read  on form_packets;
drop policy if exists form_packets_write on form_packets;
create policy form_packets_read on form_packets
  for select to authenticated using (true);
create policy form_packets_write on form_packets
  for all to authenticated using (app_is_admin()) with check (app_is_admin());
create unique index if not exists uq_form_packets_boldsign_tid
  on form_packets(boldsign_template_id) where boldsign_template_id is not null;
-- The send picker reads only active, template-linked rows.
create index if not exists idx_form_packets_sendable
  on form_packets(state, transaction_type) where boldsign_template_id is not null and active;

-- ─────────────────────────────────────────────────────────────────────────────
-- DEADLINE REMINDERS (cron-sent, dedup log)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists deadline_reminders (
  id         uuid primary key default uuid_generate_v4(),
  deal_id    uuid references deals(id) on delete cascade not null,
  date_type  text not null,   -- matches comp_data.key_dates[].type, e.g. 'Closing'
  threshold  text not null,   -- '72h' | '24h' | 'today'
  sent_at    timestamptz default now(),
  unique (deal_id, date_type, threshold)
);
alter table deadline_reminders enable row level security;
-- (scoped policy — see "SCOPED RLS POLICIES" at the end of this file)

-- ═════════════════════════════════════════════════════════════════════════════
-- SCOPED RLS POLICIES  (single source of truth for data visibility)
--
-- Visibility model (decided 2026-06, see migrations/0011; derived from the
-- listing as well as the deal since migration 0055):
--   • An agent sees their OWN records, records of TEAM PEERS who share that
--     dimension (team_splits.share_*), and every deal they are ON — named as
--     an additional agent on the deal, named on the LISTING behind it (as its
--     agent or one of its co-agents), or paid on it as a participant in
--     commissions.participants. Any one of those is enough, at any time.
--   • Everything that hangs off a deal follows the deal: documents (rows and
--     storage objects), signature packets and their events, transaction steps,
--     key dates, deal contacts, field layouts, audit log — and the deal's
--     buyer and seller contacts.
--   • Admins (agents.is_admin — the office admin / transaction coordinator)
--     see everything firm-wide. Tasks stay personal even for admins, and
--     commissions stay admin-only even for co-agents on the same deal.
--   • /api/* serverless functions use the service key and bypass RLS.
--
-- Defined last because the helpers reference team_splits and commissions.
-- Fresh installs get these as the ONLY policies on the scoped tables (secure
-- by default). On an existing database the legacy allow_all policies OR-combine
-- with these until migration 0011 Phase B drops them.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- IDENTITY (migration 0055)
--
-- Every policy below resolves to "which agent rows are mine". That used to be
-- `auth_id = auth.uid()` and nothing else — so an agent whose roster row was
-- never linked to their login resolved to NULL, matched no policy, and saw a
-- blank CRM no matter what any co-agent column said. Identity now also matches
-- the verified email on the request's JWT, and `app_my_agent_ids()` returns
-- EVERY row that is the caller's, so an office with a duplicate roster row
-- (one linked, one not, and a listing pointing at the wrong one) is not a
-- silent blackout either.
-- ─────────────────────────────────────────────────────────────────────────────

-- The verified email on the request's JWT, lowercased. plpgsql with an
-- exception guard because `request.jwt.claims` is absent in a plain psql
-- session and must not raise there.
create or replace function app_jwt_email()
returns text
language plpgsql stable security definer set search_path = public as $$
declare claims text;
begin
  claims := current_setting('request.jwt.claims', true);
  if claims is null or claims = '' then return null; end if;
  return lower(nullif(claims::jsonb ->> 'email', ''));
exception when others then
  return null;
end $$;

-- Every agents row belonging to the caller. Only UNLINKED rows are claimed by
-- email: a row already linked to a different login is that person's row,
-- whatever its email column says.
create or replace function app_my_agent_ids()
returns setof uuid
language sql stable security definer set search_path = public as $$
  select a.id from agents a where a.auth_id = auth.uid()
  union
  select a.id from agents a
   where a.auth_id is null
     and app_jwt_email() is not null
     and lower(a.email) = app_jwt_email();
$$;

-- ONE id, for the places that stamp authorship (activities.agent_id,
-- tasks.agent_id, audit_log.actor_id). The linked row wins.
create or replace function app_current_agent_id()
returns uuid
language sql stable security definer set search_path = public as $$
  select a.id from agents a
   where a.auth_id = auth.uid()
      or (a.auth_id is null
          and app_jwt_email() is not null
          and lower(a.email) = app_jwt_email())
   order by (a.auth_id = auth.uid()) desc nulls last, a.created_at
   limit 1;
$$;

-- Office admin / transaction coordinator: explicit flag, with the legacy
-- role-string fallback for agents created before the column existed — and no
-- fallback for the accounts that own the toggle (migration 0032; see above).
create or replace function app_is_admin()
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(bool_or(
    is_admin
    or (role ilike '%admin%'
        and lower(coalesce(email, '')) not in ('erin@gatewayreadvisors.com', 'daniel@gatewayreadvisors.com'))
  ), false)
  from agents where id in (select app_my_agent_ids());
$$;

-- The set of agent_ids whose data the current user may see for a given
-- dimension: self + team peers who share that dimension. A null share flag is
-- treated as "shared" to match the app's default.
create or replace function app_visible_agent_ids(dimension text)
returns setof uuid
language sql stable security definer set search_path = public as $$
  select id from agents where id in (select app_my_agent_ids())
  union
  select peer.agent_id
  from team_splits me
  join team_splits peer
    on peer.team_id = me.team_id
   and peer.agent_id <> me.agent_id
  where me.agent_id in (select app_my_agent_ids())
    and case dimension
          when 'contacts'   then peer.share_contacts
          when 'properties' then peer.share_properties
          when 'deals'      then peer.share_deals
          else false
        end is not false;
$$;

-- The uuid list inside a `details.co_agent_ids` blob. It is free-form jsonb, so
-- it can hold a non-array value from an older shape, '' from a cleared picker,
-- or a name typed where an id belongs. One forgiving parse, used by the
-- policies AND the triggers, so they cannot disagree about who is on a listing.
create or replace function app_jsonb_uuid_array(j jsonb)
returns uuid[]
language sql immutable set search_path = public as $$
  select coalesce(array_agg(distinct v::uuid), '{}'::uuid[])
    from jsonb_array_elements_text(
           case when jsonb_typeof(j) = 'array' then j else '[]'::jsonb end) t(v)
   where v ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Every deal the current user may see — DERIVED from all five records of
-- membership, never from a copy (migration 0055):
--
--     deals.agent_id                   the deal's own agent (+ sharing peers)
--     deals.co_agent_ids               additional agents on the deal
--     properties.assigned_agent_id     the listing agent
--     properties.details.co_agent_ids  the listing's co-agents
--     commissions.participants         whoever gets paid on it
--
-- The two property arms are the fix for the bug that outlived four migrations:
-- `deals.co_agent_ids` is a COPY taken at conversion time, so an agent added
-- to a listing AFTER its deal was started never reached it. The UI read the
-- listing as a fallback and showed them on the team; RLS read only the copy
-- and hid the deal, its documents, its storage objects and its whole history
-- from them. Deriving from the listing means adding an agent to it — before
-- the deal, after the deal, a year later — is all it takes.
--
-- Every `deal_id in (select app_visible_deal_ids())` policy in this file, and
-- the storage policies from migration 0053, inherit this definition.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function app_visible_deal_ids()
returns setof uuid
language sql stable security definer set search_path = public as $$
  select d.id from deals d where app_is_admin()
  union
  select d.id from deals d
  where d.agent_id in (select app_visible_agent_ids('deals'))
  union
  -- additional agents recorded on the deal
  select d.id from deals d
  where coalesce(d.co_agent_ids, '{}') && array(select m from app_my_agent_ids() m)
  union
  -- the listing agent of the property this deal is on
  select d.id from deals d
  join properties p on p.id = d.property_id
  where p.assigned_agent_id in (select app_my_agent_ids())
  union
  -- co-agents named on the listing, whenever they were added
  select d.id from deals d
  join properties p on p.id = d.property_id
  where app_jsonb_uuid_array(p.details -> 'co_agent_ids') && array(select m from app_my_agent_ids() m)
  union
  -- co-listed via structured commission participants
  select c.deal_id
  from commissions c
  cross join lateral jsonb_array_elements(coalesce(c.participants, '[]'::jsonb)) p
  where (p->>'agent_id') is not null
    and (p->>'agent_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    and (p->>'agent_id')::uuid in (select app_my_agent_ids());
$$;

-- Properties the current user may see. RLS keeps `properties` readable
-- firm-wide (the pickers and the duplicate-deal check in migration 0054 need
-- that), so this is for the CLIENT: every property fetch filters through it.
-- Those client filters are where a co-agent's listing used to vanish while the
-- deal behind it stayed visible — one definition, called by both sides, can't
-- drift apart.
create or replace function app_visible_property_ids()
returns setof uuid
language sql stable security definer set search_path = public as $$
  select p.id from properties p where app_is_admin()
  union
  select p.id from properties p
  where p.assigned_agent_id in (select app_visible_agent_ids('properties'))
  union
  select p.id from properties p
  where app_jsonb_uuid_array(p.details -> 'co_agent_ids') && array(select m from app_my_agent_ids() m)
  union
  -- the listing behind any deal the caller is on
  select d.property_id from deals d
  where d.property_id is not null
    and d.id in (select app_visible_deal_ids());
$$;

-- Contacts the current user may see: their own book, their sharing team peers'
-- — and the people named on a deal they are on. Seeing a deal without its
-- buyer and seller is not something an agent can work: the client card is
-- blank, the portal has nobody in it and no agreement can be prefilled.
create or replace function app_visible_contact_ids()
returns setof uuid
language sql stable security definer set search_path = public as $$
  select c.id from contacts c where app_is_admin()
  union
  select c.id from contacts c
  where c.assigned_agent_id in (select app_visible_agent_ids('contacts'))
  union
  -- the parties on a visible deal
  select x.cid
  from deals d
  cross join lateral (values (d.contact_id), (d.buyer_contact_id), (d.seller_contact_id)) x(cid)
  where d.id in (select app_visible_deal_ids())
    and x.cid is not null
  union
  -- additional contacts / co-signers linked to a visible deal
  select dc.contact_id from deal_contacts dc
  where dc.deal_id in (select app_visible_deal_ids());
$$;

grant execute on function app_jwt_email()             to authenticated;
grant execute on function app_my_agent_ids()          to authenticated;
grant execute on function app_current_agent_id()      to authenticated;
grant execute on function app_is_admin()              to authenticated;
grant execute on function app_visible_agent_ids(text) to authenticated;
grant execute on function app_jsonb_uuid_array(jsonb) to authenticated;
grant execute on function app_visible_deal_ids()      to authenticated;
grant execute on function app_visible_property_ids()  to authenticated;
grant execute on function app_visible_contact_ids()   to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- PROPERTIES — read firm-wide, write only if you are on the listing.
--
-- This is the guard that lets deal visibility be derived from the listing
-- (migration 0055). Before it, one `allow_all_authenticated` policy covered
-- every command: any signed-in agent could UPDATE any property in the firm, so
-- deriving membership from the listing would have been a self-service grant —
-- write yourself onto a listing, see someone else's deal. Migration 0054's
-- rule still holds: the owner widens the team, never the person wanting in.
--
-- SELECT stays open to every signed-in agent: it always has been, the agent and
-- property pickers rely on it, and so does the duplicate-deal check that keeps
-- two agents from starting two deals on one building. INSERT stays open too —
-- agents add listings. UPDATE/DELETE require being on the listing: its agent, a
-- sharing team peer, one of its co-agents, or an office admin. An unassigned
-- listing stays claimable by anyone.
--
-- UPDATE deliberately has no `with check`: USING decides WHO may write this
-- listing, and everyone who passes it is already on the team, so the row they
-- leave behind — including handing the listing over, or taking themselves off
-- it — is an ordinary office action rather than an escalation.
-- ─────────────────────────────────────────────────────────────────────────────
drop policy if exists allow_all               on properties;
drop policy if exists allow_all_authenticated on properties;
drop policy if exists properties_read         on properties;
drop policy if exists properties_insert       on properties;
drop policy if exists properties_update       on properties;
drop policy if exists properties_delete       on properties;

create policy properties_read on properties for select to authenticated
  using (true);

create policy properties_insert on properties for insert to authenticated
  with check (true);

create policy properties_update on properties for update to authenticated
  using (
    app_is_admin()
    or assigned_agent_id is null
    or assigned_agent_id in (select app_visible_agent_ids('properties'))
    or app_jsonb_uuid_array(details -> 'co_agent_ids') && array(select m from app_my_agent_ids() m)
  )
  with check (true);

create policy properties_delete on properties for delete to authenticated
  using (
    app_is_admin()
    or assigned_agent_id is null
    or assigned_agent_id in (select app_visible_agent_ids('properties'))
    or app_jsonb_uuid_array(details -> 'co_agent_ids') && array(select m from app_my_agent_ids() m)
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- THE CO-AGENT CACHE, KEPT BY THE DATABASE (migration 0055)
--
-- Access no longer depends on `deals.co_agent_ids` being correct, but plenty of
-- other things still read it: the commission seed (normalizeCommission), the
-- BoldSign signer prefill, the deal announcement, /api/portal earnings. If
-- those saw a different team from the one RLS grants, the card would say shared
-- while the database said private — the exact divergence that made the original
-- bug invisible. So the database keeps both lists in step, whatever screen or
-- script did the writing.
--
-- `pg_trigger_depth() > 1` on both sides is the recursion stop: each direction
-- fires only for a write that came from outside, never for the write its
-- counterpart just made.
-- ─────────────────────────────────────────────────────────────────────────────

-- LISTING → ITS DEALS, as an exact diff: adding a co-agent to a listing adds
-- them to its deals, removing them takes them off. An agent added on the DEAL
-- alone is untouched by a listing edit that never mentioned them.
create or replace function app_sync_property_coagents_to_deals()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  old_ids uuid[];
  new_ids uuid[];
  added   uuid[];
  removed uuid[];
begin
  if pg_trigger_depth() > 1 then return new; end if;

  old_ids := case when tg_op = 'UPDATE'
                  then app_jsonb_uuid_array(old.details -> 'co_agent_ids')
                  else '{}'::uuid[] end;
  new_ids := app_jsonb_uuid_array(new.details -> 'co_agent_ids');

  added   := array(select x from unnest(new_ids) x except select y from unnest(old_ids) y);
  removed := array(select x from unnest(old_ids) x except select y from unnest(new_ids) y);
  if added = '{}'::uuid[] and removed = '{}'::uuid[] then return new; end if;

  update deals d
     set co_agent_ids = (
           select coalesce(array_agg(distinct s.x), '{}'::uuid[])
             from (select unnest(coalesce(d.co_agent_ids, '{}')) as x
                   union
                   select unnest(added)) s
            where s.x is not null
              and s.x is distinct from d.agent_id
              and not (s.x = any(removed))
         )
   where d.property_id = new.id;

  return new;
end $$;

drop trigger if exists trg_property_coagents_to_deals on properties;
create trigger trg_property_coagents_to_deals
  after insert or update of details on properties
  for each row execute function app_sync_property_coagents_to_deals();

-- DEAL → ITS LISTING, union only. One property can carry several deals, so a
-- co-agent dropped from one deal must not be stripped off the listing (and off
-- the other deal with it). Removal is an edit to the listing, which the
-- direction above then applies everywhere. A listing's assigned agent is never
-- also one of its own co-agents.
create or replace function app_sync_deal_coagents_to_property()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  cur      uuid[];
  merged   uuid[];
  owner_id uuid;
begin
  if pg_trigger_depth() > 1 then return new; end if;
  if new.property_id is null then return new; end if;
  if coalesce(new.co_agent_ids, '{}') = '{}'::uuid[] then return new; end if;

  select app_jsonb_uuid_array(p.details -> 'co_agent_ids'), p.assigned_agent_id
    into cur, owner_id
    from properties p where p.id = new.property_id;
  if not found then return new; end if;

  merged := array(
    select distinct s.x
      from (select unnest(cur) as x
            union
            select unnest(coalesce(new.co_agent_ids, '{}'))) s
     where s.x is not null
       and s.x is distinct from owner_id
     order by s.x);

  if cur @> merged and cur <@ merged then return new; end if;

  update properties
     set details = coalesce(details, '{}'::jsonb)
                   || jsonb_build_object('co_agent_ids', to_jsonb(merged::text[]))
   where id = new.property_id;

  return new;
end $$;

drop trigger if exists trg_deal_coagents_to_property on deals;
create trigger trg_deal_coagents_to_property
  after insert or update of co_agent_ids, property_id on deals
  for each row execute function app_sync_deal_coagents_to_property();

-- CONTACTS — own + sharing team peers + the people on a deal you are on;
-- admins see all. `with check` keeps the original rule for NEW rows (you may
-- only file a contact under yourself or a sharing peer) and adds the deal arm,
-- so a co-agent can fix the seller's phone number on a deal they are working
-- without being handed the owner's whole book (migration 0055).
drop policy if exists contacts_agent_scope on contacts;
create policy contacts_agent_scope on contacts for all to authenticated
  using      (app_is_admin() or id in (select app_visible_contact_ids()))
  with check (
    app_is_admin()
    or assigned_agent_id in (select app_visible_agent_ids('contacts'))
    or id in (select app_visible_contact_ids())
  );

-- ACTIVITIES — visible through the parent contact OR the parent deal; the
-- author always sees their own entries; admins see all.
drop policy if exists activities_contact_scope on activities;
drop policy if exists activities_scope on activities;
create policy activities_scope on activities for all to authenticated
  using (
    app_is_admin()
    or agent_id = app_current_agent_id()
    or exists (
      select 1 from contacts c
      where c.id = activities.contact_id
        and c.assigned_agent_id in (select app_visible_agent_ids('contacts'))
    )
    or activities.deal_id in (select app_visible_deal_ids())
  )
  with check (
    app_is_admin()
    or agent_id = app_current_agent_id()
    or exists (
      select 1 from contacts c
      where c.id = activities.contact_id
        and c.assigned_agent_id in (select app_visible_agent_ids('contacts'))
    )
    or activities.deal_id in (select app_visible_deal_ids())
  );

-- TASKS — strictly personal, even for admins (a to-do list isn't oversight data).
drop policy if exists tasks_agent_scope on tasks;
create policy tasks_agent_scope on tasks for all to authenticated
  using      (agent_id = app_current_agent_id())
  with check (agent_id = app_current_agent_id());

-- DEALS — own + team-shared + co-listed; admins see all. The with check arm
-- lets an agent create deals owned by themselves / a sharing peer, and lets a
-- co-listed participant edit a deal they can already see.
drop policy if exists deals_agent_scope on deals;
create policy deals_agent_scope on deals for all to authenticated
  using (id in (select app_visible_deal_ids()))
  with check (
    app_is_admin()
    or agent_id in (select app_visible_agent_ids('deals'))
    or id in (select app_visible_deal_ids())
  );

-- COMMISSIONS — back office: ADMIN-ONLY (decided 2026-06-12). Each agent's
-- split/take-home is private even from co-agents on the same deal; agents get
-- their own slice via /api/my-earnings (service key, bypasses RLS).
drop policy if exists commissions_deal_scope on commissions;
drop policy if exists commissions_admin_only on commissions;
create policy commissions_admin_only on commissions for all to authenticated
  using (app_is_admin()) with check (app_is_admin());

-- DOCUMENTS — follow the deal; unattached uploads stay personal.
drop policy if exists documents_deal_scope on documents;
create policy documents_deal_scope on documents for all to authenticated
  using (
    app_is_admin()
    or deal_id in (select app_visible_deal_ids())
    or (deal_id is null and agent_id = app_current_agent_id())
  )
  with check (
    app_is_admin()
    or deal_id in (select app_visible_deal_ids())
    or (deal_id is null and agent_id = app_current_agent_id())
  );

-- BOLDSIGN DOCUMENTS — follow the deal; sender always sees their own.
drop policy if exists boldsign_documents_deal_scope on boldsign_documents;
create policy boldsign_documents_deal_scope on boldsign_documents for all to authenticated
  using (
    app_is_admin()
    or deal_id in (select app_visible_deal_ids())
    or agent_id = app_current_agent_id()
  )
  with check (
    app_is_admin()
    or deal_id in (select app_visible_deal_ids())
    or agent_id = app_current_agent_id()
  );

-- TRANSACTION STEPS — follow the deal.
drop policy if exists transaction_steps_deal_scope on transaction_steps;
create policy transaction_steps_deal_scope on transaction_steps for all to authenticated
  using      (deal_id in (select app_visible_deal_ids()))
  with check (deal_id in (select app_visible_deal_ids()));

-- DEAL CONTACTS — follow the deal (additional contacts / co-signers).
drop policy if exists deal_contacts_deal_scope on deal_contacts;
create policy deal_contacts_deal_scope on deal_contacts for all to authenticated
  using      (deal_id in (select app_visible_deal_ids()))
  with check (deal_id in (select app_visible_deal_ids()));

-- DEADLINE REMINDERS — follow the deal (written by cron via service key).
drop policy if exists deadline_reminders_deal_scope on deadline_reminders;
create policy deadline_reminders_deal_scope on deadline_reminders for all to authenticated
  using      (deal_id in (select app_visible_deal_ids()))
  with check (deal_id in (select app_visible_deal_ids()));

-- AGENT NOTIFICATIONS — strictly personal (written by APIs via service key).
drop policy if exists agent_notifications_own on agent_notifications;
create policy agent_notifications_own on agent_notifications for all to authenticated
  using      (agent_id = app_current_agent_id())
  with check (agent_id = app_current_agent_id());

-- AUDIT LOG — visible if you can see the deal, OR you authored it. Admins see all.
drop policy if exists audit_log_scope on audit_log;
create policy audit_log_scope on audit_log for all to authenticated
  using      (app_is_admin() or deal_id in (select app_visible_deal_ids()) or actor_id = app_current_agent_id())
  with check (app_is_admin() or deal_id in (select app_visible_deal_ids()) or actor_id = app_current_agent_id());

-- DOCUMENT VERSIONS — follow the deal.
-- deal_field_layouts — per-deal BoldSign field placement (deal-scoped child)
drop policy if exists deal_field_layouts_deal_scope on deal_field_layouts;
create policy deal_field_layouts_deal_scope on deal_field_layouts for all to authenticated
  using      (app_is_admin() or deal_id in (select app_visible_deal_ids()))
  with check (app_is_admin() or deal_id in (select app_visible_deal_ids()));

-- signature_packet_events — the deal's signing timeline (deal-scoped child).
-- Written by the webhook through the service key, which bypasses RLS; this
-- policy is only what agents read it back through.
drop policy if exists signature_packet_events_deal_scope on signature_packet_events;
create policy signature_packet_events_deal_scope on signature_packet_events for all to authenticated
  using      (app_is_admin() or deal_id in (select app_visible_deal_ids()))
  with check (app_is_admin() or deal_id in (select app_visible_deal_ids()));

-- deal_template_drafts — saved prepare-screen work (deal-scoped child)
drop policy if exists deal_template_drafts_deal_scope on deal_template_drafts;
create policy deal_template_drafts_deal_scope on deal_template_drafts for all to authenticated
  using      (app_is_admin() or deal_id in (select app_visible_deal_ids()))
  with check (app_is_admin() or deal_id in (select app_visible_deal_ids()));

drop policy if exists document_versions_scope on document_versions;
create policy document_versions_scope on document_versions for all to authenticated
  using      (app_is_admin() or deal_id in (select app_visible_deal_ids()))
  with check (app_is_admin() or deal_id in (select app_visible_deal_ids()));

-- CLOSING PACKETS — follow the deal.
drop policy if exists closing_packets_scope on closing_packets;
create policy closing_packets_scope on closing_packets for all to authenticated
  using      (app_is_admin() or deal_id in (select app_visible_deal_ids()))
  with check (app_is_admin() or deal_id in (select app_visible_deal_ids()));

-- AGENT NUDGES — follow the deal OR the agent (written by cron via service key).
drop policy if exists agent_nudges_scope on agent_nudges;
create policy agent_nudges_scope on agent_nudges for all to authenticated
  using      (app_is_admin() or agent_id = app_current_agent_id() or deal_id in (select app_visible_deal_ids()))
  with check (app_is_admin() or agent_id = app_current_agent_id() or deal_id in (select app_visible_deal_ids()));

-- EMAIL MESSAGES — same visibility shape as ACTIVITIES (own + team-shared
-- contact + visible deal; admins see all), since every send also lands a
-- companion activities row and the two should never diverge on who can see them.
drop policy if exists email_messages_scope on email_messages;
create policy email_messages_scope on email_messages for all to authenticated
  using (
    app_is_admin()
    or agent_id = app_current_agent_id()
    or exists (
      select 1 from contacts c
      where c.id = email_messages.contact_id
        and c.assigned_agent_id in (select app_visible_agent_ids('contacts'))
    )
    or email_messages.deal_id in (select app_visible_deal_ids())
  )
  with check (
    app_is_admin()
    or agent_id = app_current_agent_id()
    or exists (
      select 1 from contacts c
      where c.id = email_messages.contact_id
        and c.assigned_agent_id in (select app_visible_agent_ids('contacts'))
    )
    or email_messages.deal_id in (select app_visible_deal_ids())
  );

-- DEAL CALENDAR EVENTS — follows the deal (writes are service-key only, but
-- scoped consistently with every other deal-child table).
drop policy if exists deal_calendar_events_deal_scope on deal_calendar_events;
create policy deal_calendar_events_deal_scope on deal_calendar_events for all to authenticated
  using      (app_is_admin() or deal_id in (select app_visible_deal_ids()) or agent_id = app_current_agent_id())
  with check (app_is_admin() or deal_id in (select app_visible_deal_ids()) or agent_id = app_current_agent_id());

-- TASK CALENDAR EVENTS — mirrors tasks_agent_scope: strictly personal, admins
-- included (a to-do list isn't oversight data, and neither is which to-dos
-- reached someone's calendar). Writes are service-key only.
drop policy if exists task_calendar_events_agent_scope on task_calendar_events;
create policy task_calendar_events_agent_scope on task_calendar_events for all to authenticated
  using      (agent_id = app_current_agent_id())
  with check (agent_id = app_current_agent_id());


-- ═════════════════════════════════════════════════════════════════════════════
-- MAILING SCAN PIPELINE — functions
--
-- The QR scan path does NOT insert into mailing_scans directly. It calls
-- record_mailing_scan(), which resolves the token, stores the event and bumps
-- the counter in ONE atomic round trip — so concurrent scans cannot lose
-- updates against each other, and the scanner is not made to wait on three
-- sequential network hops.
--
-- Reporting likewise goes through mailing_stats / mailing_analytics /
-- mailing_dashboard rather than pulling raw rows into a serverless function,
-- which used to cap silently at PostgREST's max-rows.
--
-- Introduced by migrations/0031_qr_scan_reliability.sql — see that file for the
-- full rationale, the grants, and the rollback block.
-- ═════════════════════════════════════════════════════════════════════════════

-- SECTION 3 — record_mailing_scan()
--
-- Resolves the token AND records the scan AND bumps the counter in ONE round
-- trip. Replaces: SELECT-then-INSERT-then-UPDATE across three network hops.
--
-- Counter semantics: `mailings.scan_count` counts what an agent means by a
-- scan — a real human, first hit within the dedupe window. Bot and duplicate
-- rows are still stored and are still returned by the analytics RPCs, they just
-- don't inflate the headline number.
--
-- p_record = false resolves the mailing without recording, which is what the
-- social-crawler branch needs (it must render Open Graph tags but must not
-- count as a scan).
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function record_mailing_scan(
  p_token        text,
  p_scan_id      uuid    default null,
  p_visit_id     text    default null,
  p_ip_hash      text    default null,
  p_visitor_hash text    default null,
  p_user_agent   text    default null,
  p_referrer     text    default null,
  p_country      text    default null,
  p_region       text    default null,
  p_city         text    default null,
  p_latitude     text    default null,
  p_longitude    text    default null,
  p_timezone     text    default null,
  p_device_type  text    default null,
  p_os           text    default null,
  p_browser      text    default null,
  p_is_bot       boolean default false,
  p_bot_reason   text    default null,
  p_source       text    default 'qr',
  p_latency_ms   integer default null,
  p_record       boolean default true,
  p_dedupe_secs  integer default 30
)
returns table (
  mailing_id         uuid,
  name               text,
  landing_type       text,
  landing_custom_url text,
  landing_config     jsonb,
  property_id        uuid,
  status             text,
  scan_id            uuid,
  recorded           boolean,
  duplicate          boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  m            record;
  -- gen_random_uuid(), NOT uuid_generate_v4(). This function pins
  -- `set search_path = public` (below), and Supabase installs uuid-ossp into the
  -- `extensions` schema — so uuid_generate_v4() is UNRESOLVABLE from in here even
  -- though it works fine in table defaults, which resolve against the session's
  -- search_path. Name resolution happens before COALESCE short-circuits, so this
  -- failed on EVERY call even though the caller always passes p_scan_id: every
  -- QR scan errored, and every scanner got the retry page. gen_random_uuid() is
  -- core Postgres (pg_catalog), so no search_path can hide it.
  v_scan_id    uuid    := coalesce(p_scan_id, gen_random_uuid());
  v_duplicate  boolean := false;
  v_recorded   boolean := false;
  v_inserted   integer := 0;
begin
  select mg.id, mg.name, mg.landing_type, mg.landing_custom_url,
         mg.landing_config, mg.property_id, mg.status
    into m
    from mailings mg
   where mg.qr_token = p_token
   limit 1;

  -- Unknown token: return zero rows so the caller can 404 without a second trip.
  if not found then
    return;
  end if;

  if p_record then
    -- A repeat hit from the same visitor inside the window is the same physical
    -- scan (iOS preview then open, a double-tap, a refresh). Stored, flagged,
    -- and kept out of the headline count.
    if p_visitor_hash is not null then
      select exists (
        select 1 from mailing_scans s
         where s.mailing_id   = m.id
           and s.visitor_hash = p_visitor_hash
           and s.is_bot       = false
           and s.scanned_at   > now() - make_interval(secs => greatest(p_dedupe_secs, 0))
      ) into v_duplicate;
    end if;

    -- The caller owns the primary key, so a retried request or a client-side
    -- replay of a write that already landed collides here and is absorbed.
    insert into mailing_scans (
      id, mailing_id, ip_hash, visitor_hash, visit_id, user_agent, referrer,
      country, region, city, latitude, longitude, timezone,
      device_type, os, browser, is_bot, bot_reason, is_duplicate,
      source, latency_ms
    ) values (
      v_scan_id, m.id, p_ip_hash, p_visitor_hash, p_visit_id,
      left(coalesce(p_user_agent, ''), 500), left(coalesce(p_referrer, ''), 500),
      p_country, p_region, p_city, p_latitude, p_longitude, p_timezone,
      p_device_type, p_os, p_browser, coalesce(p_is_bot, false), p_bot_reason,
      v_duplicate, coalesce(p_source, 'qr'), p_latency_ms
    )
    on conflict (id) do nothing;

    get diagnostics v_inserted = row_count;
    v_recorded := v_inserted > 0;

    -- Atomic increment off the stored value — never a read-modify-write from
    -- something the application read earlier. Concurrent scans serialize on the
    -- row and every one of them counts.
    if v_recorded and not coalesce(p_is_bot, false) and not v_duplicate then
      update mailings
         set scan_count   = coalesce(scan_count, 0) + 1,
             last_scan_at = now()
       where id = m.id;
    end if;
  end if;

  return query select
    m.id, m.name, m.landing_type, m.landing_custom_url,
    m.landing_config, m.property_id, m.status,
    v_scan_id, v_recorded, v_duplicate;
end $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 4 — link_visit_conversion()
--
-- Called when a landing page captures a lead or a subscriber. Ties the
-- conversion back to the scan that produced it via the visit id, and — because
-- that scan is the only evidence we have with one QR code per campaign — rolls
-- the recipient-side scan columns forward when the converting person can be
-- matched to a known recipient by contact.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function link_visit_conversion(
  p_visit_id   text,
  p_mailing_id uuid,
  p_lead_id    uuid default null,
  p_sub_id     uuid default null,
  p_contact_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_scan_id      uuid;
  v_recipient_id uuid;
  v_scanned_at   timestamptz;
begin
  if p_visit_id is null or p_visit_id = '' then
    return null;
  end if;

  select s.id, s.scanned_at
    into v_scan_id, v_scanned_at
    from mailing_scans s
   where s.visit_id = p_visit_id
     and (p_mailing_id is null or s.mailing_id = p_mailing_id)
   order by s.scanned_at asc
   limit 1;

  if v_scan_id is null then
    return null;
  end if;

  if p_lead_id is not null then
    update mailing_leads set scan_id = v_scan_id where id = p_lead_id;
  end if;
  if p_sub_id is not null then
    update mailing_subscribers set scan_id = v_scan_id where id = p_sub_id;
  end if;

  -- Deterministic recipient attribution: only when the converting contact is
  -- actually on this campaign's recipient list. Never guessed from geography.
  if p_contact_id is not null and p_mailing_id is not null then
    select r.id into v_recipient_id
      from mailing_recipients r
     where r.mailing_id = p_mailing_id
       and r.contact_id = p_contact_id
     limit 1;

    if v_recipient_id is not null then
      update mailing_scans
         set recipient_id = v_recipient_id
       where id = v_scan_id and recipient_id is null;

      update mailing_recipients
         set scan_count       = coalesce(scan_count, 0) + 1,
             first_scanned_at = least(coalesce(first_scanned_at, v_scanned_at), v_scanned_at),
             last_scanned_at  = greatest(coalesce(last_scanned_at, v_scanned_at), v_scanned_at)
       where id = v_recipient_id;

      if p_lead_id is not null then
        update mailing_leads set recipient_id = v_recipient_id
         where id = p_lead_id and recipient_id is null;
      end if;
    end if;
  end if;

  return v_scan_id;
end $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 5 — mailing_stats()
--
-- Per-campaign totals computed in SQL. Replaces the JS tally in `action=list`,
-- which fetched every scan row for every campaign and therefore stopped being
-- correct past PostgREST's row cap.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function mailing_stats(p_ids uuid[])
returns table (
  mailing_id      uuid,
  scans           bigint,
  raw_scans       bigint,
  bot_scans       bigint,
  unique_visitors bigint,
  leads           bigint,
  subscribers     bigint,
  recipients      bigint,
  converted       bigint,
  last_scan_at    timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with ids as (select unnest(p_ids) as id)
  select
    ids.id,
    coalesce(sc.scans, 0),
    coalesce(sc.raw_scans, 0),
    coalesce(sc.bot_scans, 0),
    coalesce(sc.unique_visitors, 0),
    coalesce(ld.leads, 0),
    coalesce(sb.subscribers, 0),
    coalesce(rc.recipients, 0),
    coalesce(ld.converted, 0),
    sc.last_scan_at
  from ids
  left join (
    select s.mailing_id,
           count(*) filter (where not s.is_bot and not s.is_duplicate) as scans,
           count(*)                                                     as raw_scans,
           count(*) filter (where s.is_bot)                             as bot_scans,
           count(distinct s.visitor_hash) filter (
             where not s.is_bot and s.visitor_hash is not null
           )                                                            as unique_visitors,
           max(s.scanned_at) filter (where not s.is_bot)                as last_scan_at
      from mailing_scans s
     where s.mailing_id = any(p_ids)
     group by s.mailing_id
  ) sc on sc.mailing_id = ids.id
  left join (
    select l.mailing_id,
           count(*)                                    as leads,
           count(*) filter (where l.scan_id is not null) as converted
      from mailing_leads l
     where l.mailing_id = any(p_ids)
     group by l.mailing_id
  ) ld on ld.mailing_id = ids.id
  left join (
    select b.mailing_id, count(*) as subscribers
      from mailing_subscribers b
     where b.mailing_id = any(p_ids) and b.status = 'subscribed'
     group by b.mailing_id
  ) sb on sb.mailing_id = ids.id
  left join (
    select r.mailing_id, count(*) as recipients
      from mailing_recipients r
     where r.mailing_id = any(p_ids)
     group by r.mailing_id
  ) rc on rc.mailing_id = ids.id;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 6 — mailing_analytics()
--
-- One campaign's full report as a single jsonb document, computed in SQL.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function mailing_analytics(p_mailing_id uuid, p_days integer default 90)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with bounds as (
    select (now() - make_interval(days => greatest(p_days, 1)))::timestamptz as since
  ),
  scans as (
    select s.* from mailing_scans s, bounds
     where s.mailing_id = p_mailing_id and s.scanned_at >= bounds.since
  ),
  real_scans as (
    select * from scans where not is_bot and not is_duplicate
  ),
  recips as (
    select * from mailing_recipients where mailing_id = p_mailing_id
  ),
  lds as (
    select l.* from mailing_leads l, bounds
     where l.mailing_id = p_mailing_id and l.created_at >= bounds.since
  ),
  days as (
    select generate_series(
      (select since::date from bounds), current_date, interval '1 day'
    )::date as d
  )
  select jsonb_build_object(
    'window_days',          greatest(p_days, 1),
    'recipients_total',     (select count(*) from recips),
    'recipients_scanned',   (select count(*) from recips where coalesce(scan_count, 0) > 0),
    'recipients_responded', (select count(*) from recips where responded),
    'total_scans',          (select count(*) from real_scans),
    'raw_scans',            (select count(*) from scans),
    'bot_scans',            (select count(*) from scans where is_bot),
    'duplicate_scans',      (select count(*) from scans where is_duplicate and not is_bot),
    'unique_scanners',      (select count(distinct visitor_hash) from real_scans where visitor_hash is not null),
    'returning_scanners',   (select count(*) from (
                               select visitor_hash from real_scans
                                where visitor_hash is not null
                                group by visitor_hash having count(*) > 1
                             ) t),
    'total_leads',          (select count(*) from lds),
    'attributed_leads',     (select count(*) from lds where scan_id is not null),
    'first_scan_at',        (select min(scanned_at) from real_scans),
    'last_scan_at',         (select max(scanned_at) from real_scans),
    -- Scans per 100 pieces mailed. With one QR code per campaign we cannot know
    -- WHICH recipients scanned, so this is a response index, not a per-person
    -- rate — the UI must label it as such.
    'response_index',       case when (select count(*) from recips) > 0
                              then round(((select count(*) from real_scans)::numeric
                                          / (select count(*) from recips)) * 100, 1)
                              else null end,
    'conversion_rate',      case when (select count(*) from real_scans) > 0
                              then round(((select count(*) from lds)::numeric
                                          / (select count(*) from real_scans)), 4)
                              else 0 end,
    'response_rate',        case when (select count(*) from recips) > 0
                              then round(((select count(*) from recips where responded)::numeric
                                          / (select count(*) from recips)), 4)
                              else 0 end,
    'timeline',             (select coalesce(jsonb_agg(jsonb_build_object(
                               'date', d, 'count', c, 'unique', u
                             ) order by d), '[]'::jsonb) from (
                               select days.d,
                                      count(r.id)                      as c,
                                      count(distinct r.visitor_hash)   as u
                                 from days
                                 left join real_scans r on r.scanned_at::date = days.d
                                group by days.d
                             ) t),
    'by_hour',              (select coalesce(jsonb_agg(jsonb_build_object(
                               'hour', h, 'count', c) order by h), '[]'::jsonb) from (
                               select extract(hour from scanned_at)::int as h, count(*) as c
                                 from real_scans group by 1
                             ) t),
    'by_device',            (select coalesce(jsonb_object_agg(k, c), '{}'::jsonb) from (
                               select coalesce(device_type, 'unknown') as k, count(*) as c
                                 from real_scans group by 1
                             ) t),
    'by_os',                (select coalesce(jsonb_object_agg(k, c), '{}'::jsonb) from (
                               select coalesce(os, 'unknown') as k, count(*) as c
                                 from real_scans group by 1
                             ) t),
    'by_country',           (select coalesce(jsonb_object_agg(k, c), '{}'::jsonb) from (
                               select coalesce(country, 'unknown') as k, count(*) as c
                                 from real_scans group by 1
                             ) t),
    'by_region',            (select coalesce(jsonb_agg(jsonb_build_object(
                               'region', k, 'city', ct, 'count', c) order by c desc), '[]'::jsonb) from (
                               select coalesce(region, '—') as k, coalesce(city, '—') as ct, count(*) as c
                                 from real_scans group by 1, 2 order by count(*) desc limit 25
                             ) t),
    'by_response',          (select coalesce(jsonb_object_agg(k, c), '{}'::jsonb) from (
                               select response_type as k, count(*) as c
                                 from recips where response_type is not null group by 1
                             ) t)
  );
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 7 — mailing_dashboard()
--
-- Org- or agent-scoped rollup. Scoping is applied inside the query so an agent
-- can never be handed another agent's totals.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function mailing_dashboard(
  p_agent_id uuid    default null,
  p_all      boolean default false,
  p_days     integer default 30
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with bounds as (
    select (now() - make_interval(days => greatest(p_days, 1)))::timestamptz as since
  ),
  scoped as (
    select m.* from mailings m
     where p_all
        or (p_agent_id is not null and (
              m.agent_id = p_agent_id
              or (m.landing_config -> 'agent_ids') @> to_jsonb(p_agent_id::text)
           ))
  ),
  scans as (
    select s.* from mailing_scans s, bounds
     where s.mailing_id in (select id from scoped)
       and s.scanned_at >= bounds.since
       and not s.is_bot and not s.is_duplicate
  ),
  lds as (
    select l.* from mailing_leads l, bounds
     where l.mailing_id in (select id from scoped) and l.created_at >= bounds.since
  ),
  days as (
    select generate_series(
      (select since::date from bounds), current_date, interval '1 day'
    )::date as d
  )
  select jsonb_build_object(
    'window_days',      greatest(p_days, 1),
    'total_mailings',   (select count(*) from scoped),
    'active_mailings',  (select count(*) from scoped where status in ('active', 'sent')),
    'total_recipients', (select coalesce(sum(coalesce(recipient_count, 0)), 0) from scoped),
    'total_scans_30d',  (select count(*) from scans),
    'unique_scanners',  (select count(distinct visitor_hash) from scans where visitor_hash is not null),
    'total_leads_30d',  (select count(*) from lds),
    'attributed_leads', (select count(*) from lds where scan_id is not null),
    'scans_today',      (select count(*) from scans where scanned_at::date = current_date),
    'scans_last_hour',  (select count(*) from scans where scanned_at > now() - interval '1 hour'),
    'trend',            (select coalesce(jsonb_agg(jsonb_build_object(
                           'date', d, 'count', c) order by d), '[]'::jsonb) from (
                           select days.d, count(s.id) as c
                             from days left join scans s on s.scanned_at::date = days.d
                            group by days.d
                         ) t),
    'top_mailings',     (select coalesce(jsonb_agg(jsonb_build_object(
                           'id', id, 'name', name, 'status', status,
                           'agent_id', agent_id, 'scan_count', c,
                           'recipient_count', recipient_count) order by c desc), '[]'::jsonb) from (
                           select sc.id, sc.name, sc.status, sc.agent_id, sc.recipient_count,
                                  count(s.id) as c
                             from scoped sc left join scans s on s.mailing_id = sc.id
                            group by sc.id, sc.name, sc.status, sc.agent_id, sc.recipient_count
                            order by count(s.id) desc limit 5
                         ) t)
  );
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 8 — reconcile_mailing_counters()
--
-- Self-healing safety net, run nightly by /api/cron?task=scan-reconcile. The
-- denormalized counters are a cache; the event tables are the truth. Any drift
-- (a counter bumped for a row that rolled back, a row inserted by a replay after
-- the counter had already been read) is repaired here, so the cards and the
-- drill-down can never disagree for more than a day.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function reconcile_mailing_counters()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fixed integer := 0;
begin
  with truth as (
    select m.id,
           (select count(*) from mailing_scans s
             where s.mailing_id = m.id and not s.is_bot and not s.is_duplicate) as scans,
           (select count(*) from mailing_leads l      where l.mailing_id = m.id) as leads,
           (select count(*) from mailing_recipients r where r.mailing_id = m.id) as recips,
           (select max(s.scanned_at) from mailing_scans s
             where s.mailing_id = m.id and not s.is_bot)                         as last_scan
      from mailings m
  ),
  drifted as (
    select t.* from truth t
      join mailings m on m.id = t.id
     where coalesce(m.scan_count, 0)      is distinct from t.scans
        or coalesce(m.lead_count, 0)      is distinct from t.leads
        or coalesce(m.recipient_count, 0) is distinct from t.recips
        or m.last_scan_at                 is distinct from t.last_scan
  ),
  upd as (
    update mailings m
       set scan_count      = d.scans,
           lead_count      = d.leads,
           recipient_count = d.recips,
           last_scan_at    = d.last_scan
      from drifted d
     where m.id = d.id
     returning m.id
  )
  select count(*) into v_fixed from upd;

  return jsonb_build_object(
    'ok', true,
    'mailings_repaired', v_fixed,
    'ran_at', now()
  );
end $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- WEBSITE LEAD INTAKE  (migration 0037)
--
-- POST /api/webhooks/website-lead is the brokerage website's (Manus) feed into
-- the CRM. Defined here, after the RLS helpers, because its policies call
-- app_is_admin() / app_visible_agent_ids().
--
-- The rotation cursor lives in a table of its own rather than being inferred
-- from lead history. The previous implementation read the most recent
-- `lead_captures` row and took the next agent alphabetically, which (a) handed
-- two simultaneous leads the same agent — the read-modify-write race that cost
-- ~2 of every 3 concurrent QR scans until 0031 — (b) offered no way to park an
-- agent, and (c) moved the rotation whenever an admin deleted test leads.
-- ═════════════════════════════════════════════════════════════════════════════

-- One ring per lane. cursor_agent_id is who took the LAST lead in that lane.
create table if not exists lead_rotations (
  lane             text primary key check (lane in ('residential', 'commercial')),
  cursor_agent_id  uuid references agents(id) on delete set null,
  last_assigned_at timestamptz,
  assigned_count   bigint not null default 0,
  created_at       timestamptz default now()
);

insert into lead_rotations (lane) values ('residential'), ('commercial')
  on conflict (lane) do nothing;

-- Ring membership. `active` is the "in lead rotation" toggle (park an agent for
-- vacation without deleting them); an agent may sit in BOTH rings, which
-- agents.specialty — a single CHECK-constrained value — cannot express.
-- sort_order fixes the order; ties fall back to agent name, so the default of
-- all-zeros reproduces the historical alphabetical rotation exactly.
create table if not exists lead_rotation_members (
  lane       text not null check (lane in ('residential', 'commercial')),
  agent_id   uuid not null references agents(id) on delete cascade,
  active     boolean not null default true,
  sort_order int     not null default 0,
  created_at timestamptz default now(),
  primary key (lane, agent_id)
);
create index if not exists idx_lead_rotation_members_lane
  on lead_rotation_members(lane, active);

-- Seed the rings from agents.specialty, which is what the pre-0037 round-robin
-- used as its pool (a null specialty went to residential there, so it does
-- here). Re-runnable, and a no-op on a fresh install with no agents yet — an
-- agent added later needs a row here, or leads in their lane go unassigned.
insert into lead_rotation_members (lane, agent_id)
select case when a.specialty = 'commercial' then 'commercial' else 'residential' end, a.id
  from agents a
 on conflict (lane, agent_id) do nothing;

-- A NEW AGENT IS OTHERWISE INVISIBLE TO THE ROTATION. Ring membership is
-- explicit, which is the point — but that means hiring an agent and forgetting
-- this table would silently keep them out of the rotation forever, and nobody
-- notices a lead they never got. The trigger enrolls them the way the backfill
-- did, from their specialty.
--
-- INSERT only, on purpose: a later specialty change does NOT move them. Once an
-- admin has curated the rings (an agent parked, or deliberately in both), a
-- profile edit must not silently rewrite that.
create or replace function lead_rotation_autoenroll()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into lead_rotation_members (lane, agent_id)
  values (
    case when new.specialty = 'commercial' then 'commercial' else 'residential' end,
    new.id
  )
  on conflict (lane, agent_id) do nothing;
  return new;
end $$;

drop trigger if exists agents_lead_rotation_autoenroll on agents;
create trigger agents_lead_rotation_autoenroll
  after insert on agents
  for each row execute function lead_rotation_autoenroll();

-- The canonical webhook lead record. Distinct from `lead_captures`, which stays
-- as the legacy landing-page form's flat, anonymously-insertable capture row.
create table if not exists leads (
  id                 uuid primary key default gen_random_uuid(),
  contact_id         uuid references contacts(id) on delete set null,
  name               text not null,
  email              text not null,
  phone              text,
  interest_type      text not null default 'residential'
                       check (interest_type in ('residential', 'commercial', 'both')),
  -- The ring that actually assigned them. For interest_type 'both' this records
  -- which side the balancer picked, so the decision stays auditable.
  lane               text check (lane in ('residential', 'commercial')),
  -- Exactly one accountable owner. A lead assigned to two agents has none.
  assigned_agent_id  uuid references agents(id) on delete set null,
  -- Notified-only courtesy on a 'both' lead: the other lane's next agent.
  secondary_agent_id uuid references agents(id) on delete set null,
  source             text not null default 'website',
  source_detail      text,
  message            text,
  raw_payload        jsonb not null default '{}'::jsonb,
  -- Idempotency: a webhook retry must not create a second lead or burn a second
  -- rotation turn.
  dedupe_key         text,
  status             text not null default 'new'
                       check (status in ('new', 'contacted', 'qualified', 'converted', 'lost')),
  drip_status        text not null default 'pending'
                       check (drip_status in ('pending', 'enrolled', 'skipped')),
  drip_sequence_id   uuid references sequences(id) on delete set null,
  assigned_at        timestamptz,
  created_at         timestamptz default now()
);

create unique index if not exists idx_leads_dedupe_key
  on leads(dedupe_key) where dedupe_key is not null;
create index if not exists idx_leads_agent     on leads(assigned_agent_id, created_at desc);
create index if not exists idx_leads_email     on leads(lower(email));
create index if not exists idx_leads_status    on leads(status);
create index if not exists idx_leads_contact   on leads(contact_id);
create index if not exists idx_leads_secondary on leads(secondary_agent_id)
  where secondary_agent_id is not null;

-- What the visitor looked at before reaching out. property_id is filled in when
-- the posted URL or title resolves to a CRM listing and left null when it does
-- not — an unmatched address is still the most useful line in the agent's email,
-- so it is never dropped.
create table if not exists lead_property_views (
  id          uuid primary key default gen_random_uuid(),
  lead_id     uuid not null references leads(id) on delete cascade,
  property_id uuid references properties(id) on delete set null,
  url         text,
  title       text,
  position    int,
  viewed_at   timestamptz,
  created_at  timestamptz default now(),
  constraint lead_property_views_identifiable check (url is not null or title is not null)
);
create index if not exists idx_lead_property_views_lead     on lead_property_views(lead_id, position);
create index if not exists idx_lead_property_views_property on lead_property_views(property_id)
  where property_id is not null;

-- Drip hand-off. The machinery already exists (sequences / sequence_steps /
-- contact_sequences, run daily by /api/cron?task=sequence) — a new lead only
-- needs enrolling, so ONE sequence per lane is marked as the auto-enroll
-- target. No second scheduler.
alter table sequences add column if not exists auto_enroll_lane text;
alter table sequences drop constraint if exists sequences_auto_enroll_lane_check;
alter table sequences add  constraint sequences_auto_enroll_lane_check
  check (auto_enroll_lane is null or auto_enroll_lane in ('residential', 'commercial'));
create unique index if not exists idx_sequences_auto_enroll_lane
  on sequences(auto_enroll_lane) where auto_enroll_lane is not null;

-- ── Assignment: one atomic round trip ───────────────────────────────────────
-- Returns the agent AND the lane that assigned them, which can differ from the
-- lane asked for: a brokerage that has not staffed commercial must still capture
-- a commercial lead rather than drop it.
--
-- gen_random_uuid() and an explicit search_path: the 0033 outage was a
-- `security definer ... set search_path = public` function calling
-- uuid_generate_v4(), which Supabase installs into the `extensions` schema.
create or replace function assign_lead_round_robin(p_lane text)
returns table (agent_id uuid, lane text)
language plpgsql
security definer
set search_path = public
as $$
-- The OUT parameters are named agent_id and lane so PostgREST returns those
-- keys. That makes a bare `lane` ambiguous between the out-parameter and the
-- lead_rotations column — and an ON CONFLICT target must be a bare column name,
-- so `on conflict (lane)` below fails to parse at RUN TIME with "column
-- reference lane is ambiguous". This pragma resolves bare names to the column;
-- every other reference in the body is explicitly qualified regardless.
#variable_conflict use_column
declare
  v_lane   text;
  v_cursor uuid;
  v_next   uuid;
begin
  if p_lane is null or p_lane not in ('residential', 'commercial') then
    raise exception 'assign_lead_round_robin: unknown lane %', p_lane
      using errcode = '22023';
  end if;

  foreach v_lane in array array[
    p_lane,
    case p_lane when 'residential' then 'commercial' else 'residential' end
  ] loop
    v_next   := null;
    v_cursor := null;

    insert into lead_rotations (lane) values (v_lane) on conflict (lane) do nothing;

    -- THE LOCK THAT MAKES THIS CORRECT. Concurrent deliveries for one lane queue
    -- here, so each reads a cursor that already includes the assignment before
    -- it. Without it they read the same cursor and every lead in a burst goes to
    -- the same agent.
    select r.cursor_agent_id into v_cursor
      from lead_rotations r
     where r.lane = v_lane
       for update;

    with ring as (
      select m.agent_id                                                   as id,
             row_number() over (order by m.sort_order, a.name, m.agent_id) as rn,
             count(*)     over ()                                          as total
        from lead_rotation_members m
        join agents a on a.id = m.agent_id
       where m.lane = v_lane
         and m.active
    )
    select r.id into v_next
      from ring r
     where r.rn = (
       -- Previous assignee's position, wrapped. A null cursor (first lead ever)
       -- and a cursor whose agent has left the ring both resolve to max(rn), so
       -- the next pick is rn 1 — the ring restarts at its head rather than
       -- throwing.
       coalesce(
         (select c.rn from ring c where c.id = v_cursor),
         (select max(c.rn) from ring c)
       ) % (select max(c.total) from ring c)
     ) + 1;

    if v_next is not null then
      update lead_rotations r
         set cursor_agent_id  = v_next,
             last_assigned_at = now(),
             assigned_count   = r.assigned_count + 1
       where r.lane = v_lane;

      return query select v_next, v_lane;
      return;
    end if;
  end loop;

  -- Both rings empty. The caller stores the lead unassigned: an unassigned lead
  -- an admin can claim beats a 500 and a lost inquiry.
  return;
end $$;

-- Which ring takes an "either specialty" lead: whichever has handed out fewer,
-- so 'both' traffic does not starve one side.
create or replace function lead_lane_for_both()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select r.lane
    from lead_rotations r
   where exists (
     select 1 from lead_rotation_members m
      where m.lane = r.lane and m.active
   )
   order by r.assigned_count asc, r.lane asc
   limit 1;
$$;

-- Service role only. These advance shared state and bypass RLS by design; an
-- authenticated agent must not be able to spin the rotation onto themselves.
revoke all on function assign_lead_round_robin(text) from public;
revoke all on function lead_lane_for_both()          from public;
grant execute on function assign_lead_round_robin(text) to service_role;
grant execute on function lead_lane_for_both()          to service_role;

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Every write comes from the webhook on the SERVICE key, which bypasses RLS. So
-- unlike `lead_captures` — which carries `public_insert ... to anon` because the
-- landing-page form posts with the anon key that ships in the browser bundle —
-- these tables get NO anon policy at all. Nothing in the browser can write a
-- lead, forge an assignment, or read another agent's pipeline.
alter table leads                 enable row level security;
alter table lead_property_views   enable row level security;
alter table lead_rotations        enable row level security;
alter table lead_rotation_members enable row level security;

-- LEADS — read-only to agents, and only their own: the owner, the notified
-- secondary on a 'both' lead, sharing team peers (the `contacts` dimension,
-- since a lead becomes a contact), and admins. Deliberately SELECT-only: an
-- agent who could UPDATE could reassign a peer's lead to themselves, and one who
-- could DELETE could erase the evidence.
drop policy if exists leads_read_scope on leads;
create policy leads_read_scope on leads for select to authenticated
  using (
    app_is_admin()
    or assigned_agent_id  in (select app_visible_agent_ids('contacts'))
    or secondary_agent_id = app_current_agent_id()
  );

-- Correcting an assignment (an agent quit, a lead landed in the wrong lane) is
-- an admin action.
drop policy if exists leads_admin_write on leads;
create policy leads_admin_write on leads for update to authenticated
  using (app_is_admin()) with check (app_is_admin());

drop policy if exists leads_admin_delete on leads;
create policy leads_admin_delete on leads for delete to authenticated
  using (app_is_admin());

-- Viewed properties: the parent lead's rule, restated rather than relying on
-- nested RLS — the same shape as activities_scope above.
drop policy if exists lead_property_views_scope on lead_property_views;
create policy lead_property_views_scope on lead_property_views for select to authenticated
  using (exists (
    select 1 from leads l
     where l.id = lead_property_views.lead_id
       and (
         app_is_admin()
         or l.assigned_agent_id  in (select app_visible_agent_ids('contacts'))
         or l.secondary_agent_id = app_current_agent_id()
       )
  ));

-- The rings are readable by any authenticated agent — whose turn is next is not
-- a secret, and hiding it is how a rotation loses trust — and writable by admins
-- only. An agent who could UPDATE lead_rotations could point the cursor at the
-- person before them and take every lead.
drop policy if exists lead_rotations_read on lead_rotations;
create policy lead_rotations_read on lead_rotations for select to authenticated
  using (true);

drop policy if exists lead_rotations_admin_write on lead_rotations;
create policy lead_rotations_admin_write on lead_rotations for all to authenticated
  using (app_is_admin()) with check (app_is_admin());

drop policy if exists lead_rotation_members_read on lead_rotation_members;
create policy lead_rotation_members_read on lead_rotation_members for select to authenticated
  using (true);

drop policy if exists lead_rotation_members_admin_write on lead_rotation_members;
create policy lead_rotation_members_admin_write on lead_rotation_members for all to authenticated
  using (app_is_admin()) with check (app_is_admin());

-- MASS EMAIL — a blast is the sending agent's own record, visible to sharing
-- team peers and admins under the same model as the rest of the CRM. Writes
-- belong to the service key (api/email-send.js): an agent must not be able to
-- hand-edit sent_count or repoint a recipient row after the fact.
drop policy if exists email_blasts_scope on email_blasts;
create policy email_blasts_scope on email_blasts for select to authenticated
  using (
    app_is_admin()
    or agent_id = app_current_agent_id()
    or agent_id in (select app_visible_agent_ids('contacts'))
  );

-- Recipients follow the parent blast, restated rather than relying on nested
-- RLS — the same shape as activities_scope above.
drop policy if exists email_blast_recipients_scope on email_blast_recipients;
create policy email_blast_recipients_scope on email_blast_recipients for select to authenticated
  using (exists (
    select 1 from email_blasts b
     where b.id = email_blast_recipients.blast_id
       and (
         app_is_admin()
         or b.agent_id = app_current_agent_id()
         or b.agent_id in (select app_visible_agent_ids('contacts'))
       )
  ));

-- ═════════════════════════════════════════════════════════════════════════════
-- DEAL FILE STORAGE  (migration 0049)
--
-- These live at the very END of this file on purpose: they are policies on
-- `storage.objects`, and their bodies call `app_visible_deal_ids()`, which is
-- not defined until the SCOPED RLS POLICIES section above. Postgres resolves
-- function names when a policy is CREATED, so moving this block up next to the
-- campaign buckets breaks a fresh install.
--
-- WHY THIS SECTION EXISTS AT ALL. The deal Documents tab does not read the
-- `documents` or `document_versions` tables — it lists storage directly:
--
--     supabase.storage.from('deal-documents').list(`deal-${deal.id}`)
--     — src/pages/Pipeline.jsx (DocumentsTab), src/pages/DealPage.jsx
--
-- so `storage.objects` row policies, not the scoped tables above, decide what
-- an agent sees on that tab. For a long time those policies were not in this
-- repository: the bucket was made by hand in the Supabase dashboard, whose
-- default template is `owner = auth.uid()`. Under that rule an uploader saw
-- their own files and nobody else did — a co-agent opening the same deal got
-- "No documents yet", because a denied row makes storage FILTER, not error.
--
-- The rule below is the one every other deal child already uses:
-- `app_visible_deal_ids()`. Assigned agent, co-agents, sharing team peers and
-- office admins all resolve to the same set, so they all see the same files.
--
-- The object→deal link is the path. Every writer agrees on `deal-<uuid>/…`
-- (Pipeline.jsx, src/lib/services/documents.js, api/boldsign.js,
-- api/_handlers/closing-packet.js); `app_storage_deal_id()` reads it back out
-- and returns NULL for anything else, so an unattributable object is
-- admin-only. `service_role` bypasses RLS entirely, so the BoldSign archive
-- webhook and the client portal's signed URLs are untouched.
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function app_storage_deal_id(object_name text)
returns uuid
language sql
immutable
set search_path = public
as $$
  select nullif(substring(
    object_name from
    '^deal-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/'
  ), '')::uuid
$$;

grant execute on function app_storage_deal_id(text) to authenticated;

-- All three buckets are PRIVATE. `deal-documents` holds executed contracts and
-- the compliance audit trails BoldSign archives; public would make every one of
-- them readable by URL with no session at all. `do update set public = false`
-- rather than `do nothing` so a re-run also CLOSES a bucket someone flipped
-- open in the dashboard.
insert into storage.buckets (id, name, public, file_size_limit)
values ('deal-documents', 'deal-documents', false, 52428800)     -- 50 MB, matches the UI's limit
on conflict (id) do update set public = false;

insert into storage.buckets (id, name, public, file_size_limit)
values ('closing-packets', 'closing-packets', false, 104857600)  -- 100 MB, every deal doc merged
on conflict (id) do update set public = false;

insert into storage.buckets (id, name, public, file_size_limit)
values ('form-packets', 'form-packets', false, 52428800)
on conflict (id) do update set public = false;

-- Named policies from before this section owned the buckets. Dropped by EXACT
-- name only: `agents_deal_docs` is what the app's own setup panel printed, the
-- rest are the Supabase dashboard's owner-scoped templates.
drop policy if exists "agents_deal_docs" on storage.objects;
drop policy if exists "Give users access to own folder 1oj01fe_0" on storage.objects;
drop policy if exists "Give users access to own folder 1oj01fe_1" on storage.objects;
drop policy if exists "Give users access to own folder 1oj01fe_2" on storage.objects;
drop policy if exists "Give users access to own folder 1oj01fe_3" on storage.objects;

-- DEAL DOCUMENTS — follow the deal, in every direction. Delete included:
-- whoever may edit the deal row under `deals_agent_scope` may remove its files,
-- and a co-agent who cannot delete a file they just uploaded to a colleague's
-- deal is the mirror image of the bug this section fixes.
drop policy if exists "deal-documents: read" on storage.objects;
create policy "deal-documents: read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'deal-documents'
    and (app_is_admin() or app_storage_deal_id(name) in (select app_visible_deal_ids()))
  );

drop policy if exists "deal-documents: upload" on storage.objects;
create policy "deal-documents: upload"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'deal-documents'
    and (app_is_admin() or app_storage_deal_id(name) in (select app_visible_deal_ids()))
  );

-- Covers `upsert: true` and storage's own move/copy.
drop policy if exists "deal-documents: update" on storage.objects;
create policy "deal-documents: update"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'deal-documents'
    and (app_is_admin() or app_storage_deal_id(name) in (select app_visible_deal_ids()))
  )
  with check (
    bucket_id = 'deal-documents'
    and (app_is_admin() or app_storage_deal_id(name) in (select app_visible_deal_ids()))
  );

drop policy if exists "deal-documents: delete" on storage.objects;
create policy "deal-documents: delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'deal-documents'
    and (app_is_admin() or app_storage_deal_id(name) in (select app_visible_deal_ids()))
  );

-- CLOSING PACKETS — follow the deal, READ ONLY for agents. Packets are built
-- by api/_handlers/closing-packet.js with the service key; the browser only
-- signs a download URL. No write policy, so an agent cannot hand-edit a frozen
-- bundle the audit log points at.
drop policy if exists "closing-packets: read" on storage.objects;
create policy "closing-packets: read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'closing-packets'
    and (app_is_admin() or app_storage_deal_id(name) in (select app_visible_deal_ids()))
  );

-- FORM PACKETS — the shared catalog of blank state forms (`IA/seller/…`), not
-- deal files: there is no deal to scope to and every agent needs the Iowa
-- listing agreement. Mirrors the `form_packets` TABLE — any signed-in agent
-- reads, only office admins write (migration 0030 closed agent writes at the
-- row level while this bucket stayed open to everyone).
drop policy if exists "form-packets: read" on storage.objects;
create policy "form-packets: read"
  on storage.objects for select to authenticated
  using (bucket_id = 'form-packets');

drop policy if exists "form-packets: admin write" on storage.objects;
create policy "form-packets: admin write"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'form-packets' and app_is_admin());

drop policy if exists "form-packets: admin update" on storage.objects;
create policy "form-packets: admin update"
  on storage.objects for update to authenticated
  using      (bucket_id = 'form-packets' and app_is_admin())
  with check (bucket_id = 'form-packets' and app_is_admin());

drop policy if exists "form-packets: admin delete" on storage.objects;
create policy "form-packets: admin delete"
  on storage.objects for delete to authenticated
  using (bucket_id = 'form-packets' and app_is_admin());


-- ═════════════════════════════════════════════════════════════════════════════
-- ACCESS AUDIT  (migration 0050)
--
-- Does this database still match the access model described above? Nothing used
-- to ask. Migration 0049 fixed a storage policy that had hidden a deal's
-- documents from its co-agent for months, and the reason it survived that long
-- is structural, not specific to that bucket:
--
--   • CI parses THIS FILE as text. It passes whether or not a single migration
--     has actually been applied to the database.
--   • The browser cannot read pg_policies, so the app cannot tell either.
--   • A storage policy that hides rows FILTERS them rather than erroring, so
--     the screen looks calm while the data is gone.
--
-- `app_access_audit()` asks the database directly: buckets present and private,
-- the 0049 policies in place, no policy scoping a deal bucket by uploader, RLS
-- on and deal-scoped on every deal child, no policy reachable by anon, and no
-- deal displaying a co-agent it has not granted.
--
-- Read-only — it changes nothing, so it is safe against production at any time.
-- It REPORTS; it never repairs. An access control that rewrites itself at 3am
-- is worse than one that drifts: the fix belongs in a migration a human reads.
--
-- Run by /api/cron?task=access-audit nightly (notifies office admins on a
-- failure), or by hand:  select * from app_access_audit();
-- `scripts/db-verify/access_audit.sql` runs the same checks as plain SQL, for a
-- database where this has not been applied yet.
-- ═════════════════════════════════════════════════════════════════════════════

drop function if exists app_access_audit();

create or replace function app_access_audit()
returns table (area text, item text, status text, detail text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  is_service boolean;
  -- The installed source of app_visible_deal_ids(), read out of the catalog to
  -- tell whether migration 0055 is actually applied here (checks 8-11).
  deal_fn text;
  -- The buckets whose contents are scoped to a deal. `form-packets` is a
  -- deliberately shared catalog and is checked separately.
  deal_buckets text[] := array['deal-documents', 'closing-packets'];
  -- Every storage policy migration 0049 owns. Anything else on these buckets
  -- is a leftover, and is reported.
  known_storage_policies text[] := array[
    'deal-documents: read', 'deal-documents: upload',
    'deal-documents: update', 'deal-documents: delete',
    'closing-packets: read',
    'form-packets: read', 'form-packets: admin write',
    'form-packets: admin update', 'form-packets: admin delete'
  ];
  -- Tables whose rows belong to a deal and must defer to app_visible_deal_ids().
  deal_scoped_tables text[] := array[
    'deals', 'documents', 'document_versions', 'boldsign_documents',
    'closing_packets', 'transaction_steps', 'deal_contacts'
  ];
  r record;
  n integer;
begin
  -- Findings name policies and buckets, which is a map of where the guards are
  -- and where they are missing. Office admins and the server only.
  is_service :=
       current_user = 'service_role'
    or coalesce(current_setting('role', true), '') = 'service_role'
    or coalesce(auth.jwt() ->> 'role', '') = 'service_role'
    or coalesce(current_setting('request.jwt.claim.role', true), '') = 'service_role'
    or (auth.uid() is null and current_user in ('postgres', 'supabase_admin'));

  if not (is_service or app_is_admin()) then
    raise exception 'app_access_audit() is restricted to office admins';
  end if;

  -- ── 1. Buckets exist and are private ─────────────────────────────────────
  foreach item in array (deal_buckets || array['form-packets']) loop
    area := 'storage bucket';
    if not exists (select 1 from storage.buckets b where b.id = item) then
      status := 'FAIL';
      detail := 'bucket is missing — uploads fail and the Documents tab shows a setup panel. Apply migration 0053.';
    elsif exists (select 1 from storage.buckets b where b.id = item and b.public) then
      -- A public bucket needs no signed URL and consults no policy at all.
      status := 'FAIL';
      detail := 'bucket is PUBLIC — every file in it is readable by URL with no session. Apply migration 0053, which forces it private.';
    else
      status := 'ok';
      detail := 'private';
    end if;
    return next;
  end loop;

  -- ── 2. The deal buckets defer to deal visibility ─────────────────────────
  area := 'storage policy';
  foreach item in array known_storage_policies loop
    if not exists (
      select 1 from pg_policies p
       where p.schemaname = 'storage' and p.tablename = 'objects'
         and p.policyname = item
    ) then
      status := 'FAIL';
      detail := 'policy is missing — apply migration 0053.';
      return next;
    end if;
  end loop;

  -- ── 3. THE BUG ITSELF: any policy on a deal bucket scoped to the uploader ─
  -- This is the exact shape that hid a deal's documents from its co-agent. It
  -- is checked by BODY, not by name, because the next one will be named
  -- something else.
  -- PERMISSIVE vs RESTRICTIVE is the whole story here, and 0049 missed it.
  -- Permissive policies are OR'd, so a leftover can only widen and the deal
  -- policies still grant. RESTRICTIVE policies are AND'd: a single one vetoes
  -- every permissive policy there is, so an uploader-scoped restrictive rule
  -- survives 0049 completely and the co-agent still sees nothing — with the
  -- migration correctly applied. Measured: 0 files of 3 with it, 3 without.
  for r in
    select p.policyname, p.cmd, p.permissive,
           coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '') as body
      from pg_policies p
     where p.schemaname = 'storage' and p.tablename = 'objects'
  loop
    -- A RESTRICTIVE policy is examined whatever bucket it names, INCLUDING one
    -- that names none. Skipping those is the blind spot that hid the real
    -- cause for three migrations: the rule actually in force was
    -- `as restrictive ... using (owner = auth.uid())` with no bucket clause,
    -- so every query that filtered on the body mentioning 'deal-documents'
    -- matched nothing and reported a clean bill of health.
    if r.permissive <> 'RESTRICTIVE' and r.body !~ 'deal-documents|closing-packets' then
      continue;
    end if;
    area := 'storage policy';
    item := r.policyname;

    if r.permissive = 'RESTRICTIVE' then
      -- Always a FAIL, whatever its body says: nothing in this repository ever
      -- creates a restrictive policy on these buckets, and one that exists can
      -- only take access away from agents the deal already grants.
      status := 'FAIL';
      detail := 'RESTRICTIVE policy on storage.objects (' || r.cmd ||
                case when r.body ~ 'deal-documents|closing-packets' then ', names a deal bucket'
                     else ', names NO bucket so it applies to deal-documents too' end ||
                '). Restrictive policies are ANDed, so this vetoes every permissive policy no matter what else is in place — the fix can look applied and change nothing. Run migration 0053, or: drop policy ' || quote_ident(r.policyname) || ' on storage.objects;';
      return next;
    elsif r.body ~ '\mowner\M' and not (r.policyname = any(known_storage_policies)) then
      -- Permissive and uploader-scoped: it can only widen, so it is untidy
      -- rather than harmful. Reported so it can be cleaned up deliberately —
      -- dropping it blind could remove access to an object that sits outside
      -- any deal- prefix.
      status := 'warn';
      detail := 'permissive policy scoping a deal bucket by uploader (`owner`). It cannot block anything — permissive policies are ORed — but it is the shape that caused the original outage. Drop it once you are satisfied: drop policy ' || quote_ident(r.policyname) || ' on storage.objects;';
      return next;
    elsif not (r.policyname = any(known_storage_policies)) then
      status := 'warn';
      detail := 'unrecognised policy on a deal bucket (' || r.cmd || '). Read its body; if it does not defer to app_visible_deal_ids() it is changing access outside version control.';
      return next;
    end if;
  end loop;

  -- ── 4. Deal-scoped tables still defer to deal visibility ─────────────────
  foreach item in array deal_scoped_tables loop
    area := 'table policy';
    if not exists (select 1 from pg_tables t where t.schemaname = 'public' and t.tablename = item) then
      status := 'warn';
      detail := 'table not present in this database';
    elsif not exists (
      select 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = 'public' and c.relname = item and c.relrowsecurity
    ) then
      -- RLS off means every policy on the table is inert and every agent sees
      -- every row. Nothing in the UI would look different.
      status := 'FAIL';
      detail := 'ROW LEVEL SECURITY IS DISABLED — every signed-in agent can read and write every row.';
    elsif not exists (
      select 1 from pg_policies p
       where p.schemaname = 'public' and p.tablename = item
         and (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) ~ 'app_visible_deal_ids|app_is_admin|app_current_agent_id'
    ) then
      status := 'FAIL';
      detail := 'no policy defers to app_visible_deal_ids()/app_is_admin() — this table is not scoped to the deal.';
    else
      status := 'ok';
      detail := 'scoped';
    end if;
    return next;
  end loop;

  -- ── 5. Role-less policies (the migration 0027 class) ──────────────────────
  -- A policy with no `to <role>` applies to PUBLIC, which in Supabase includes
  -- `anon` — and the anon key ships in the browser bundle. `{public}` in
  -- pg_policies.roles is exactly that.
  area := 'anon exposure';
  for r in
    select p.schemaname, p.tablename, p.policyname
      from pg_policies p
     where p.roles = '{public}'
       and p.schemaname in ('public', 'storage')
       -- Landing pages render campaign images straight from the public bucket.
       and p.policyname <> 'campaign-images: public read'
       -- The external website tracking snippet posts with the anon key.
       and p.policyname <> 'public_insert'
     order by p.schemaname, p.tablename, p.policyname
  loop
    item   := r.schemaname || '.' || r.tablename || ' / ' || r.policyname;
    status := 'FAIL';
    detail := 'policy has no TO clause, so it applies to PUBLIC — the anonymous key can use it. Re-create it with `to authenticated`.';
    return next;
  end loop;
  if not found then
    item := 'policies without a TO clause'; status := 'ok'; detail := 'none';
    return next;
  end if;

  -- ── 6. The co-agent cache, behind its listing ────────────────────────────
  -- This check used to mean "these agents have lost access": RLS read only
  -- `deals.co_agent_ids`, so a co-agent the team card showed from the property
  -- saw the card and nothing else on the deal.
  --
  -- Since migration 0055 access is DERIVED from the listing too, so a stale
  -- column costs no access at all. What it still costs: the commission seed,
  -- the signer prefill and /api/portal earnings read the cached column, so they
  -- can name a smaller team than the deal page does. The sync triggers below
  -- correct it on the next edit either side, which is why this is a warning
  -- about payment and prefill rather than about access.
  area := 'co-agent visibility';
  item := 'deals displaying a co-agent RLS does not grant';
  -- Counts a PARTIAL mismatch, not just an empty column. The first version of
  -- this asked `array_length(co_agent_ids) = 0`, which silently passed a deal
  -- carrying one co-agent whose property listed two — the second was on the
  -- team card and nowhere RLS could see it. Seen live: granted=1, shown=2.
  select count(distinct d.id) into n
    from deals d
    join properties p on p.id = d.property_id
    cross join lateral (
      select nullif(v, '')::uuid as shown
        from jsonb_array_elements_text(p.details->'co_agent_ids') as t(v)
       where v ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    ) listed
   where jsonb_typeof(p.details->'co_agent_ids') = 'array'
     and listed.shown is distinct from d.agent_id
     and not (coalesce(d.co_agent_ids, '{}') @> array[listed.shown]);
  if n > 0 then
    status := 'warn';
    detail := n || ' deal(s) carry a co-agent cache that is behind their listing. Since migration 0055 this costs no ACCESS — the listing grants it directly — but the commission seed and the signer prefill read the cached column, so they may name a smaller team than the deal page does. The sync triggers fix this on the next edit either side.';
  else
    status := 'ok';
    detail := 'none';
  end if;
  return next;

  -- ── 7. Is 0049 actually applied? ─────────────────────────────────────────
  -- Asked last so it reads as the explanation for everything above it: a run
  -- full of FAILs plus this one means "apply the migration", not "investigate".
  area := 'migration';
  item := '0049 deal document storage RLS';
  if exists (
    select 1 from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
     where ns.nspname = 'public' and pr.proname = 'app_storage_deal_id'
  ) then
    status := 'ok';    detail := 'applied';
  else
    status := 'FAIL';  detail := 'NOT APPLIED — deal documents are still scoped by whoever uploaded them. Run migrations/0053_deal_documents_one_fix.sql.';
  end if;
  return next;

  -- ── 8. Is the LISTING part of the model in this database? ────────────────
  -- The check that would have caught the bug migration 0055 fixes. Read out of
  -- the catalog, never assumed: a file in the repository proves nothing about
  -- what is installed, and CI parses this file as text and passes either way.
  area := 'migration';
  item := '0055 deal team access';
  select pg_get_functiondef(pr.oid) into deal_fn
    from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
   where ns.nspname = 'public' and pr.proname = 'app_visible_deal_ids'
   limit 1;
  if deal_fn is null then
    status := 'FAIL';
    detail := 'app_visible_deal_ids() is missing entirely — no agent can see any deal. Run migrations/0055_deal_team_access.sql.';
  elsif deal_fn not like '%assigned_agent_id in (select app_my_agent_ids())%'
     or deal_fn not like '%app_jsonb_uuid_array(p.details -> ''co_agent_ids'')%' then
    status := 'FAIL';
    detail := 'NOT APPLIED — deal access still comes only from the copy taken when the property was converted, so an agent added to a listing AFTER its deal was started cannot see the deal or its documents. Run migrations/0055_deal_team_access.sql.';
  else
    status := 'ok'; detail := 'deal access is derived from the listing as well as the deal';
  end if;
  return next;

  -- ── 9. The guard that makes deriving from the listing safe ───────────────
  area := 'table policy';
  item := 'properties write scope';
  select count(*) into n
    from pg_policies
   where schemaname = 'public' and tablename = 'properties'
     and permissive = 'PERMISSIVE' and cmd = 'ALL'
     and coalesce(qual, 'true') = 'true';
  if n > 0 then
    status := 'FAIL';
    detail := n || ' wide-open for-ALL policy/policies on properties: every signed-in agent can rewrite any listing in the firm, which with listing-derived deal access lets anyone grant themselves someone else''s deal. Run migrations/0055_deal_team_access.sql.';
  else
    status := 'ok'; detail := 'reads are firm-wide; writes require being on the listing';
  end if;
  return next;

  -- ── 10. The cache the commission seed and signer prefill read ────────────
  area := 'co-agent sync';
  item := 'listing <-> deal triggers';
  select count(*) into n
    from pg_trigger
   where not tgisinternal
     and tgname in ('trg_property_coagents_to_deals', 'trg_deal_coagents_to_property');
  if n = 2 then
    status := 'ok'; detail := 'both directions installed';
  else
    status := 'FAIL';
    detail := n || ' of 2 sync triggers present. Without them the team a deal DISPLAYS can drift from the team it pays. Run migrations/0055_deal_team_access.sql.';
  end if;
  return next;

  -- ── 11. Agents whose login may not resolve to their roster row ──────────
  -- Reported, never repaired: an access control that rewrites identity at 3am
  -- is worse than one that tells a human. Since migration 0055 they resolve by
  -- the verified email on their login, so this is a warning rather than the
  -- silent blackout it used to be.
  area := 'identity';
  item := 'agents with no login link';
  select count(*) into n from agents where auth_id is null;
  if n = 0 then
    status := 'ok'; detail := 'every agent row is linked to a login';
  else
    status := 'warn';
    detail := n || ' agent row(s) have agents.auth_id = NULL. They resolve by the verified email on their login instead of seeing nothing — but only if that email matches the row exactly. Check them, and set auth_id by hand where it does not.';
  end if;
  return next;
end
$$;

-- Execute is granted broadly; the function refuses a non-admin caller itself,
-- which keeps the refusal message useful instead of a bare permission error.

-- Execute is granted broadly; the function refuses a non-admin caller itself,
-- which keeps the refusal message useful instead of a bare permission error.
grant execute on function app_access_audit() to authenticated, service_role;


-- ═════════════════════════════════════════════════════════════════════════════
-- DUPLICATE DEALS  (migration 0054)
--
-- Two agents each had a deal on one property: one carried 22 filled terms, 3
-- documents and a task, the other was empty. Nothing failed to synchronise —
-- they were two ROWS, and everything on a deal hangs off its id (comp_data,
-- `deal-<uuid>/` storage, key dates, tasks, commission, signatures).
--
-- The second row is easy to create and impossible to notice: "Start Deal" was
-- a bare insert, and the property looked untouched to the second agent because
-- RLS only shows deals you are on. The access model manufactures the duplicate.
--
-- Which is why the check cannot live in the browser: the deals there are
-- RLS-scoped, so a colleague's deal is absent and a client-side check answers
-- "no duplicate" for exactly the person about to create one.
-- `app_open_deal_on_property()` is `security definer` for that one narrow
-- question. It returns no value, no commission and no contacts — only enough
-- to say "Steph already has a deal here" instead of silently making a second.
--
-- PER SIDE, NOT PER PROPERTY: a buyer-side and a seller-side deal on one
-- property is legitimate business (seen live, both closed). Two OPEN deals on
-- the same property and the same side are the duplicates.
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function app_open_deal_on_property(
  p_property_id uuid,
  p_side        text default null   -- null = any side
)
returns table (
  deal_id    uuid,
  title      text,
  stage      text,
  side       text,
  agent_id   uuid,
  agent_name text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select d.id, d.title, d.stage,
         coalesce(d.comp_data->>'transaction_type', 'unknown'),
         d.agent_id, a.name, d.created_at
    from deals d
    left join agents a on a.id = d.agent_id
   where d.property_id = p_property_id
     and d.stage not in ('closed', 'lost')
     and (p_side is null
          or coalesce(d.comp_data->>'transaction_type', 'unknown')
             = coalesce(nullif(btrim(p_side), ''), 'unknown'))
   order by d.created_at
$$;

grant execute on function app_open_deal_on_property(uuid, text) to authenticated;

-- ── 3. Ask the owner for access — never take it ────────────────────────────
-- An agent who finds a colleague's deal needs a way forward that is not "make
-- a second one". This notifies the owner; it grants NOTHING. A function that
-- let any agent add themselves to any deal would be a privilege escalation
-- dressed up as a convenience.
create or replace function app_request_deal_access(p_deal_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid; me_name text; owner_id uuid; d_title text;
begin
  me := app_current_agent_id();
  if me is null then return false; end if;

  select d.agent_id, d.title into owner_id, d_title from deals d where d.id = p_deal_id;
  if owner_id is null or owner_id = me then return false; end if;

  -- One pending ask per agent per deal. Clicking twice must not page someone
  -- twice, and a stuck request must not become a nightly reminder.
  if exists (
    select 1 from agent_notifications n
     where n.agent_id = owner_id and n.deal_id = p_deal_id
       and n.type = 'deal_access_request' and n.read = false
       and n.message like '%' || me::text || '%'
  ) then
    return true;
  end if;

  select a.name into me_name from agents a where a.id = me;

  insert into agent_notifications (agent_id, deal_id, title, message, type)
  values (
    owner_id,
    coalesce(me_name, 'An agent') || ' wants access to ' || coalesce(d_title, 'a deal'),
    coalesce(me_name, 'An agent') || ' opened this property and found your deal instead of starting their own. '
      || 'Add them under Agents on deal if they are working it with you.  [' || me::text || ']',
    'deal_access_request'
  );
  return true;
end
$$;

grant execute on function app_request_deal_access(uuid) to authenticated;


-- The backstop behind the UI check: two agents clicking at the same moment, an
-- import, a hand-written insert. `coalesce(..., 'unknown')` is load-bearing —
-- Postgres treats NULLs as DISTINCT in a unique index, so keying on the raw
-- value would permit unlimited duplicates on every deal without a side set,
-- which live data showed was most of them.
create unique index if not exists deals_one_open_per_property_side
  on deals (property_id, (coalesce(comp_data->>'transaction_type', 'unknown')))
  where property_id is not null and stage not in ('closed', 'lost');
