-- ─────────────────────────────────────────────────────────────────────────────
-- 0030 — Reconcile the live `deals` table to the repo (fixes commercial-deal
--        creation for all agents)
--
-- Symptom: office agents (non-admins) cannot create a deal in the pipeline —
-- "new row violates row-level security policy for table deals". It went
-- firm-wide once the last is_admin bypass was removed.
--
-- This consolidates every deals-related fix into one safe, idempotent block so
-- prod matches schema.sql. It:
--   1. ensures every column the app writes exists,
--   2. widens the stage CHECK to all 16 tokens the CRM offers (commercial +
--      residential boards) — src/lib/stages.js ALL_DEAL_STAGES,
--   3. resets the deals RLS policies so INSERT is gated on the caller's IDENTITY
--      (not on the row being visible yet — that was impossible at insert time
--      because the deal_agents link is created by an AFTER trigger),
--   4. guarantees the owner-guard + primary-link + closed_at triggers, and
--      retires the redundant/duplicate ones.
--
-- Depends on: app_is_admin, app_current_agent_id, app_visible_agent_ids,
-- app_visible_deal_ids (0011/0029). Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) Columns the pipeline / quick-add / start-deal forms write ----------------
alter table deals add column if not exists prop_category  text;
alter table deals add column if not exists prop_subtype   text;
alter table deals add column if not exists comp_data      jsonb default '{}';
alter table deals add column if not exists expected_close_date date;
alter table deals add column if not exists notes          text;
alter table deals add column if not exists probability    integer default 0;
alter table deals add column if not exists portal_token   uuid;
alter table deals add column if not exists portal_enabled boolean default false;
alter table deals add column if not exists closed_at      timestamptz;

-- 2) Stage CHECK — accept every token the boards can produce ------------------
-- Drop whatever the current stage check is named, then add the full set.
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'deals'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%stage%'
  loop
    execute format('alter table deals drop constraint %I', c.conname);
  end loop;
end $$;
alter table deals add constraint deals_stage_check check (stage in (
  'lead','qualified','showing','offer','under-contract','closed','lost',
  'pursuit','om-marketing','listing-agreement','on-market','loi','psa','due-diligence',
  'pre-list','active'
));

-- 3) RLS: known-good per-command policy set ----------------------------------
-- INSERT is gated on identity (any linked agent) — NOT on visibility, which is
-- false at insert time and was rejecting every non-admin. Ownership is stamped
-- by the guard (below) and enforced on SELECT/UPDATE.
drop policy if exists deals_agent_scope on deals;

drop policy if exists deals_select on deals;
create policy deals_select on deals for select to authenticated
  using (id in (select app_visible_deal_ids()));

drop policy if exists deals_insert on deals;
create policy deals_insert on deals for insert to authenticated
  with check (app_is_admin() or app_current_agent_id() is not null);

drop policy if exists deals_update on deals;
create policy deals_update on deals for update to authenticated
  using (id in (select app_visible_deal_ids()))
  with check (
    app_is_admin()
    or agent_id in (select app_visible_agent_ids('deals'))
    or id in (select app_visible_deal_ids())
  );

drop policy if exists deals_delete on deals;
create policy deals_delete on deals for delete to authenticated
  using (app_is_admin() or agent_id = app_current_agent_id());

-- 4) Triggers: stamp owner, sync the primary deal_agents link, set closed_at --
create or replace function app_deal_owner_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare me uuid;
begin
  if auth.uid() is null then return new; end if;         -- service key / cron
  if app_is_admin() then return new; end if;
  me := app_current_agent_id();
  if me is null then
    raise exception 'Your login is not linked to an agent profile yet. Ask an admin to link your account.'
      using errcode = '42501';
  end if;
  if new.agent_id is null then new.agent_id := me; end if;
  if new.agent_id not in (select app_visible_agent_ids('deals')) then
    raise exception 'Deals can only be created for yourself or a teammate who shares deals with you.'
      using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists deals_owner_guard on deals;
create trigger deals_owner_guard before insert on deals
  for each row execute function app_deal_owner_guard();

create or replace function sync_primary_deal_agent()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.agent_id is not null then
    delete from deal_agents where deal_id = new.id and role='primary' and agent_id <> new.agent_id;
    insert into deal_agents (deal_id, agent_id, role) values (new.id, new.agent_id, 'primary')
    on conflict (deal_id, agent_id) do update set role='primary';
  end if;
  return new;
end $$;
drop trigger if exists trg_sync_primary_deal_agent on deals;
create trigger trg_sync_primary_deal_agent
  after insert or update of agent_id on deals
  for each row execute function sync_primary_deal_agent();

-- Retire the redundant owner-stamp trigger (owner_guard supersedes it) and the
-- duplicate updated_at trigger.
drop trigger  if exists deals_stamp_owner_trg on deals;
drop function if exists deals_stamp_owner();
drop trigger  if exists deals_set_updated_at on deals;

-- Backfill any deal missing its primary deal_agents link (idempotent).
insert into deal_agents (deal_id, agent_id, role)
select id, agent_id, 'primary' from deals where agent_id is not null
on conflict (deal_id, agent_id) do update set role='primary';
