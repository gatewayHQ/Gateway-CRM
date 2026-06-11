-- Gateway CRM — Milestone 0 database changes, v4 (SAFE STEP — Phase A only)
-- Built from the read-only diagnostic of the live database (2026-06-10) and
-- tested against an exact replica of it before delivery. Earlier failed runs
-- (v1–v3) all rolled back cleanly — nothing was applied.
--
-- WHAT CHANGES FOR USERS: nothing visible for logged-in agents. The only
-- behavior change is the SECURITY HOTFIX (section 7), which stops ANONYMOUS
-- visitors from being able to write/delete properties and read integration
-- credentials — capabilities no legitimate part of the product uses.
-- Enforcement of per-agent visibility is Phase B — commented out at the
-- bottom, NOT part of this run. Safe to re-run.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. DOCUMENTS — this table was missing entirely (deal documents have been
--    broken in production). Created secure from day one: deal-scoped + admin.
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists documents (
  id           uuid primary key default uuid_generate_v4(),
  deal_id      uuid references deals(id) on delete cascade,
  agent_id     uuid references agents(id) on delete set null,
  name         text not null,
  size         bigint,
  mime_type    text,
  storage_path text,
  created_at   timestamptz default now()
);
create index if not exists idx_documents_deal on documents(deal_id);
alter table documents enable row level security;
-- Explicit grants (normally covered by Supabase default privileges; stated
-- here so the table works regardless of how the project is configured)
grant select, insert, update, delete on table documents to authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. DOCUSIGN ENVELOPES — columns the current app writes that the live table
--    lacks (this was the v3 failure)
-- ═══════════════════════════════════════════════════════════════════════════
alter table docusign_envelopes
  add column if not exists agent_id    uuid references agents(id) on delete set null,
  add column if not exists document_id uuid references documents(id) on delete set null,
  add column if not exists signers     jsonb default '[]';

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. ACTIVITIES — can attach to deals (deal timeline)
-- ═══════════════════════════════════════════════════════════════════════════
alter table activities
  add column if not exists deal_id uuid references deals(id) on delete set null;
create index if not exists idx_activities_deal on activities(deal_id, created_at desc);

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. DATA GUARDS — deals.value >= 0, probability 0–100
-- ═══════════════════════════════════════════════════════════════════════════
update deals set value = null where value < 0;
update deals set probability = greatest(0, least(100, probability))
  where probability < 0 or probability > 100;

alter table deals drop constraint if exists deals_value_nonneg;
alter table deals add  constraint deals_value_nonneg
  check (value is null or value >= 0);
alter table deals drop constraint if exists deals_probability_range;
alter table deals add  constraint deals_probability_range
  check (probability is null or (probability >= 0 and probability <= 100));

-- Make sure the office admin / transaction coordinator carries the explicit flag
update agents set is_admin = true
  where is_admin is distinct from true and role ilike '%admin%';

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. VISIBILITY HELPERS
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function app_current_agent_id()
returns uuid
language sql stable security definer set search_path = public as $$
  select id from agents where auth_id = auth.uid() limit 1;
$$;

create or replace function app_is_admin()
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(bool_or(is_admin or role ilike '%admin%'), false)
  from agents where auth_id = auth.uid();
$$;

create or replace function app_visible_agent_ids(dimension text)
returns setof uuid
language sql stable security definer set search_path = public as $$
  select app_current_agent_id()
  union
  select peer.agent_id
  from team_splits me
  join team_splits peer
    on peer.team_id = me.team_id
   and peer.agent_id <> me.agent_id
  where me.agent_id = app_current_agent_id()
    and case dimension
          when 'contacts'   then peer.share_contacts
          when 'properties' then peer.share_properties
          when 'deals'      then peer.share_deals
          else false
        end is not false;
$$;

