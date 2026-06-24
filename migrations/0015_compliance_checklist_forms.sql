-- ─────────────────────────────────────────────────────────────────────────────
-- 0015 — Compliance: admin-only checklist + form library categories
--
-- 1. form_packets.category — separates official state packets from agent-only
--    resources (training docs, scripts, marketing collateral) in the Form
--    Library tab. Existing rows default to 'state_packet'.
--    State + transaction_type stay required for state packets, optional for
--    agent_resource rows (enforced in app code).
--
-- 2. transaction_steps RLS — agents may READ the checklist but only admins
--    (agents.is_admin = true OR agents.role ilike '%admin%') may add, edit,
--    delete, or check off items. Required so a State audit sees a checklist
--    that only the transaction coordinator can mark complete.
-- ─────────────────────────────────────────────────────────────────────────────

alter table form_packets
  add column if not exists category text not null default 'state_packet'
  check (category in ('state_packet','agent_resource'));

create index if not exists idx_form_packets_category on form_packets(category);

-- ── transaction_steps: admin-only writes ─────────────────────────────────────
drop policy if exists transaction_steps_deal_scope on transaction_steps;

create policy transaction_steps_select on transaction_steps
  for select to authenticated
  using (deal_id in (select app_visible_deal_ids()));

create policy transaction_steps_admin_write on transaction_steps
  for insert to authenticated
  with check (app_is_admin() and deal_id in (select app_visible_deal_ids()));

create policy transaction_steps_admin_update on transaction_steps
  for update to authenticated
  using      (app_is_admin() and deal_id in (select app_visible_deal_ids()))
  with check (app_is_admin() and deal_id in (select app_visible_deal_ids()));

create policy transaction_steps_admin_delete on transaction_steps
  for delete to authenticated
  using (app_is_admin() and deal_id in (select app_visible_deal_ids()));
