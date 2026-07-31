-- Migration 0024 — Agent-entered commission on the deal (percentage or flat fee)
-- ===========================================================================
-- WHY
--   Commission rows (`commissions`) are ADMIN-ONLY at the database level
--   (migration 0013 / the 2026-06-12 back-office decision): each row holds every
--   participant's split, so an agent cannot read or write one. That left the
--   agent with nowhere to record the single number they actually negotiated —
--   "what are we charging this client?" — and the back office had to chase it
--   down by phone before it could build the split.
--
--   This migration gives that number a home the ASSIGNED AGENT owns, on `deals`
--   (which agents already read/write under the 0011 scoping policy), entered
--   from the deal's Details tab. It is the INPUT to the back-office split, not
--   the split itself: no take-home, no per-agent percentage, nothing private.
--
-- WHAT
--   1. `deals.commission_type`  — 'percent' | 'flat'  (which field below is live)
--   2. `deals.commission_pct`   — commission as a % of the deal value
--   3. `deals.commission_flat`  — commission as a flat dollar fee
--
--   NOTE ON `commission_pct`: the live production `deals` table has carried a
--   legacy `commission_pct numeric` column since before this codebase (see
--   `migrations/production/README.md`), and `src/lib/services/boldsign.js`
--   already prefills listing agreements from it. `add column if not exists`
--   therefore ADOPTS the existing column in production rather than creating it,
--   and the backfill in step 4 lights up whatever values are already in there.
--   Fresh installs from `src/lib/schema.sql` get all three columns outright.
--
-- HOW THE APP READS IT
--   `src/lib/commission.js` resolves a deal's gross in this order:
--     1. commissions.sides      (the back office's explicit entry — wins)
--     2. deals.commission_*     (this migration — the agent's entry)
--     3. commissions.gross_pct  (the legacy scalar)
--     4. 3.0%                   (nothing entered anywhere)
--   So an agent's entry drives every report until an admin overrides it in the
--   Commission editor, and an already-structured deal is untouched.
--
-- SAFETY
--   Additive columns + named CHECK constraints, all idempotent. The only data
--   written is the step-3 clamp of out-of-range legacy values (normally zero
--   rows — the preview SELECTs below show what would change) and the step-4
--   backfill of `commission_type`, which writes only where it is null.
--
--     select id, title, commission_pct from deals
--      where commission_pct is not null and (commission_pct < 0 or commission_pct > 100);
--     select id, title, commission_pct from deals where commission_pct > 0;
-- ===========================================================================

-- 1) Columns ------------------------------------------------------------------
alter table deals add column if not exists commission_type  text;
alter table deals add column if not exists commission_pct   numeric;
alter table deals add column if not exists commission_flat  numeric;

comment on column deals.commission_type is
  'Which commission field is live: ''percent'' (commission_pct) or ''flat'' (commission_flat). Set by the assigned agent on the deal''s Details tab.';
comment on column deals.commission_pct is
  'Commission as a percentage of deals.value, as negotiated by the assigned agent. Also prefills the commission_pct token on BoldSign listing agreements.';
comment on column deals.commission_flat is
  'Commission as a flat dollar fee, as negotiated by the assigned agent. Used instead of commission_pct when commission_type = ''flat''.';

-- 2) Default for new rows -----------------------------------------------------
-- Percentage is the overwhelmingly common arrangement, so a new deal opens on
-- it. Existing rows are handled by the step-4 backfill.
alter table deals alter column commission_type set default 'percent';

-- 3) Cleanup, so the step-5 constraints can never fail on legacy data ---------
update deals set commission_pct = greatest(0, least(100, commission_pct))
  where commission_pct is not null and (commission_pct < 0 or commission_pct > 100);

update deals set commission_flat = null
  where commission_flat is not null and commission_flat < 0;

-- 4) Backfill the type flag ---------------------------------------------------
-- Any row already carrying a legacy percentage is, by definition, a percentage
-- deal — this is what makes those values start showing up in the UI and in the
-- commission engine immediately.
update deals set commission_type = 'percent'
  where commission_type is null;

-- 5) Guards -------------------------------------------------------------------
alter table deals drop constraint if exists deals_commission_type_check;
alter table deals add  constraint deals_commission_type_check
  check (commission_type is null or commission_type in ('percent', 'flat'));

alter table deals drop constraint if exists deals_commission_pct_range;
alter table deals add  constraint deals_commission_pct_range
  check (commission_pct is null or (commission_pct >= 0 and commission_pct <= 100));

alter table deals drop constraint if exists deals_commission_flat_nonneg;
alter table deals add  constraint deals_commission_flat_nonneg
  check (commission_flat is null or commission_flat >= 0);

-- 6) Doc refresh: a back-office commission SIDE can now also be priced as a flat
-- fee (`flat` > 0 replaces `rate_pct`), so an agent's flat-fee deal survives an
-- admin edit in the Commission editor. No schema change — jsonb already held it.
comment on column commissions.sides is
  'Array of { key, label, rate_pct, flat, referral_pct, referral_flat }. One entry for a single-side deal, two when the brokerage represents both buyer and seller. flat > 0 prices the side as a flat dollar fee instead of a percentage of the sale price. Empty = use legacy flat columns.';


-- ───────────────────────────────────────────────────────────────────────────
-- VERIFICATION (run after applying)
-- ───────────────────────────────────────────────────────────────────────────
-- Every deal has a type, and no value is out of range:
--   select commission_type, count(*) from deals group by 1;
--   select count(*) from deals
--    where (commission_pct  is not null and (commission_pct < 0 or commission_pct > 100))
--       or (commission_flat is not null and commission_flat < 0);   -- expect 0
--
-- As a normal (non-admin) agent's JWT — the whole point of this migration is
-- that this write succeeds where a `commissions` write would be rejected:
--   update deals set commission_type = 'flat', commission_flat = 12500
--    where id = '<a deal you own>';                                 -- expect 1 row


-- ───────────────────────────────────────────────────────────────────────────
-- ROLLBACK
-- ───────────────────────────────────────────────────────────────────────────
-- Drops only what this migration added. `commission_pct` is deliberately NOT
-- dropped — it predates this migration in production and BoldSign prefill
-- depends on it.
--
-- alter table deals drop constraint if exists deals_commission_type_check;
-- alter table deals drop constraint if exists deals_commission_pct_range;
-- alter table deals drop constraint if exists deals_commission_flat_nonneg;
-- alter table deals alter column commission_type drop default;
-- alter table deals drop column if exists commission_type;
-- alter table deals drop column if exists commission_flat;
