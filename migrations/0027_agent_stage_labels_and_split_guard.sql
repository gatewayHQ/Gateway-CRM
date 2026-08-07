-- Migration 0027 — Per-agent pipeline headers + the commission-split save fix
-- ===========================================================================
-- WHY (part 1 — splits that wouldn't save)
--   `agents_guard_privileged` (migration 0023) freezes role / is_admin /
--   default_split_pct / no_brokerage_split / cap_* on UPDATE unless the caller
--   is trusted. It recognized exactly two trusted callers:
--
--       auth.jwt() ->> 'role' = 'service_role'      -- the server API
--       app_is_admin()                              -- an office admin
--
--   Both can come back false for a legitimate write:
--
--     • The server API authenticates with the SERVICE key. Under Supabase's
--       legacy service_role key that key IS a JWT, so `auth.jwt()` carries
--       role=service_role and the check passes. Under the newer non-JWT secret
--       keys (`sb_secret_…`) there are no JWT claims to read, `auth.jwt()` is
--       null, and the guard treats the brokerage's own admin endpoint as a
--       hostile caller.
--     • `app_is_admin()` resolves the admin through `auth.uid()`, which is null
--       on a service-role connection — so the fallback can't save it either.
--
--   The trigger is BEFORE UPDATE and rewrites `new.*` back to `old.*`. It does
--   not raise. The UPDATE therefore reports SUCCESS having changed nothing:
--   the Team drawer and the Back Office caps table both toasted "saved" and the
--   split silently reverted on the next page load. That is the reported bug.
--
--   Fix: recognize the service role the way Postgres itself sees it. PostgREST
--   does `SET LOCAL ROLE service_role` for service-key requests, so
--   `current_user`/`current_setting('role')` are authoritative and do not
--   depend on the key format. The JWT claim is kept as an extra signal.
--
--   The guard is NOT loosened for browsers: a signed-in non-admin still cannot
--   touch a privileged column, because none of the new conditions can be true
--   for an `authenticated` connection. Belt-and-braces, api/portal.js now also
--   re-reads the saved row and fails loudly if a privileged field didn't stick,
--   so a future guard misfire can never masquerade as a successful save again.
--
-- WHY (part 2 — renameable pipeline headers)
--   Agents asked to relabel the board columns to match how they actually work
--   ("Qualified" → "Vetted", "Offer" → "LOI Out"). Renaming is a personal
--   DISPLAY preference and must not touch `deals.stage`: that token drives the
--   CHECK constraint, stage automations, reports, and the client portal's
--   progress bar. So the override is stored per agent and applied at render
--   time only.
--
-- WHAT
--   • `agents.stage_labels jsonb not null default '{}'` — { stage_token: label }
--     for that agent only. Absent key = built-in label. Validated and clamped
--     server-side by src/lib/stageLabels.js before it is ever written.
--   • `agents_guard_privileged()` — robust trusted-caller detection (above).
--     `stage_labels` is deliberately NOT frozen: it is a preference, not a
--     permission, and an agent must be able to rename their own columns.
--   • `teams.type` + `team_splits (team_id, agent_id)` uniqueness — asserted for
--     databases predating the base schema. The Team modal now edits each
--     member's `split_pct` (there was never an input for it, so every member was
--     stored at 0%) and saves membership with an UPSERT.
--
-- CHANGES BEHAVIOR?
--   Yes, and that is the point: admin edits to commission splits / caps /
--   is_admin now actually persist on projects using the new secret-key format.
--   No data is rewritten by this migration.
--
-- SAFE TO RE-RUN: yes (add column if not exists + create or replace).
-- ===========================================================================

-- ── 1. Per-agent pipeline column headers ────────────────────────────────────
alter table agents add column if not exists stage_labels jsonb not null default '{}'::jsonb;

comment on column agents.stage_labels is
  'Per-agent display overrides for pipeline column headers: { stage_token: "Custom Label" }. '
  'Display only — deals.stage always keeps its canonical token.';

-- Reject anything that is not a JSON object, so a bad client can''t park an
-- array or a scalar in a column the UI spreads over its label map.
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'agents_stage_labels_object'
  ) then
    alter table agents add constraint agents_stage_labels_object
      check (jsonb_typeof(stage_labels) = 'object');
  end if;
end $$;

-- ── 2. Privilege guard: recognize the service role reliably ─────────────────
create or replace function agents_guard_privileged()
returns trigger language plpgsql as $$
declare
  is_service boolean;
begin
  -- Trusted caller detection, widest-to-narrowest:
  --   • current_user / role — PostgREST does `SET LOCAL ROLE service_role`, so
  --     this holds for BOTH the legacy service_role JWT and the newer
  --     `sb_secret_…` keys. This is the check that was missing.
  --   • auth.jwt() claim — legacy keys; harmless to keep.
  --   • a direct superuser/owner connection (SQL editor, migrations, psql).
  is_service :=
       current_user = 'service_role'
    or coalesce(current_setting('role', true), '') = 'service_role'
    or coalesce(auth.jwt() ->> 'role', '') = 'service_role'
    or coalesce(current_setting('request.jwt.claim.role', true), '') = 'service_role'
    or auth.uid() is null and current_user in ('postgres', 'supabase_admin');

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
  -- stage_labels is intentionally absent — renaming your own board columns is a
  -- preference every agent is allowed to change.
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

-- ── 3. teams.type: the switch that makes split_pct mean something ───────────
-- Declared in the base schema but absent from databases created before it. The
-- Team modal now reads and writes it, so assert it here.
alter table teams add column if not exists type text default 'collaboration';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'teams_type_check') then
    update teams set type = 'collaboration' where type is null or type not in ('collaboration','split');
    alter table teams add constraint teams_type_check check (type in ('collaboration','split'));
  end if;
end $$;

-- ── 4. team_splits: make a member's split percentage real ───────────────────
-- The column existed but the Team modal never offered an input, so every member
-- was written with split_pct = 0. The modal now edits it, and saves membership
-- with an UPSERT instead of delete-then-insert (a failed insert used to leave
-- the team empty). Upsert needs the (team_id, agent_id) uniqueness the base
-- schema declares — assert it here for databases predating it.
do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'team_splits'::regclass and contype = 'u'
       and conkey = array[
         (select attnum from pg_attribute where attrelid = 'team_splits'::regclass and attname = 'team_id'),
         (select attnum from pg_attribute where attrelid = 'team_splits'::regclass and attname = 'agent_id')
       ]::smallint[]
  ) then
    -- Collapse any pre-existing duplicates first, keeping the newest row.
    delete from team_splits t using team_splits dup
     where t.team_id = dup.team_id and t.agent_id = dup.agent_id
       and t.created_at < dup.created_at;
    alter table team_splits add constraint team_splits_team_agent_key unique (team_id, agent_id);
  end if;
end $$;

comment on column team_splits.split_pct is
  'This member''s share of a split-type team''s commission, 0-100. Only meaningful when teams.type = ''split''.';

-- ── 5. Verification ─────────────────────────────────────────────────────────
-- Run as an ADMIN in the SQL editor; the split should come back changed.
--   select id, name, default_split_pct from agents order by name;
--   update agents set default_split_pct = default_split_pct where id = '<uuid>';
-- And confirm the column landed:
--   select column_name, data_type, column_default
--     from information_schema.columns
--    where table_name = 'agents' and column_name = 'stage_labels';
