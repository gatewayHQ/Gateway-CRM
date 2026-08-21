-- ═════════════════════════════════════════════════════════════════════════════
-- 0040 — Deal sides (buyer / seller / both) & shared pricing history
--
-- Two changes that belong together because they are both about a deal and its
-- property describing the SAME transaction without contradicting each other.
--
-- 1. BOTH SIDES OF THE TABLE.
--    `comp_data.transaction_type` said which side we represent, and a deal had
--    exactly one client side: `deals.contact_id` plus `deal_contacts`. When the
--    same agent represents buyer AND seller, that single set has to hold two
--    unrelated groups of people — so editing the buyer overwrote the seller,
--    and a signature packet could not tell which party a name belonged to.
--
--    So: `deals.buyer_contact_id` / `deals.seller_contact_id` hold the PRIMARY
--    contact for each side, and `deal_contacts.side` tags every additional
--    contact with the side it sits on. `deals.contact_id` is unchanged and
--    stays the primary contact of the represented side — every existing reader
--    (BoldSign prefill, portal, mass email, the deal card) keeps working
--    untouched, which is why it is kept rather than replaced.
--
-- 2. ONE PRICING HISTORY, TWO SURFACES.
--    A price lived twice: `deals.value` and `properties.list_price`, edited
--    from two drawers, with history recorded as a jsonb array on the property
--    only. Editing the deal left the property stale (and unrecorded), and the
--    jsonb entries carried a date but never an actor.
--
--    So: `pricing_history` is the canonical, append-only log, keyed to the
--    property and (when the edit came from a deal) the deal, with the actor on
--    every row. `properties.price_history` is still written as a mirror so the
--    public landing page, the listing card's "price reduced" badge, and any
--    database that has not been migrated yet keep reading what they always did.
--
-- Additive and idempotent. The backfills below are the only data writes; each
-- one is a no-op on a second run.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─── properties: columns the app has always written ──────────────────────────
-- `price_history` and `comps` exist in the production database but were never
-- declared in schema.sql (drift — the property drawer has written both since
-- before the numbered migrations). Declared here so a database rebuilt from the
-- migration chain matches production and the Pricing History tab has somewhere
-- to mirror to.
alter table properties add column if not exists price_history jsonb not null default '[]'::jsonb;
alter table properties add column if not exists comps         jsonb not null default '[]'::jsonb;

-- ─── deals: a primary contact per side ───────────────────────────────────────
alter table deals add column if not exists buyer_contact_id  uuid references contacts(id) on delete set null;
alter table deals add column if not exists seller_contact_id uuid references contacts(id) on delete set null;

create index if not exists idx_deals_buyer_contact  on deals(buyer_contact_id);
create index if not exists idx_deals_seller_contact on deals(seller_contact_id);

-- ─── deal_contacts: which side an additional contact is on ───────────────────
-- Nullable on purpose. A null means "recorded before sides existed", and the
-- app reads it as the side the deal represents (src/lib/dealPeople.js) rather
-- than dropping the person off the deal. The backfill below fills in what it
-- can; anything it cannot attribute keeps working as it did.
--
-- The unique(deal_id, contact_id) constraint from 0021 is deliberately left
-- alone: one person belongs to one side of one deal, and widening the key to
-- include `side` would let the same contact be filed as buyer AND seller.
alter table deal_contacts add column if not exists side text;
alter table deal_contacts drop constraint if exists deal_contacts_side_check;
alter table deal_contacts add  constraint deal_contacts_side_check
  check (side is null or side in ('buyer','seller'));

