-- Migration 0061 — Office-confirmed cap, and each agent's own transaction fee
-- ===========================================================================
-- WHY
--   An agent keeps 100% of their commission once their brokerage cap is met,
--   but only when the office says so: the cap tracker can show an agent at or
--   past their cap, and it is the admin who confirms it. Until now there was
--   nowhere to record that, so the CRM kept charging the split and the office
--   had to correct every deal in that stretch by hand.
--
-- WHAT
--   1. agents.cap_confirmed_at (date, additive). The day the office confirmed
--      the cap. The engine (src/lib/commission.js, capCovers) pays the agent
--      100% — less the flat transaction fee, which is charged on top of the cap
--      — on every deal counting on or after that date, up to the agent's next
--      cap anniversary (Jan 1 without one), when the cap year resets on its own.
--   2. agents.transaction_fee (numeric, additive). The agent's per-deal
--      transaction fee from their contract — new agents are typically $50, the
--      standard is $100, and it varies by contract. Null = the office standard
--      ($100, src/lib/commission.js DEFAULTS.TRANSACTION_FEE). An agent pays it
--      on their share of each deal: their full fee on a solo deal, half of it
--      on a 50/50 co-listing — the same shape as the old even split of $100.
--   3. agents_guard_privileged(): both new columns are frozen for non-admins,
--      exactly like cap_amount and the split fields — an agent cannot confirm
--      their own cap or set their own fee. Admins and the service role (the
--      profile API) pass through.
--
-- SAFE TO RE-RUN. Additive; the function is replaced in place.
-- ===========================================================================

alter table agents add column if not exists cap_confirmed_at date;
comment on column agents.cap_confirmed_at is
  'Office confirmed the brokerage cap is met: agent keeps 100% from this date to the next cap anniversary';

alter table agents add column if not exists transaction_fee numeric
  check (transaction_fee is null or transaction_fee >= 0);
comment on column agents.transaction_fee is
  'Per-deal transaction fee from the agent''s contract (e.g. 50 for new agents); null = office standard (100)';

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
  new.cap_confirmed_at   := old.cap_confirmed_at;
  new.transaction_fee    := old.transaction_fee;
  return new;
end $$;

drop trigger if exists agents_guard_privileged_trg on agents;
create trigger agents_guard_privileged_trg
  before insert or update on agents
  for each row execute function agents_guard_privileged();
