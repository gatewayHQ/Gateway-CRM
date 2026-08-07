-- ─────────────────────────────────────────────────────────────────────────────
-- Gateway CRM — Restore office-admin access for Daniel  (2026-07-23)
-- Paste into Supabase Dashboard → SQL Editor → Run. Safe to re-run (idempotent).
--
-- Sets agents.is_admin = true for Daniel's row. app_is_admin() honors the flag
-- (is_admin OR role ilike '%admin%'), so the flag alone restores full admin
-- access — office-wide deals/docs/commissions and the admin-only settings.
--
-- WHY THE TRIGGER DANCE: migration 0023 (2026-07-17) added
-- agents_guard_privileged_trg, which freezes is_admin / role / commission fields
-- on any write UNLESS the caller is service_role or an existing admin. A SQL
-- Editor session is neither (auth.jwt() is null, auth.uid() is null → not admin),
-- so a plain UPDATE would be silently reverted. We disable the guard for this
-- one statement, then re-enable it — the table is never left unguarded.
-- ─────────────────────────────────────────────────────────────────────────────

alter table agents disable trigger agents_guard_privileged_trg;

update agents
   set is_admin = true
 where lower(email) = lower('daniel@gatewayreadvisors.com');

alter table agents enable trigger agents_guard_privileged_trg;

-- Verify (should return one row with is_admin = t):
select id, name, email, role, is_admin
  from agents
 where lower(email) = lower('daniel@gatewayreadvisors.com');
