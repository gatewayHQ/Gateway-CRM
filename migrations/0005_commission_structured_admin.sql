-- ============================================================================
-- 0005  Structured commissions + per-agent split defaults + admin role flag
-- ----------------------------------------------------------------------------
-- Idempotent. Safe to run on production at any time — only ADDS columns, never
-- drops or rewrites existing data. Legacy commission rows keep working because
-- the app upgrades the old flat columns on the fly (see src/lib/commission.js).
--
-- Three things ship here:
--   1. commissions.sides / commissions.participants  — the new complex model
--      (two-sided deals, per-side referrals, per-agent brokerage arrangements)
--   2. agents.default_split_pct / agents.no_brokerage_split  — each agent's own
--      default split so the editor pre-fills correctly (Nic keeps 100%, Daniel
--      splits with the house)
--   3. agents.is_admin  — explicit office-admin flag (no more matching the free
--      text role string); back-filled from any role containing 'admin'
-- ============================================================================

-- 1. Structured commission columns -------------------------------------------
alter table commissions add column if not exists sides        jsonb not null default '[]';
alter table commissions add column if not exists participants jsonb not null default '[]';

comment on column commissions.sides is
  'Array of { key, label, rate_pct, referral_pct, referral_flat }. One entry for a single-side deal, two when the brokerage represents both buyer and seller. Empty = use legacy flat columns.';
comment on column commissions.participants is
  'Array of { id, agent_id, name, role, allocation_pct, split_pct, no_split, fee }. Each agent on the deal with their own brokerage split. fee = per-agent override of the flat transaction-fee share (0 = use the even split of commissions.transaction_fee). Empty = use legacy flat columns.';

-- 2. Per-agent commission defaults -------------------------------------------
alter table agents add column if not exists default_split_pct  numeric default 70;
alter table agents add column if not exists no_brokerage_split boolean default false;

comment on column agents.default_split_pct is
  'Agent''s default share (%) of their commission allocation; the brokerage keeps the rest. Used to pre-fill the commission editor.';
comment on column agents.no_brokerage_split is
  'When true, this agent keeps 100%% of their allocation (capped out / no split). The editor pre-selects "keeps 100%%" for them.';

-- 3. Explicit admin flag ------------------------------------------------------
alter table agents add column if not exists is_admin boolean default false;

comment on column agents.is_admin is
  'Office admin: can view every agent''s deals, documents, signatures and commissions. Replaces fragile role-string matching.';

-- Back-fill: anyone whose free-text role mentioned "admin" becomes is_admin.
update agents set is_admin = true
  where is_admin is distinct from true
    and role ilike '%admin%';
