-- ═════════════════════════════════════════════════════════════════════════════
-- 0024 — Agent-settable compensation on the deal
--
-- WHY
--   Until now the ONLY place a deal's commission could be priced was the
--   commissions row, which is admin-only (migration 0013). So the office had to
--   open every single transaction just to record "Daniel's cut on this one is
--   3%" / "this BOV is a $2,500 flat fee". The agent already knows that number
--   when they create the deal.
--
-- WHAT
--   Three additive columns on `deals`:
--     • agent_comp_type      'rate' | 'flat'  — which of the two is in play
--     • agent_comp_rate_pct  numeric 0–100    — commission rate, when 'rate'
--     • agent_comp_flat      numeric ≥ 0      — flat fee in dollars, when 'flat'
--   The two amounts are mutually exclusive: a CHECK constraint requires the
--   amount matching `agent_comp_type` to be present, and the app only ever
--   reads that one (src/lib/commission.js → dealCompensation).
--
--   Plus a BEFORE-UPDATE trigger (`deals_guard_agent_comp`) so the fields are
--   write-once for agents: the deal's own agent may fill them in while they are
--   still empty (deal creation, or backfilling a pre-0024 deal), and only an
--   office admin (or the server's service key) may CHANGE a value that is
--   already set. Co-listed agents and sharing team peers — who can otherwise
--   edit the deal — can never touch someone else's compensation.
--
-- PRECEDENCE (unchanged commission engine contract)
--   commissions row (admin) > deals.agent_comp_* (agent) > firm default 3%.
--   Existing deals have all three columns NULL, so every current number stays
--   byte-for-byte identical until an agent sets a value.
--
-- SAFETY: additive only — no data is rewritten, nothing is dropped. Idempotent.
-- ROLLBACK: see the commented block at the bottom.
-- ═════════════════════════════════════════════════════════════════════════════

-- 1. Columns -----------------------------------------------------------------
alter table deals add column if not exists agent_comp_type     text;
alter table deals add column if not exists agent_comp_rate_pct numeric;
alter table deals add column if not exists agent_comp_flat     numeric;

comment on column deals.agent_comp_type is
  'How the agent priced their compensation on this deal: ''rate'' (percentage of value) or ''flat'' (fixed fee). NULL = never set (pre-0024 deals) — the firm default rate applies.';
comment on column deals.agent_comp_rate_pct is
  'Commission rate (%) the agent set at deal creation. Read only when agent_comp_type = ''rate''.';
comment on column deals.agent_comp_flat is
  'Flat fee ($) the agent set at deal creation. Read only when agent_comp_type = ''flat''.';

-- 2. Guards ------------------------------------------------------------------
alter table deals drop constraint if exists deals_agent_comp_type_check;
alter table deals add  constraint deals_agent_comp_type_check
  check (agent_comp_type is null or agent_comp_type in ('rate','flat'));

alter table deals drop constraint if exists deals_agent_comp_rate_range;
alter table deals add  constraint deals_agent_comp_rate_range
  check (agent_comp_rate_pct is null or (agent_comp_rate_pct >= 0 and agent_comp_rate_pct <= 100));

alter table deals drop constraint if exists deals_agent_comp_flat_nonneg;
alter table deals add  constraint deals_agent_comp_flat_nonneg
  check (agent_comp_flat is null or agent_comp_flat >= 0);

-- The chosen type must carry its amount — this is what keeps rate/flat
-- mutually exclusive rather than "whichever the client happened to send".
alter table deals drop constraint if exists deals_agent_comp_amount_present;
alter table deals add  constraint deals_agent_comp_amount_present
  check (
    agent_comp_type is null
    or (agent_comp_type = 'rate' and agent_comp_rate_pct is not null)
    or (agent_comp_type = 'flat' and agent_comp_flat     is not null)
  );

-- 3. Write-once-for-agents trigger -------------------------------------------
-- Mirrors agents_guard_privileged() from 0023: enforcement lives in the
-- database so it holds no matter which client issues the write.

-- Helpers (also defined in migrations 0002 / 0023; repeated idempotently so
-- this file stands alone on a database that hasn't had them yet).
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

create or replace function deals_guard_agent_comp()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  was_set boolean;
begin
  -- Trusted callers: the server API (service key) and office admins, who keep
  -- full control of compensation, splits and overrides.
  if coalesce(auth.jwt() ->> 'role', '') = 'service_role' or app_is_admin() then
    return new;
  end if;

  was_set := old.agent_comp_type is not null;

  -- The deal's own agent may set the fields while they are still empty
  -- (creation, or filling in a deal that predates this migration). NULL
  -- ownership never matches, so an unassigned deal stays admin-priced.
  if not was_set and old.agent_id = app_current_agent_id() then
    return new;
  end if;

  -- Everyone else — co-listed agents, sharing team peers, and the owner once
  -- the value exists — leaves compensation exactly as it was.
  new.agent_comp_type     := old.agent_comp_type;
  new.agent_comp_rate_pct := old.agent_comp_rate_pct;
  new.agent_comp_flat     := old.agent_comp_flat;
  return new;
end $$;

drop trigger if exists deals_guard_agent_comp_trg on deals;
create trigger deals_guard_agent_comp_trg
  before update on deals
  for each row execute function deals_guard_agent_comp();

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- Dropping the trigger alone reopens the fields to any agent who can edit the
-- deal; dropping the columns discards agent-entered compensation (the engine
-- falls back to the firm default rate, and admin-saved commission rows are
-- unaffected).
--
-- drop trigger  if exists deals_guard_agent_comp_trg on deals;
-- drop function if exists deals_guard_agent_comp();
-- alter table deals drop constraint if exists deals_agent_comp_amount_present;
-- alter table deals drop constraint if exists deals_agent_comp_flat_nonneg;
-- alter table deals drop constraint if exists deals_agent_comp_rate_range;
-- alter table deals drop constraint if exists deals_agent_comp_type_check;
-- alter table deals drop column if exists agent_comp_flat;
-- alter table deals drop column if exists agent_comp_rate_pct;
-- alter table deals drop column if exists agent_comp_type;
