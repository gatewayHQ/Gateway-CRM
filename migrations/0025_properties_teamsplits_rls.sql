-- ─────────────────────────────────────────────────────────────────────────────
-- 0025 — Scope properties + lock down team_splits (security remediation)
--
-- Closes two gaps from the 2026-07 RLS audit:
--
--   F-02  properties carried only `allow_all using(true) with check(true)` (for
--         ALL roles incl. anon). Any authenticated agent — or anyone with the
--         public anon key hitting PostgREST directly — could read, modify, or
--         DELETE every listing firm-wide. Per-agent scoping existed only as a
--         client-side JS filter, trivially bypassed outside the app.
--
--   F-04  team_splits (which decides who-sees-whose deals/contacts/properties
--         via app_visible_agent_ids) was also `allow_all` and written straight
--         from the browser. An agent could insert a row adding a colleague to
--         "their" team with sharing on and gain access to that colleague's book
--         — self-service privilege escalation.
--
-- App prereq (deploy BEFORE running this): the build that routes the public
-- listing/share pages through /api/property-public (service key, single id).
-- Older builds read properties with the anon key and would break once scoped.
--
-- Idempotent; safe to re-run. Depends on the helpers in schema.sql / 0011
-- (app_is_admin, app_current_agent_id, app_visible_agent_ids).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── PROPERTIES ───────────────────────────────────────────────────────────────
-- Own + share-properties team peers + admin. Public reads no longer touch the
-- table directly — they go through the by-id service-key gateway.
drop policy if exists allow_all              on properties;
drop policy if exists properties_agent_scope on properties;
create policy properties_agent_scope on properties for all to authenticated
  using      (app_is_admin() or assigned_agent_id in (select app_visible_agent_ids('properties')))
  with check (app_is_admin() or assigned_agent_id in (select app_visible_agent_ids('properties')));

-- Owner-stamp: default a null assigned_agent_id to the creator, so listings made
-- from paths that don't set an owner (ColdCalls, ContactDrawer) are still owned
-- by — and visible to — the person who created them, instead of becoming
-- admin-only orphans. (Audit F-07.) Mirrors deals_stamp_owner.
create or replace function properties_stamp_owner()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.assigned_agent_id is null then
    new.assigned_agent_id := app_current_agent_id();  -- null for service role / unclaimed seat
  end if;
  return new;
end $$;
drop trigger if exists properties_stamp_owner_trg on properties;
create trigger properties_stamp_owner_trg
  before insert on properties
  for each row execute function properties_stamp_owner();

-- Backfill note: any EXISTING rows with assigned_agent_id IS NULL become
-- admin-only under the new policy. Review and reassign them, e.g.:
--   select id, address, city, state from properties where assigned_agent_id is null;
-- then update each to its rightful owner. (Admins still see them to do this.)

-- ── TEAM_SPLITS ──────────────────────────────────────────────────────────────
-- Membership stays readable by any authenticated user (App.jsx reads it to
-- build the UI's visible-agent lists), but WRITES are admin-only — team
-- composition is an office-admin / coordinator responsibility, and gating it
-- removes the escalation path.
drop policy if exists allow_all                on team_splits;
drop policy if exists team_splits_read         on team_splits;
drop policy if exists team_splits_admin_write  on team_splits;
drop policy if exists team_splits_insert        on team_splits;
drop policy if exists team_splits_update        on team_splits;
drop policy if exists team_splits_delete        on team_splits;

create policy team_splits_read   on team_splits for select to authenticated using (true);
create policy team_splits_insert on team_splits for insert to authenticated with check (app_is_admin());
create policy team_splits_update on team_splits for update to authenticated using (app_is_admin()) with check (app_is_admin());
create policy team_splits_delete on team_splits for delete to authenticated using (app_is_admin());
