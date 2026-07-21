-- ═════════════════════════════════════════════════════════════════════════════
-- 0023 — Mailing-List landing pages  +  Profile RBAC hardening
--
-- Two independent, additive features bundled into one migration:
--
--  A) MAILING LISTS
--     • New landing_type = 'mailing' (+ 'mailing' as a lead source_landing).
--     • New table mailing_subscribers — the durable, deduped opt-in list behind
--       a mailing-list landing page. Distinct from mailing_leads (one-off
--       property/valuation captures): subscribers are managed (unsubscribe,
--       export) and can't be added twice.
--
--  B) PROFILE RBAC  (fixes: any user could edit any colleague's profile)
--     • agents loses its wide-open `allow_all` policy.
--     • Reads stay public (roster + landing pages). Writes are scoped:
--         - a user may edit ONLY their own row
--         - office admins may edit / insert / delete anyone
--         - unclaimed rows can be claimed by the matching verified email
--           (the onboarding flow)
--     • A BEFORE-UPDATE trigger stops a non-admin from self-promoting
--       (is_admin / role / commission fields revert unless the caller is admin).
--
-- Enforcement lives in the database, so it holds no matter which client issues
-- the write. Idempotent — safe to run more than once.
--
-- ROLLBACK for (B): see the commented block at the bottom.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── A) MAILING LISTS ─────────────────────────────────────────────────────────

-- Allow 'mailing' as a landing_type.
do $$ begin
  alter table mailings drop constraint if exists mailings_landing_type_check;
  alter table mailings add constraint mailings_landing_type_check
    check (landing_type in ('property','valuation','custom','multifamily','mailing'));
exception when others then null; end $$;

-- Allow 'mailing' as a lead source_landing.
do $$ begin
  alter table mailing_leads drop constraint if exists mailing_leads_source_landing_check;
  alter table mailing_leads add constraint mailing_leads_source_landing_check
    check (source_landing in ('property','valuation','custom','multifamily','mailing'));
exception when others then null; end $$;

create table if not exists mailing_subscribers (
  id                uuid primary key default uuid_generate_v4(),
  mailing_id        uuid not null references mailings(id) on delete cascade,
  contact_id        uuid references contacts(id) on delete set null,
  email             text not null,
  name              text,
  phone             text,
  message           text,
  status            text check (status in ('subscribed','unsubscribed')) default 'subscribed',
  consent           boolean default true,
  source            text default 'landing',
  ip_hash           text,
  unsubscribe_token text not null unique default replace(uuid_generate_v4()::text, '-', ''),
  subscribed_at     timestamptz default now(),
  unsubscribed_at   timestamptz,
  created_at        timestamptz default now()
);

-- For installs where the table predates this column.
alter table mailing_subscribers add column if not exists message text;

-- Plain composite unique (emails are stored lower-cased by the API) — also a
-- valid ON CONFLICT target for the subscribe upsert.
create unique index if not exists mailing_subscribers_unique
  on mailing_subscribers(mailing_id, email);
create index if not exists mailing_subscribers_mailing_idx on mailing_subscribers(mailing_id, status);
create index if not exists mailing_subscribers_token_idx    on mailing_subscribers(unsubscribe_token);

alter table mailing_subscribers enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='mailing_subscribers' and policyname='subscribers_authenticated_read') then
    create policy "subscribers_authenticated_read" on mailing_subscribers
      for select to authenticated using (true);
  end if;
end $$;

-- ── B) PROFILE RBAC ──────────────────────────────────────────────────────────

-- Helpers (also defined in migration 0002; repeated idempotently). app_is_admin
-- honors BOTH the explicit is_admin flag and the legacy free-text role.
create or replace function app_current_agent_id()
returns uuid language sql stable security definer set search_path = public as $$
  select id from agents where auth_id = auth.uid() limit 1;
$$;
create or replace function app_is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(bool_or(is_admin or role ilike '%admin%'), false)
  from agents where auth_id = auth.uid();
$$;
grant execute on function app_current_agent_id() to authenticated;
grant execute on function app_is_admin()         to authenticated;

do $$ begin
  drop policy if exists allow_all on agents;

  if not exists (select 1 from pg_policies where tablename='agents' and policyname='agents_public_read') then
    create policy "agents_public_read" on agents for select using (true);
  end if;

  if not exists (select 1 from pg_policies where tablename='agents' and policyname='agents_insert_self_or_admin') then
    create policy "agents_insert_self_or_admin" on agents for insert to authenticated
      with check (app_is_admin() or auth_id = auth.uid());
  end if;

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

  if not exists (select 1 from pg_policies where tablename='agents' and policyname='agents_delete_admin') then
    create policy "agents_delete_admin" on agents for delete to authenticated
      using (app_is_admin());
  end if;
end $$;

create or replace function agents_guard_privileged()
returns trigger language plpgsql as $$
begin
  -- Trusted callers: the service role (server API) and existing office admins.
  if coalesce(auth.jwt() ->> 'role', '') = 'service_role' or app_is_admin() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    -- A brand-new user claiming their seat cannot mint an admin/privileged row.
    new.is_admin := false;
    if new.role is not null and new.role ilike '%admin%' then new.role := 'Agent'; end if;
    return new;
  end if;
  -- UPDATE by a non-admin (incl. their own row): privileged fields are frozen.
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

-- ── ROLLBACK for (B) — reopen agents writes if anything misbehaves ───────────
-- do $$ begin
--   drop trigger if exists agents_guard_privileged_trg on agents;
--   drop policy  if exists agents_public_read            on agents;
--   drop policy  if exists agents_insert_self_or_admin   on agents;
--   drop policy  if exists agents_update_self_or_admin   on agents;
--   drop policy  if exists agents_delete_admin           on agents;
--   create policy allow_all on agents for all using (true) with check (true);
-- end $$;
