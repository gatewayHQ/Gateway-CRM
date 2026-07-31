-- ═════════════════════════════════════════════════════════════════════════════
-- Gateway CRM — BoldSign hardening + pending-migration catch-up  (2026-07-31)
--
-- PASTE THIS WHOLE FILE into Supabase Dashboard → SQL Editor → Run.
-- Safe to re-run (fully idempotent). Nothing here drops or rewrites data.
--
-- This ONE bundle replaces the four migrations that were still marked PENDING
-- in migrations/production/README.md, and adds the new columns the e-signature
-- hardening deploy needs. Applying it is a PREREQUISITE for that deploy:
-- without sections 2–5 the "Send from Template" button cannot appear at all,
-- and without section 6 signed-PDF downloads fall back to the slow path.
--
-- Sections
--   1. Preflight — required extension + a report of what this database has now
--   2. form_packets — table + e-signature columns (was 2026-07-16)
--   3. form_packets.storage_paths — package templates (was 2026-07-17)
--   4. boldsign_sender_identities.is_default — org fallback sender (was 2026-07-17)
--   5. deal_contacts / property_contacts — additional signers (was 2026-07-17)
--   6. boldsign_documents — archive paths + reminder ledger (NEW)
--   7. Backfill — carry the retired boldsign_templates registry into form_packets
--   8. Verification — run the SELECTs at the bottom and eyeball the output
-- ═════════════════════════════════════════════════════════════════════════════


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. PREFLIGHT
-- ─────────────────────────────────────────────────────────────────────────────
-- Every table below defaults its primary key to uuid_generate_v4().
create extension if not exists "uuid-ossp";

-- Informational: what exists before we start. Look at this output — if
-- form_packets already says 'present' you are re-running, which is fine.
do $$
begin
  raise notice 'form_packets ............... %', coalesce(to_regclass('public.form_packets')::text, 'MISSING');
  raise notice 'boldsign_documents ........ %', coalesce(to_regclass('public.boldsign_documents')::text, 'MISSING');
  raise notice 'boldsign_sender_identities  %', coalesce(to_regclass('public.boldsign_sender_identities')::text, 'MISSING');
  raise notice 'boldsign_templates (legacy) %', coalesce(to_regclass('public.boldsign_templates')::text, 'MISSING');
  raise notice 'deal_contacts ............. %', coalesce(to_regclass('public.deal_contacts')::text, 'MISSING');
end $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. FORM PACKETS — the CRM's single form/template catalog
--
-- Was: migrations/production/2026-07-16_form_library_boldsign_unification.sql
--
-- That file assumed form_packets already existed and only ALTERed it. This one
-- creates it first if needed, so the bundle works whether or not the Form
-- Library shipped to this database earlier. An entry with
-- boldsign_template_id set is what makes a packet SENDABLE from a deal's
-- Signatures tab — that column being absent is exactly why the "Send from
-- Template" button has been missing.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists form_packets (
  id                   uuid primary key default uuid_generate_v4(),
  state                text not null,
  transaction_type     text not null check (transaction_type in ('buyer','seller','lease','general')),
  name                 text not null,
  description          text,
  storage_path         text,
  created_at           timestamptz default now()
);

-- E-signature columns (additive — a packet without them is still a plain
-- downloadable form bundle).
alter table form_packets add column if not exists boldsign_template_id text;
alter table form_packets add column if not exists doc_type             text;
alter table form_packets add column if not exists field_tokens         jsonb   default '[]';
alter table form_packets add column if not exists active               boolean default true;

-- One CRM entry per BoldSign template. Partial so the many rows with a null
-- template id (plain form bundles) don't collide with each other.
create unique index if not exists uq_form_packets_boldsign_tid
  on form_packets(boldsign_template_id) where boldsign_template_id is not null;

-- The send picker reads only active, template-linked rows.
create index if not exists idx_form_packets_sendable
  on form_packets(state, transaction_type) where boldsign_template_id is not null and active;

alter table form_packets enable row level security;
drop policy if exists "form_packets_all" on form_packets;
create policy "form_packets_all" on form_packets
  for all to authenticated using (true) with check (true);


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. PACKAGE TEMPLATES — several source PDFs in one packet
--
-- Was: migrations/production/2026-07-17_form_packet_multi_file.sql
--
-- storage_path stays the primary/first file for back-compat; storage_paths
-- holds the full ordered list [{ path, name }] that "Get Forms" downloads and
-- that "Build in BoldSign" combines into one signable template.
-- ─────────────────────────────────────────────────────────────────────────────
alter table form_packets add column if not exists storage_paths jsonb default '[]';


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. DEFAULT SENDER IDENTITY — org-wide OnBehalfOf fallback
--
-- Was: migrations/production/2026-07-17_boldsign_identity_default.sql
--
-- Used when the acting agent has no approved identity of their own (e.g. an
-- admin- or cron-triggered send) so the client still sees a real, recognizable
-- sender instead of the raw API account.
-- ─────────────────────────────────────────────────────────────────────────────
alter table boldsign_sender_identities add column if not exists is_default boolean default false;

