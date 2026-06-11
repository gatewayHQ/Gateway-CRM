-- Gateway CRM — Back Office milestone database changes
-- Paste into Supabase Dashboard → SQL Editor → Run. Safe to re-run.
--
-- 1. Per-agent caps move into the database (admin-managed): cap_amount in
--    dollars, cap_anniversary for anniversary-year resets (null = calendar
--    year). Agents who pre-pay their cap keep using no_brokerage_split.
-- 2. Commissions become ADMIN-ONLY at the database level: only the office
--    admin/TC can read or write commission rows. Agents get their own slice
--    (and nothing else) through /api/my-earnings, which runs on the service
--    key. Apply BEFORE/with the Back Office app deploy — the new app stops
--    loading raw commissions for non-admins at the same moment.
--
-- Rollback (restores the previous deal-scoped visibility):
--   drop policy if exists commissions_admin_only on commissions;
--   create policy commissions_deal_scope on commissions for all to authenticated
--     using (deal_id in (select app_visible_deal_ids()))
--     with check (deal_id in (select app_visible_deal_ids()));

alter table agents add column if not exists cap_amount      numeric;
alter table agents add column if not exists cap_anniversary date;

drop policy if exists commissions_deal_scope on commissions;
drop policy if exists commissions_admin_only on commissions;
create policy commissions_admin_only on commissions for all to authenticated
  using (app_is_admin()) with check (app_is_admin());
