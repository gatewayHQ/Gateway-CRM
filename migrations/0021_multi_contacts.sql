-- ═════════════════════════════════════════════════════════════════════════════
-- 0021 — Multi-contact deals & properties
--
-- New junction tables `deal_contacts` and `property_contacts` so a deal or
-- property can carry more than one contact (husband & wife, co-buyers,
-- co-owners). `deals.contact_id` / `properties.linked_contact_id` are unchanged
-- and remain the PRIMARY contact — the junction rows hold the additional ones,
-- so every existing feature that reads the single contact keeps working.
--
-- Changes behavior? No — additive. Safe to run anytime; idempotent.
-- Run BEFORE (or with) the app deploy that adds the "Additional Contacts"
-- fields — until it runs, the app degrades gracefully (the new fields simply
-- don't persist and the selects return empty).
--
-- ⚠ LEGACY NOTE: the production diagnostic (migrations/production/README.md)
-- found a pre-existing `deal_contacts` table of UNKNOWN shape. `create table if
-- not exists` will NOT alter an existing table, so before deploying, verify the
-- live `deal_contacts` has columns (deal_id uuid, contact_id uuid) and a
-- unique(deal_id, contact_id). If it differs, reconcile it by hand — the app
-- inserts exactly { deal_id, contact_id } and relies on the unique constraint
-- for idempotent re-links. `property_contacts` is new, so no such concern.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── deal_contacts — additional contacts on a deal ───────────────────────────
create table if not exists deal_contacts (
  id         uuid primary key default uuid_generate_v4(),
  deal_id    uuid not null references deals(id)    on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  created_at timestamptz default now(),
  unique (deal_id, contact_id)
);
create index if not exists idx_deal_contacts_deal    on deal_contacts(deal_id);
create index if not exists idx_deal_contacts_contact on deal_contacts(contact_id);

alter table deal_contacts enable row level security;

-- Scoped policy: link rows follow the deal (same model as transaction_steps,
-- migration 0011). If this database predates 0011 (no app_visible_deal_ids
-- helper), fall back to allow_all — matching the pre-0011 posture of every
-- other table; re-running this file after 0011 upgrades it to the scoped form.
do $$ begin
  if exists (select 1 from pg_proc where proname = 'app_visible_deal_ids') then
    drop policy if exists deal_contacts_allow_all  on deal_contacts;
    drop policy if exists deal_contacts_deal_scope on deal_contacts;
    create policy deal_contacts_deal_scope on deal_contacts for all to authenticated
      using      (deal_id in (select app_visible_deal_ids()))
      with check (deal_id in (select app_visible_deal_ids()));
  else
    if not exists (select 1 from pg_policies where tablename='deal_contacts' and policyname='deal_contacts_allow_all') then
      create policy deal_contacts_allow_all on deal_contacts for all to authenticated
        using (true) with check (true);
    end if;
  end if;
end $$;

-- ── property_contacts — additional contacts on a property ───────────────────
create table if not exists property_contacts (
  id          uuid primary key default uuid_generate_v4(),
  property_id uuid not null references properties(id) on delete cascade,
  contact_id  uuid not null references contacts(id)   on delete cascade,
  created_at  timestamptz default now(),
  unique (property_id, contact_id)
);
create index if not exists idx_property_contacts_property on property_contacts(property_id);
create index if not exists idx_property_contacts_contact  on property_contacts(contact_id);

-- properties themselves are allow_all (public landing page reads) — the link
-- rows match that posture.
alter table property_contacts enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='property_contacts' and policyname='allow_all') then
    create policy "allow_all" on property_contacts for all to authenticated using (true) with check (true);
  end if;
end $$;