-- Only one default at a time. Partial index → all the `false` rows are ignored.
create unique index if not exists uq_boldsign_identity_default
  on boldsign_sender_identities(is_default) where is_default;


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. ADDITIONAL CONTACTS — co-buyers / spouses as real signers
--
-- Was: migrations/production/2026-07-17_multi_contacts.sql
--
-- deals.contact_id stays the PRIMARY contact; these junction rows hold the
-- extras. "Send from Template" seeds a second client signer row from here with
-- a real email address (a stored spouse_name has no email, so it can only fill
-- a name).
--
-- ⚠ LEGACY: the 2026-06-10 production diagnostic found a pre-existing
-- deal_contacts table of unknown shape. `create table if not exists` will NOT
-- alter it. Section 8's verification query prints the live columns — confirm it
-- has (deal_id, contact_id) with a unique constraint on the pair. If it
-- doesn't, reconcile by hand before relying on additional-signer seeding; the
-- app only ever inserts { deal_id, contact_id } and leans on that constraint
-- for idempotent re-links.
-- ─────────────────────────────────────────────────────────────────────────────
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

-- Link rows follow the deal, same model as transaction_steps. On a database
-- that predates the visibility helpers, fall back to the permissive posture
-- every other table had then — re-running this after 0011 upgrades it.
do $$ begin
  if exists (select 1 from pg_proc where proname = 'app_visible_deal_ids') then
    drop policy if exists deal_contacts_allow_all  on deal_contacts;
    drop policy if exists deal_contacts_deal_scope on deal_contacts;
    create policy deal_contacts_deal_scope on deal_contacts for all to authenticated
      using      (deal_id in (select app_visible_deal_ids()))
      with check (deal_id in (select app_visible_deal_ids()));
  elsif not exists (select 1 from pg_policies where tablename='deal_contacts' and policyname='deal_contacts_allow_all') then
    create policy deal_contacts_allow_all on deal_contacts for all to authenticated
      using (true) with check (true);
  end if;
end $$;

create table if not exists property_contacts (
  id          uuid primary key default uuid_generate_v4(),
  property_id uuid not null references properties(id) on delete cascade,
  contact_id  uuid not null references contacts(id)   on delete cascade,
  created_at  timestamptz default now(),
  unique (property_id, contact_id)
);
create index if not exists idx_property_contacts_property on property_contacts(property_id);
create index if not exists idx_property_contacts_contact  on property_contacts(contact_id);
alter table property_contacts enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='property_contacts' and policyname='allow_all') then
    create policy "allow_all" on property_contacts for all to authenticated using (true) with check (true);
  end if;
end $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 6. BOLDSIGN DOCUMENTS — archive paths + reminder ledger  (NEW)
--
-- signed_storage_path / audit_storage_path
--   Where the completed PDF and the compliance audit trail were archived for
--   THIS document. Previously the UI had to guess by filename pattern, which
--   returned the wrong PDF on any deal with more than one signed document, and
--   large PDFs could not be delivered at all because they were round-tripped
--   as base64 through a serverless function (4.5 MB payload cap). With the path
--   on the row, the browser mints a signed storage URL directly — correct file,
--   no size limit.
--
-- last_reminded_at / reminder_count
--   Ledger for the nightly auto-reminder job and the manual Remind button, so
--   a signer is nudged on a schedule instead of being emailed on every run.
-- ─────────────────────────────────────────────────────────────────────────────
alter table boldsign_documents add column if not exists signed_storage_path text;
alter table boldsign_documents add column if not exists audit_storage_path  text;
alter table boldsign_documents add column if not exists last_reminded_at    timestamptz;
alter table boldsign_documents add column if not exists reminder_count      integer default 0;

-- Backfill defensively: existing rows may have been created before the column
-- existed, and a null count would break `reminder_count + 1`.
update boldsign_documents set reminder_count = 0 where reminder_count is null;

-- The nightly reminder sweep and the "what's still outstanding" queries both
-- scan for in-flight documents ordered by age.
create index if not exists idx_boldsign_docs_awaiting
  on boldsign_documents(sent_at)
  where status in ('sent','delivered');