-- ─── pricing_history — the canonical price log ───────────────────────────────
create table if not exists pricing_history (
  id             uuid primary key default gen_random_uuid(),
  -- The property is the anchor: a price belongs to a building, and every deal
  -- on that building shares the same history. Nullable only so a price change
  -- on a deal with no property linked yet is still recorded.
  property_id    uuid references properties(id) on delete cascade,
  -- The deal the edit came THROUGH, when it came from a deal drawer. `on delete
  -- set null` rather than cascade: the price change is property history and must
  -- outlive the deal it was typed on.
  deal_id        uuid references deals(id) on delete set null,
  price          numeric constraint pricing_history_price_nonneg
                   check (price is null or price >= 0),
  previous_price numeric constraint pricing_history_previous_nonneg
                   check (previous_price is null or previous_price >= 0),
  -- Which surface the agent typed it on ('deal' | 'property'), or 'import' for
  -- rows lifted out of the old properties.price_history jsonb by the backfill
  -- below. Free text with a CHECK so the set is asserted but cheap to widen.
  source         text not null default 'property' constraint pricing_history_source_check
                   check (source in ('deal','property','import','system')),
  changed_by     uuid references agents(id) on delete set null,
  -- The actor's name AT THE TIME, denormalized. An audit line must still read
  -- correctly after the agent leaves the brokerage and their row is gone.
  changed_by_name text,
  note           text,
  created_at     timestamptz not null default now()
);

create index if not exists idx_pricing_history_property on pricing_history(property_id, created_at desc);
create index if not exists idx_pricing_history_deal     on pricing_history(deal_id, created_at desc);

-- `properties` is allow_all_authenticated in RLS (the public landing page reads
-- it through a service-role endpoint, and property scoping lives in
-- src/lib/services/properties.js). Its price log matches that posture.
alter table pricing_history enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='pricing_history' and policyname='allow_all') then
    create policy "allow_all" on pricing_history for all to authenticated using (true) with check (true);
  end if;
end $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- BACKFILLS
-- ═════════════════════════════════════════════════════════════════════════════

-- ─── 1. Existing deals get their single contact filed onto a side ────────────
-- A legacy deal represents one side and has one client set, so that set is that
-- side's. `transaction_type` is the same field the old Buyer/Seller toggle
-- wrote; anything other than 'seller' read as buyer in the UI, so it does here.
update deals
   set seller_contact_id = contact_id
 where contact_id is not null
   and seller_contact_id is null
   and buyer_contact_id  is null
   and lower(coalesce(comp_data->>'transaction_type','')) = 'seller';

update deals
   set buyer_contact_id = contact_id
 where contact_id is not null
   and seller_contact_id is null
   and buyer_contact_id  is null
   and lower(coalesce(comp_data->>'transaction_type','')) <> 'seller';

-- ─── 2. Additional contacts inherit their deal's side ───────────────────────
update deal_contacts dc
   set side = case when lower(coalesce(d.comp_data->>'transaction_type','')) = 'seller'
                   then 'seller' else 'buyer' end
  from deals d
 where d.id = dc.deal_id
   and dc.side is null;

-- ─── 3. properties.price_history jsonb → pricing_history rows ───────────────
-- Guarded on the property having no rows yet, so re-running cannot duplicate a
-- history. Legacy entries carry a date but no actor, hence source 'import' and
-- a null changed_by: the log says "we do not know who", which is the truth.
insert into pricing_history (property_id, price, previous_price, source, created_at)
select p.id,
       nullif(e->>'price','')::numeric,
       nullif(e->>'previous_price','')::numeric,
       'import',
       coalesce(
         (nullif(e->>'changed_at','')::timestamptz),
         (nullif(e->>'date','')::date)::timestamptz,
         p.created_at,
         now()
       )
  from properties p
  cross join lateral jsonb_array_elements(
         case when jsonb_typeof(p.price_history) = 'array' then p.price_history else '[]'::jsonb end
       ) as e
 where not exists (select 1 from pricing_history ph where ph.property_id = p.id);

-- ─── 4. Open deals inherit their property's price where they have none ──────
-- The two-way sync keeps them equal from here on; a deal that never had a value
-- would otherwise show blank next to a priced listing forever. Only fills
-- NULLs — an intentionally different negotiated number is never overwritten.
update deals d
   set value = p.list_price
  from properties p
 where p.id = d.property_id
   and d.value is null
   and p.list_price is not null
   and d.stage not in ('closed','lost');
