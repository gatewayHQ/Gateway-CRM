-- ═══════════════════════════════════════════════════════════════════════════
-- DEAL SHARING MATRIX — the whole co-agent story, asserted
--
-- Run against a DISPOSABLE database built from src/lib/schema.sql (never a
-- real one — it seeds rows and impersonates agents):
--
--   createdb crm_check
--   psql -d crm_check -v ON_ERROR_STOP=1 -f scripts/db-verify/supabase_shim.sql
--   psql -d crm_check -v ON_ERROR_STOP=1 -f src/lib/schema.sql
--   psql -d crm_check -f scripts/db-verify/deal_sharing_matrix.sql
--
-- Covers the three ways an agent ends up on a deal, and what they can see
-- once they are:
--
--   A. the property carried co-agents when "Start Deal" converted it
--   B. an agent was added AFTER the deal already existed
--   C. nobody added them — they must see nothing
--
-- Plus the duplicate guard, in both directions: a second same-side deal is
-- refused, a buyer-side deal beside a seller-side one is allowed, and closing
-- a deal frees the property for a re-listing years later.
-- ═══════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP off
set client_min_messages = warning;

create or replace function _check(label text, got anyelement, want anyelement)
returns text language sql immutable as $$
  select case when got = want then 'PASS  ' else 'FAIL  ' end
         || label || '  (got ' || got::text || ', want ' || want::text || ')'
$$;

-- ── Cast ───────────────────────────────────────────────────────────────────
insert into agents (id, auth_id, name, initials, role, email, is_admin) values
 ('11111111-1111-4111-8111-000000000001','11111111-1111-4111-8111-000000000001','Steph','SD','agent','steph@x.com',false),
 ('11111111-1111-4111-8111-000000000002','11111111-1111-4111-8111-000000000002','Emma','EK','agent','emma@x.com',false),
 ('11111111-1111-4111-8111-000000000003','11111111-1111-4111-8111-000000000003','Outsider','OS','agent','out@x.com',false),
 ('11111111-1111-4111-8111-000000000009','11111111-1111-4111-8111-000000000009','Erin','ER','agent','erin@x.com',true);

-- A property whose Co-Agents section already lists Emma.
insert into properties (id, address, city, state, zip, details) values
 ('22222222-2222-4222-8222-000000000001','12 Carried Over Rd','Spencer','IA','51301',
  '{"co_agent_ids":["11111111-1111-4111-8111-000000000002"]}'::jsonb),
 ('22222222-2222-4222-8222-000000000002','34 Added Later Ave','Spencer','IA','51301','{}'::jsonb);

-- A. "Start Deal" stamps the property's co-agents onto the deal.
insert into deals (id, title, agent_id, property_id, co_agent_ids, stage, value, comp_data) values
 ('33333333-3333-4333-8333-000000000001','12 Carried Over Rd','11111111-1111-4111-8111-000000000001',
  '22222222-2222-4222-8222-000000000001',
  array['11111111-1111-4111-8111-000000000002']::uuid[],'under-contract',200000,
  '{"transaction_type":"seller"}'::jsonb),
-- B. Started solo. Emma is added further down.
 ('33333333-3333-4333-8333-000000000002','34 Added Later Ave','11111111-1111-4111-8111-000000000001',
  '22222222-2222-4222-8222-000000000002','{}'::uuid[],'under-contract',300000,
  '{"transaction_type":"seller"}'::jsonb);

insert into storage.objects (bucket_id, name, owner) values
 ('deal-documents','deal-33333333-3333-4333-8333-000000000001/steph-offer.pdf','11111111-1111-4111-8111-000000000001'),
 ('deal-documents','deal-33333333-3333-4333-8333-000000000002/steph-escrow.pdf','11111111-1111-4111-8111-000000000001'),
 ('deal-documents','deal-33333333-3333-4333-8333-000000000002/steph-title.pdf','11111111-1111-4111-8111-000000000001');

grant usage on schema public, storage to authenticated;
grant select on all tables in schema public to authenticated;
grant select, insert, update, delete on storage.objects to authenticated;

-- ── A · carried over by Start Deal ─────────────────────────────────────────
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-4111-8111-000000000002';
select _check('A1  co-agent from the property sees the deal',
  (select count(*) from deals where id = '33333333-3333-4333-8333-000000000001'), 1::bigint);
select _check('A2  ...and its documents',
  (select count(*) from storage.objects where bucket_id='deal-documents'
    and name like 'deal-33333333-3333-4333-8333-000000000001/%'), 1::bigint);

-- ── B · added after the deal already existed ───────────────────────────────
select _check('B1  before being added: deal hidden',
  (select count(*) from deals where id = '33333333-3333-4333-8333-000000000002'), 0::bigint);
select _check('B2  before being added: documents hidden',
  (select count(*) from storage.objects where bucket_id='deal-documents'
    and name like 'deal-33333333-3333-4333-8333-000000000002/%'), 0::bigint);
reset role;

-- Steph adds Emma under "Agents on deal".
update deals set co_agent_ids = array['11111111-1111-4111-8111-000000000002']::uuid[]
 where id = '33333333-3333-4333-8333-000000000002';

set role authenticated;
set request.jwt.claim.sub = '11111111-1111-4111-8111-000000000002';
select _check('B3  after being added: deal visible',
  (select count(*) from deals where id = '33333333-3333-4333-8333-000000000002'), 1::bigint);
select _check('B4  after being added: BOTH documents visible',
  (select count(*) from storage.objects where bucket_id='deal-documents'
    and name like 'deal-33333333-3333-4333-8333-000000000002/%'), 2::bigint);