-- Status values the app writes, kept as a comment rather than a CHECK
-- constraint: a constraint here would make an unrecognized future BoldSign
-- status a hard webhook failure (and BoldSign stops retrying after a 200),
-- which is worse than storing an unexpected string.
--   draft | sent | delivered | completed | declined | expired | voided
comment on column boldsign_documents.status is
  'draft|sent|delivered|completed|declined|expired|voided (normalized from BoldSign)';


-- ─────────────────────────────────────────────────────────────────────────────
-- 7. BACKFILL — carry the retired boldsign_templates registry into form_packets
--
-- Guarded: skipped entirely on a database that never had the old registry.
-- Rows with a null state are skipped on purpose — form_packets requires exactly
-- one state per entry and state is compliance-relevant, so those are added by
-- hand per state in Form Library rather than guessed at here.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare moved integer := 0;
begin
  if to_regclass('public.boldsign_templates') is null then
    raise notice 'boldsign_templates absent — nothing to backfill';
    return;
  end if;

  insert into form_packets (state, transaction_type, name, description,
                            boldsign_template_id, doc_type, field_tokens, active)
  select
    bt.state,
    case
      when bt.doc_type ilike '%buyer%' then 'buyer'
      when bt.doc_type ilike '%lease%' then 'lease'
      else 'seller'
    end,
    bt.name,
    coalesce(bt.description, 'Migrated from the boldsign_templates registry.'),
    bt.template_id,
    bt.doc_type,
    coalesce(bt.field_tokens, '[]'::jsonb),
    coalesce(bt.active, true)
  from boldsign_templates bt
  where bt.state is not null
    and bt.template_id is not null
    and not exists (
      select 1 from form_packets fp where fp.boldsign_template_id = bt.template_id
    );

  get diagnostics moved = row_count;
  raise notice 'backfilled % template(s) into form_packets', moved;

  if exists (select 1 from boldsign_templates where state is null and template_id is not null) then
    raise notice 'NOTE: some legacy templates have a null state and were skipped — add them per state in Form Library';
  end if;
end $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 8. VERIFICATION
--
-- ONE query on purpose. The Supabase SQL Editor only renders the result of the
-- LAST statement in a multi-statement run, so separate verification SELECTs
-- execute invisibly — including the deal_contacts legacy check, which is the one
-- that most needs eyeballing. Everything is unioned into a single result set.
--
-- Read the `result` column: every row should say 'ok' (or a count). Anything
-- reading MISSING / PUBLIC needs action before the app is trusted.
-- ═════════════════════════════════════════════════════════════════════════════
with expected(tbl, col) as (
  values
    ('form_packets','boldsign_template_id'),
    ('form_packets','doc_type'),
    ('form_packets','field_tokens'),
    ('form_packets','active'),
    ('form_packets','storage_paths'),
    ('boldsign_sender_identities','is_default'),
    ('boldsign_documents','signed_storage_path'),
    ('boldsign_documents','audit_storage_path'),
    ('boldsign_documents','last_reminded_at'),
    ('boldsign_documents','reminder_count')
)
select '1. column' as area, e.tbl || '.' || e.col as item,
       case when c.column_name is null then 'MISSING — re-run sections 2-6' else 'ok' end as result
from expected e
left join information_schema.columns c
  on c.table_schema = 'public' and c.table_name = e.tbl and c.column_name = e.col

union all
-- Legacy shape check: production carried a pre-existing deal_contacts of unknown
-- shape, and `create table if not exists` does not alter it. The app inserts
-- exactly { deal_id, contact_id } and relies on the unique pair for re-links.
select '2. deal_contacts', 'columns',
       coalesce(string_agg(column_name, ', ' order by ordinal_position), 'TABLE MISSING')
from information_schema.columns
where table_schema = 'public' and table_name = 'deal_contacts'

union all
select '2. deal_contacts', 'unique(deal_id, contact_id)',
       case when exists (
         select 1 from pg_constraint con
         join pg_class rel     on rel.oid = con.conrelid
         join pg_namespace ns  on ns.oid  = rel.relnamespace
         where ns.nspname = 'public' and rel.relname = 'deal_contacts' and con.contype = 'u'
       ) then 'ok' else 'MISSING — legacy table, reconcile by hand' end

union all
-- If this is 0 and you expected templates, the packets exist but still need a
-- BoldSign template id attached in Form Library.
select '3. catalog', 'sendable packets', count(*)::text
from form_packets where boldsign_template_id is not null and active

union all
-- Signed PDFs and audit trails live in deal-documents; both buckets must exist
-- and must NOT be public. Create a missing one in Dashboard → Storage.
select '4. bucket', b.id,
       case when b.public then 'PUBLIC — make this private!' else 'ok (private)' end
from storage.buckets b where b.id in ('deal-documents','form-packets')

order by 1, 2;
