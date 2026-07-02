-- ─────────────────────────────────────────────────────────────────────────────
-- 0017 — Campaign landing-page redesign: new template types
--
-- Adds two landing types to the QR campaign system:
--   'agent' — agent profile / personal-brand page
--   'deal'  — off-market opportunity teaser with gated OM request
--
-- landing_type / source_landing live in CHECK constraints, so both are
-- re-created with the expanded set (existing values all remain valid).
-- ─────────────────────────────────────────────────────────────────────────────

alter table mailings drop constraint if exists mailings_landing_type_check;
alter table mailings add constraint mailings_landing_type_check
  check (landing_type in ('property','valuation','custom','multifamily','agent','deal'));

alter table mailing_leads drop constraint if exists mailing_leads_source_landing_check;
alter table mailing_leads add constraint mailing_leads_source_landing_check
  check (source_landing in ('property','valuation','custom','multifamily','agent','deal'));
