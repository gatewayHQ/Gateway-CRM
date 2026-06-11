-- Migration 0013 — Back Office: admin-only commissions + caps in the database
-- ===========================================================================
-- DECISION (2026-06-12, Daniel): the CRM becomes the brokerage back office.
--   • Only admin (office admin / TC) enters and edits commissions.
--   • Each agent sees ONLY their own slice — never a co-agent's split or
--     take-home, even on shared deals. Agents get their numbers through
--     /api/my-earnings (service key), which computes their slice server-side.
--   • Caps move out of browser localStorage into the database, admin-managed:
--     per-agent amount, anniversary-year reset; agents who pre-pay their cap
--     keep using agents.no_brokerage_split.
--
-- WHAT
--   1. agents.cap_amount + agents.cap_anniversary (additive)
--   2. commissions RLS: replace the deal-scoped policy with admin-only.
--      /api/* (service key) bypasses RLS, so My Earnings still works.
--
-- The app ships with this: non-admins stop loading raw commissions entirely
-- and use the My Earnings view instead.
-- ===========================================================================

alter table agents add column if not exists cap_amount      numeric;
alter table agents add column if not exists cap_anniversary date;

comment on column agents.cap_amount      is 'Brokerage cap in dollars; null = no cap configured';
comment on column agents.cap_anniversary is 'Cap year resets on this month/day each year; null = calendar year';

drop policy if exists commissions_deal_scope on commissions;
drop policy if exists commissions_admin_only on commissions;
create policy commissions_admin_only on commissions for all to authenticated
  using (app_is_admin()) with check (app_is_admin());
