\set ON_ERROR_STOP on
-- ── Seed (as superuser) ──────────────────────────────────────────────────────
insert into agents (id, auth_id, name, initials, role, email, is_admin) values
 ('00000000-0000-0000-0000-00000000000a','10000000-0000-0000-0000-00000000000a','Admin TC','AT','Office Admin','tc@gw.com', true),
 ('00000000-0000-0000-0000-00000000000d','10000000-0000-0000-0000-00000000000d','Daniel','DG','Commercial Advisor','daniel@gw.com', false),
 ('00000000-0000-0000-0000-00000000000e','10000000-0000-0000-0000-00000000000e','Nic','NM','Commercial Advisor','nic@gw.com', false),
 ('00000000-0000-0000-0000-00000000000f','10000000-0000-0000-0000-00000000000f','Steph','SM','Residential Agent','steph@gw.com', false),
 ('00000000-0000-0000-0000-000000000010','10000000-0000-0000-0000-000000000010','Emma','EM','Residential Agent','emma@gw.com', false);

-- Mad Real Estate Group: Steph, Nic, Emma (default sharing)
insert into teams (id, name) values ('00000000-0000-0000-0000-0000000000aa','Mad Real Estate Group');
insert into team_splits (team_id, agent_id) values
 ('00000000-0000-0000-0000-0000000000aa','00000000-0000-0000-0000-00000000000f'),
 ('00000000-0000-0000-0000-0000000000aa','00000000-0000-0000-0000-00000000000e'),
 ('00000000-0000-0000-0000-0000000000aa','00000000-0000-0000-0000-000000000010');

insert into deals (id, title, agent_id, stage, value, prop_category) values
 ('00000000-0000-0000-0000-0000000000d1','D1 Daniel+Nic colist','00000000-0000-0000-0000-00000000000d','under-contract', 2000000,'commercial'),
 ('00000000-0000-0000-0000-0000000000d2','D2 Steph solo','00000000-0000-0000-0000-00000000000f','offer', 300000,'residential'),
 ('00000000-0000-0000-0000-0000000000d4','D4 Daniel solo','00000000-0000-0000-0000-00000000000d','lead', 1000000,'commercial');

-- Nic is co-listed (paid participant) on Daniel's D1
insert into commissions (deal_id, participants) values
 ('00000000-0000-0000-0000-0000000000d1',
  '[{"id":"p1","agent_id":"00000000-0000-0000-0000-00000000000d","name":"Daniel","allocation_pct":50},
    {"id":"p2","agent_id":"00000000-0000-0000-0000-00000000000e","name":"Nic","allocation_pct":50}]'::jsonb),
 ('00000000-0000-0000-0000-0000000000d2', '[]'::jsonb);

insert into documents (deal_id, agent_id, name) values
 ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-00000000000d','psa-d1.pdf'),
 ('00000000-0000-0000-0000-0000000000d2','00000000-0000-0000-0000-00000000000f','listing-d2.pdf');

insert into activities (contact_id, deal_id, agent_id, type, body) values
 (null, '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-00000000000d', 'note', 'D1 LOI countersigned');

-- Vanilla-PG stand-in for Supabase's default grants
grant usage on schema public to authenticated;
grant all on all tables in schema public to authenticated;

-- ── PHASE B: activate enforcement ───────────────────────────────────────────
drop policy if exists allow_all on contacts;
drop policy if exists allow_all on activities;
drop policy if exists allow_all on tasks;
drop policy if exists allow_all on deals;
drop policy if exists allow_all on commissions;
drop policy if exists allow_all on documents;
drop policy if exists allow_all on docusign_envelopes;
drop policy if exists allow_all on transaction_steps;
drop policy if exists allow_all on agent_notifications;
drop policy if exists deadline_reminders_all on deadline_reminders;

-- ── Assertions ───────────────────────────────────────────────────────────────
create or replace function assert_eq(label text, got bigint, want bigint) returns void language plpgsql as $$
begin
  if got is distinct from want then raise exception 'FAIL %: got %, want %', label, got, want; end if;
  raise notice 'PASS %: %', label, got;
end $$;

-- As DANIEL: sees D1 (own) + D4 (own); NOT Steph's D2
set role authenticated;
set request.jwt.claim.sub = '10000000-0000-0000-0000-00000000000d';
select assert_eq('daniel deals', (select count(*) from deals), 2);
select assert_eq('daniel sees D2', (select count(*) from deals where id='00000000-0000-0000-0000-0000000000d2'), 0);
select assert_eq('daniel commissions', (select count(*) from commissions), 1);
select assert_eq('daniel documents', (select count(*) from documents), 1);

-- As NIC: D1 (co-listed) + D2 (Steph team-share); NOT D4
set request.jwt.claim.sub = '10000000-0000-0000-0000-00000000000e';
select assert_eq('nic deals', (select count(*) from deals), 2);
select assert_eq('nic sees colisted D1', (select count(*) from deals where id='00000000-0000-0000-0000-0000000000d1'), 1);
select assert_eq('nic sees D4', (select count(*) from deals where id='00000000-0000-0000-0000-0000000000d4'), 0);
select assert_eq('nic D1 docs', (select count(*) from documents where deal_id='00000000-0000-0000-0000-0000000000d1'), 1);
select assert_eq('nic D1 activity', (select count(*) from activities where deal_id='00000000-0000-0000-0000-0000000000d1'), 1);
-- Nic can edit the co-listed deal (drag stage)
update deals set stage='offer' where id='00000000-0000-0000-0000-0000000000d1';
select assert_eq('nic edited D1', (select count(*) from deals where id='00000000-0000-0000-0000-0000000000d1' and stage='offer'), 1);

-- As EMMA (team peer of Steph): sees D2 only
set request.jwt.claim.sub = '10000000-0000-0000-0000-000000000010';
select assert_eq('emma deals', (select count(*) from deals), 1);

-- As ADMIN/TC: sees everything
set request.jwt.claim.sub = '10000000-0000-0000-0000-00000000000a';
select assert_eq('admin deals', (select count(*) from deals), 3);
select assert_eq('admin commissions', (select count(*) from commissions), 2);
select assert_eq('admin documents', (select count(*) from documents), 2);

-- Write-path guards still enforced under RLS
set request.jwt.claim.sub = '10000000-0000-0000-0000-00000000000d';
do $$ begin
  insert into deals (title, agent_id, value) values ('bad', '00000000-0000-0000-0000-00000000000d', -5);
  raise exception 'FAIL: negative deal value was accepted';
exception when check_violation then raise notice 'PASS negative value rejected';
end $$;
do $$ begin
  insert into deals (title, agent_id) values ('sneaky', '00000000-0000-0000-0000-00000000000f');
  raise exception 'FAIL: cross-agent deal insert was accepted';
exception when insufficient_privilege or sqlstate '42501' then raise notice 'PASS cross-agent insert rejected';
end $$;
reset role;
select 'ALL RLS TESTS PASSED' as result;
