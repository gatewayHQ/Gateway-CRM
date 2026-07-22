-- ─────────────────────────────────────────────────────────────────────────────
-- 0027 — Round-2 audit remediation: anon exposure, admin flag, cap-year date,
--        commission index, integrations lockdown
--
-- Fixes (see the round-2 audit):
--   SEC-1  Six allow_all policies applied to PUBLIC (anon), leaking lead PII.
--   SEC-4  integrations.config (Mailchimp key) readable by every agent.
--   DATA-2 app_is_admin() matched role ilike '%admin%' → "Administrative
--          Assistant" got full admin. Trust the is_admin flag only.
--   DATA-1 No closed_at column → commission cap-year keyed off updated_at.
--   DATA-H1 No index for the commissions.participants scan in app_visible_deal_ids.
--
-- Idempotent. Depends on app_is_admin / app_current_agent_id (0011/schema.sql).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── SEC-1: close anonymous access ────────────────────────────────────────────
-- templates & teams: shared across agents, but only for LOGGED-IN users.
drop policy if exists allow_all on templates;
create policy templates_auth on templates for all to authenticated using (true) with check (true);

drop policy if exists allow_all on teams;
create policy teams_auth on teams for all to authenticated using (true) with check (true);

-- mailings: the PUBLIC landing pages read a campaign by id with the anon key,
-- so SELECT stays public — but writes only ever happen via the service-key API
-- (which bypasses RLS), so no authenticated write policy is granted (closes the
-- anonymous insert/update/DELETE hole).
drop policy if exists allow_all on mailings;
create policy mailings_public_read on mailings for select using (true);

-- Lead/recipient/scan PII: only ever touched through the service-key campaigns
-- API, never read directly by the browser. Restrict to authenticated so the
-- public anon key can no longer dump names/emails/phones/addresses.
drop policy if exists allow_all on mailing_recipients;
create policy mailing_recipients_auth on mailing_recipients for all to authenticated using (true) with check (true);
drop policy if exists allow_all on mailing_scans;
create policy mailing_scans_auth on mailing_scans for all to authenticated using (true) with check (true);
drop policy if exists allow_all on mailing_leads;
create policy mailing_leads_auth on mailing_leads for all to authenticated using (true) with check (true);
-- Follow-up hardening (not done here): agent-scope mailing_leads/recipients so
-- one agent can't read another's leads directly. The API already filters by
-- verified agent; this would add defense in depth.

-- ── SEC-4: integrations holds the Mailchimp key → admins only ─────────────────
-- (Non-admins lose direct read of the connection config; the secured
-- /api/mailchimp proxy still serves actions. Behavior change — intended.)
drop policy if exists allow_all on integrations;
create policy integrations_admin on integrations for all to authenticated
  using (app_is_admin()) with check (app_is_admin());

-- ── DATA-2: admin is the flag, not a substring of a free-text role ────────────
-- Safety backfill: promote clearly-admin EXACT roles (no substrings) so we never
-- lock a real admin out; never auto-demotes.
update agents set is_admin = true
where is_admin is distinct from true
  and lower(trim(role)) in ('admin','administrator','office admin','office manager',
                            'broker','owner','transaction coordinator');

create or replace function app_is_admin()
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(bool_or(is_admin), false) from agents where auth_id = auth.uid();
$$;
-- REVIEW after running: confirm this list is exactly your real admins.
--   select id, name, email, role, is_admin from agents where is_admin = true order by name;
-- Set/clear is_admin explicitly for anyone mis-flagged.

-- ── DATA-1: real close date for commission cap-year accounting ────────────────
alter table deals add column if not exists closed_at timestamptz;

create or replace function deals_set_closed_at()
returns trigger language plpgsql as $$
begin
  if new.stage = 'closed' and (tg_op = 'INSERT' or old.stage is distinct from 'closed') then
    new.closed_at := now();
  elsif new.stage <> 'closed' then
    new.closed_at := null;   -- re-opened deal leaves the closed cohort
  end if;
  return new;
end $$;
drop trigger if exists deals_set_closed_at_trg on deals;
create trigger deals_set_closed_at_trg
  before insert or update on deals
  for each row execute function deals_set_closed_at();

-- Backfill existing closed deals with the best available proxy (their last-edit
-- time). One-time; new closes get the accurate timestamp from the trigger.
update deals set closed_at = updated_at where stage = 'closed' and closed_at is null;

-- ── DATA-H1: index the participants scan that every scoped read hits ──────────
create index if not exists idx_commissions_participants
  on commissions using gin (participants jsonb_path_ops);