create or replace function app_visible_deal_ids()
returns setof uuid
language sql stable security definer set search_path = public as $$
  select d.id from deals d where app_is_admin()
  union
  select d.id from deals d
  where d.agent_id in (select app_visible_agent_ids('deals'))
  union
  -- co-listed via the legacy co_agent_ids array on the deal itself
  select d.id from deals d
  where app_current_agent_id() = any(coalesce(d.co_agent_ids, '{}'))
  union
  -- co-listed via structured commission participants
  select c.deal_id
  from commissions c
  cross join lateral jsonb_array_elements(coalesce(c.participants, '[]'::jsonb)) p
  where (p->>'agent_id') is not null
    and (p->>'agent_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    and (p->>'agent_id')::uuid = app_current_agent_id();
$$;

grant execute on function app_current_agent_id()      to authenticated;
grant execute on function app_is_admin()              to authenticated;
grant execute on function app_visible_agent_ids(text) to authenticated;
grant execute on function app_visible_deal_ids()      to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. SCOPED POLICIES — dormant next to the existing permissive policies
--    until Phase B removes those. documents (new) is enforced immediately.
-- ═══════════════════════════════════════════════════════════════════════════
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

drop policy if exists tasks_agent_scope on tasks;
create policy tasks_agent_scope on tasks for all to authenticated
  using      (agent_id = app_current_agent_id())
  with check (agent_id = app_current_agent_id());

drop policy if exists contacts_agent_scope on contacts;
create policy contacts_agent_scope on contacts for all to authenticated
  using      (app_is_admin() or assigned_agent_id in (select app_visible_agent_ids('contacts')))
  with check (app_is_admin() or assigned_agent_id in (select app_visible_agent_ids('contacts')));

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

drop policy if exists deals_agent_scope on deals;
create policy deals_agent_scope on deals for all to authenticated
  using (id in (select app_visible_deal_ids()))
  with check (
    app_is_admin()
    or agent_id in (select app_visible_agent_ids('deals'))
    or id in (select app_visible_deal_ids())
  );

drop policy if exists commissions_deal_scope on commissions;
create policy commissions_deal_scope on commissions for all to authenticated
  using      (deal_id in (select app_visible_deal_ids()))
  with check (deal_id in (select app_visible_deal_ids()));

drop policy if exists docusign_envelopes_deal_scope on docusign_envelopes;
create policy docusign_envelopes_deal_scope on docusign_envelopes for all to authenticated
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

drop policy if exists transaction_steps_deal_scope on transaction_steps;
create policy transaction_steps_deal_scope on transaction_steps for all to authenticated
  using      (deal_id in (select app_visible_deal_ids()))
  with check (deal_id in (select app_visible_deal_ids()));

drop policy if exists deadline_reminders_deal_scope on deadline_reminders;
create policy deadline_reminders_deal_scope on deadline_reminders for all to authenticated
  using      (deal_id in (select app_visible_deal_ids()))
  with check (deal_id in (select app_visible_deal_ids()));

drop policy if exists agent_notifications_own on agent_notifications;
create policy agent_notifications_own on agent_notifications for all to authenticated
  using      (agent_id = app_current_agent_id())
  with check (agent_id = app_current_agent_id());

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. SECURITY HOTFIX — close anonymous-access holes found by the diagnostic.
--    Logged-in agents are unaffected. Public landing pages keep read access
--    to properties (that is all they use).
-- ═══════════════════════════════════════════════════════════════════════════
-- properties: anonymous visitors could INSERT/UPDATE/DELETE listings
drop policy if exists "Allow all"  on properties;
drop policy if exists allow_all    on properties;
drop policy if exists prop_select  on properties;
drop policy if exists prop_insert  on properties;
drop policy if exists prop_update  on properties;
drop policy if exists prop_delete  on properties;
drop policy if exists properties_public_read on properties;
drop policy if exists properties_auth_write  on properties;
create policy properties_public_read on properties for select using (true);
create policy properties_auth_write  on properties for all to authenticated
  using (true) with check (true);

-- integrations: stores credentials; was readable/writable by anonymous visitors
drop policy if exists "Allow all for anon" on integrations;
drop policy if exists integrations_auth    on integrations;
create policy integrations_auth on integrations for all to authenticated
  using (true) with check (true);

-- webhook_configs: same exposure
drop policy if exists "Allow all for anon" on webhook_configs;
drop policy if exists webhook_configs_auth on webhook_configs;
create policy webhook_configs_auth on webhook_configs for all to authenticated
  using (true) with check (true);

-- ───────────────────────────────────────────────────────────────────────────
-- PHASE B — ACTIVATE per-agent enforcement. DO NOT RUN TODAY.
-- (Names below are the live database's actual permissive policies, from the
-- diagnostic. agents/templates/teams stay shared by design.)
-- ───────────────────────────────────────────────────────────────────────────
-- do $$
-- declare t text;
-- begin
--   foreach t in array array['contacts','deals','tasks','activities'] loop
--     execute format('drop policy if exists agent_select on %I', t);
--     execute format('drop policy if exists agent_insert on %I', t);
--     execute format('drop policy if exists agent_update on %I', t);
--     execute format('drop policy if exists agent_delete on %I', t);
--   end loop;
-- end $$;
-- drop policy if exists agent_select on commissions;
-- drop policy if exists agent_insert on commissions;
-- drop policy if exists agent_update on commissions;
-- drop policy if exists agents_envelopes on docusign_envelopes;
-- drop policy if exists allow_all        on docusign_envelopes;
-- drop policy if exists auth_all_steps   on transaction_steps;
-- drop policy if exists allow_all        on transaction_steps;
-- drop policy if exists agent_notifications_policy on agent_notifications;
-- drop policy if exists allow_all                  on agent_notifications;
-- drop policy if exists deadline_reminders_all     on deadline_reminders;

-- ───────────────────────────────────────────────────────────────────────────
-- PHASE B-ROLLBACK — instantly reopen if anything misbehaves after Phase B
-- ───────────────────────────────────────────────────────────────────────────
-- do $$
-- declare t text;
-- begin
--   foreach t in array array[
--     'contacts','activities','tasks','deals','commissions','documents',
--     'docusign_envelopes','transaction_steps','agent_notifications',
--     'deadline_reminders'
--   ] loop
--     execute format('drop policy if exists phaseb_rollback_open on %I', t);
--     execute format('create policy phaseb_rollback_open on %I for all to authenticated using (true) with check (true)', t);
--   end loop;
-- end $$;