-- Emma uploads to Steph's deal; Steph must see it too.
insert into storage.objects (bucket_id, name, owner) values
 ('deal-documents','deal-33333333-3333-4333-8333-000000000002/emma-addendum.pdf','11111111-1111-4111-8111-000000000002');
set request.jwt.claim.sub = '11111111-1111-4111-8111-000000000001';
select _check('B5  the owner sees the co-agent''s upload (both directions)',
  (select count(*) from storage.objects where bucket_id='deal-documents'
    and name like 'deal-33333333-3333-4333-8333-000000000002/%'), 3::bigint);

-- ── C · nobody added them ──────────────────────────────────────────────────
set request.jwt.claim.sub = '11111111-1111-4111-8111-000000000003';
select _check('C1  unrelated agent sees no deals', (select count(*) from deals), 0::bigint);
select _check('C2  unrelated agent sees no documents',
  (select count(*) from storage.objects where bucket_id='deal-documents'), 0::bigint);

-- ── D · office admin ───────────────────────────────────────────────────────
set request.jwt.claim.sub = '11111111-1111-4111-8111-000000000009';
select _check('D1  office admin sees every deal', (select count(*) from deals), 2::bigint);
select _check('D2  office admin sees every document',
  (select count(*) from storage.objects where bucket_id='deal-documents'), 4::bigint);
reset role;

-- ── E · the duplicate guard ────────────────────────────────────────────────
select _check('E1  the guard function finds the existing seller-side deal',
  (select count(*) from app_open_deal_on_property('22222222-2222-4222-8222-000000000001','seller')), 1::bigint);
select _check('E2  ...and reports who owns it',
  (select agent_name from app_open_deal_on_property('22222222-2222-4222-8222-000000000001','seller') limit 1), 'Steph'::text);
select _check('E3  a buyer-side check on the same property is clear',
  (select count(*) from app_open_deal_on_property('22222222-2222-4222-8222-000000000001','buyer')), 0::bigint);

-- A second SELLER deal on that property must be refused by the index.
do $$
begin
  insert into deals (id,title,agent_id,property_id,stage,value,comp_data) values
   ('44444444-4444-4444-8444-000000000001','dupe','11111111-1111-4111-8111-000000000002',
    '22222222-2222-4222-8222-000000000001','lead',200000,'{"transaction_type":"seller"}'::jsonb);
  raise warning 'FAIL  E4  a second SELLER-side deal was ALLOWED';
exception when unique_violation then
  raise warning 'PASS  E4  a second seller-side deal is refused';
end $$;

-- A buyer-side deal beside it is legitimate business.
do $$
begin
  insert into deals (id,title,agent_id,property_id,stage,value,comp_data) values
   ('44444444-4444-4444-8444-000000000002','buy side','11111111-1111-4111-8111-000000000002',
    '22222222-2222-4222-8222-000000000001','lead',200000,'{"transaction_type":"buyer"}'::jsonb);
  raise warning 'PASS  E5  a buyer-side deal beside the seller-side one is allowed';
exception when unique_violation then
  raise warning 'FAIL  E5  a legitimate buyer-side deal was REFUSED';
end $$;

-- Two deals with no side set must still collide (the coalesce).
insert into properties (id,address,city,state,zip) values
 ('22222222-2222-4222-8222-000000000003','56 No Side Set St','Spencer','IA','51301');
insert into deals (id,title,agent_id,property_id,stage,value,comp_data) values
 ('44444444-4444-4444-8444-000000000003','no side','11111111-1111-4111-8111-000000000001',
  '22222222-2222-4222-8222-000000000003','lead',100000,'{}'::jsonb);
do $$
begin
  insert into deals (id,title,agent_id,property_id,stage,value,comp_data) values
   ('44444444-4444-4444-8444-000000000004','no side 2','11111111-1111-4111-8111-000000000002',
    '22222222-2222-4222-8222-000000000003','lead',100000,'{}'::jsonb);
  raise warning 'FAIL  E6  a second SIDE-LESS deal was ALLOWED (coalesce is not working)';
exception when unique_violation then
  raise warning 'PASS  E6  a second side-less deal is refused';
end $$;

-- The re-listing years later: close the old deal, the slot frees.
update deals set stage = 'closed' where id = '33333333-3333-4333-8333-000000000001';
do $$
begin
  insert into deals (id,title,agent_id,property_id,stage,value,comp_data) values
   ('44444444-4444-4444-8444-000000000005','relist 2029','11111111-1111-4111-8111-000000000003',
    '22222222-2222-4222-8222-000000000001','lead',260000,'{"transaction_type":"seller"}'::jsonb);
  raise warning 'PASS  E7  a re-listing after the old deal closed is allowed';
exception when unique_violation then
  raise warning 'FAIL  E7  a legitimate re-listing was REFUSED';
end $$;

-- ── F · asking the owner for access grants nothing ─────────────────────────
select _check('F1  access request is recorded for the deal owner',
  (select app_request_deal_access('33333333-3333-4333-8333-000000000002')), true);
select _check('F2  ...as a notification to the OWNER, not an access grant',
  (select count(*) from agent_notifications
    where agent_id = '11111111-1111-4111-8111-000000000001' and type = 'deal_access_request'), 1::bigint);
select _check('F3  ...and the deal''s team is unchanged by it',
  (select array_length(co_agent_ids,1) from deals where id='33333333-3333-4333-8333-000000000002'), 1);

drop function _check(text, anyelement, anyelement);
