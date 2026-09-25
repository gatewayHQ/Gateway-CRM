-- Migration 0057 — A row you may create, you may read back
-- ===========================================================================
-- THE REPORT
--   Adding a contact from the Contacts drawer fails with
--       new row violates row-level security policy for table "contacts"
--   for any agent who is not an office admin — even when the contact is
--   assigned to themselves. Nothing is saved.
--
-- ═══ WHY ═══════════════════════════════════════════════════════════════════
--
-- The app saves with `.insert([row]).select()`, i.e. INSERT ... RETURNING.
-- When an INSERT returns its row, Postgres checks the new row against the
-- policy's WITH CHECK *and* its USING (the read rule) — you may not get back a
-- row you would not be allowed to read.
--
-- Migration 0055 changed the contacts read rule to
--
--     using (app_is_admin() or id in (select app_visible_contact_ids()))
--
-- `app_visible_contact_ids()` answers by SELECTING FROM contacts. It is a
-- STABLE function, so it reads the snapshot the statement started with — which
-- cannot contain the row the statement is inserting. The new id is never in
-- the list, the read rule fails, and the whole INSERT is rolled back. WITH
-- CHECK passed; the error message does not say which half failed.
--
-- Before 0055 the read rule was row-local
-- (`assigned_agent_id in (select app_visible_agent_ids('contacts'))`), so it
-- could judge a row that did not exist yet. Admins pass on `app_is_admin()`
-- alone, which is why only non-admin agents see this. Plain inserts with no
-- RETURNING (CSV import) were never affected.
--
-- `deals_agent_scope` has had the same shape since 0011 —
-- `using (id in (select app_visible_deal_ids()))`, with not even an admin arm —
-- so on the reference schema starting a deal (Properties.jsx, Pipeline.jsx,
-- both `.insert().select()`) fails the same way for everyone.
--
-- ═══ THE FIX ═══════════════════════════════════════════════════════════════
--
-- Put the row-local arms that WITH CHECK already uses for new rows in front of
-- the lookup in USING. Every one of them is already an arm of
-- app_visible_contact_ids() / app_visible_deal_ids(), so for any row that
-- exists, who can see it is EXACTLY what it was — the only rows that change
-- are rows being inserted, which can now be read back by the agent who was
-- allowed to insert them. WITH CHECK is unchanged.
--
-- Idempotent. Apply after 0055.
-- ===========================================================================

drop policy if exists contacts_agent_scope on contacts;
create policy contacts_agent_scope on contacts for all to authenticated
  using (
    app_is_admin()
    or assigned_agent_id in (select app_visible_agent_ids('contacts'))
    or id in (select app_visible_contact_ids())
  )
  with check (
    app_is_admin()
    or assigned_agent_id in (select app_visible_agent_ids('contacts'))
    or id in (select app_visible_contact_ids())
  );

drop policy if exists deals_agent_scope on deals;
create policy deals_agent_scope on deals for all to authenticated
  using (
    app_is_admin()
    or agent_id in (select app_visible_agent_ids('deals'))
    or id in (select app_visible_deal_ids())
  )
  with check (
    app_is_admin()
    or agent_id in (select app_visible_agent_ids('deals'))
    or id in (select app_visible_deal_ids())
  );
