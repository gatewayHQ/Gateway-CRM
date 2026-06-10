\set ON_ERROR_STOP on
-- ── Seed ──
insert into agents (id, auth_id, name, initials, role, email, is_admin) values
 ('00000000-0000-0000-0000-00000000000a','10000000-0000-0000-0000-00000000000a','Admin TC','AT','Office Admin','tc@gw.com', true),
 ('00000000-0000-0000-0000-00000000000d','10000000-0000-0000-0000-00000000000d','Daniel','DG','Commercial Advisor','daniel@gw.com', false),
 ('00000000-0000-0000-0000-00000000000e','10000000-0000-0000-0000-00000000000e','Nic','NM','Commercial Advisor','nic@gw.com', false),
 ('00000000-0000-0000-0000-00000000000f','10000000-0000-0000-0000-00000000000f','Steph','SM','Residential Agent','steph@gw.com', false),
 ('00000000-0000-0000-0000-000000000010','10000000-0000-0000-0000-000000000010','Emma','EM','Residential Agent','emma@gw.com', false);
insert into teams (id, name) values ('00000000-0000-0000-0000-0000000000aa','Mad Real Estate Group');
insert into team_splits (team_id, agent_id, share_contacts, share_properties, share_deals) values
 ('00000000-0000-0000-0000-0000000000aa','00000000-0000-0000-0000-00000000000f',true,true,true),
 ('00000000-0000-0000-0000-0000000000aa','00000000-0000-0000-0000-00000000000e',true,true,true),
 ('00000000-0000-0000-0000-0000000000aa','00000000-0000-0000-0000-000000000010',true,true,true);
insert into deals (id, title, agent_id, stage, value, prop_category) values
 ('00000000-0000-0000-0000-0000000000d1','D1 Daniel+Nic colist (participants)','00000000-0000-0000-0000-00000000000d','under-contract', 2000000,'commercial'),
 ('00000000-0000-0000-0000-0000000000d2','D2 Steph solo','00000000-0000-0000-0000-00000000000f','offer', 300000,'residential'),
 ('00000000-0000-0000-0000-0000000000d4','D4 Daniel solo','00000000-0000-0000-0000-00000000000d','lead', 1000000,'commercial');
-- D5: legacy co-listing via deals.co_agent_ids (Steph's deal, Daniel co-listed)
insert into deals (id, title, agent_id, stage, value, co_agent_ids) values
 ('00000000-0000-0000-0000-0000000000d5','D5 legacy colist via co_agent_ids','00000000-0000-0000-0000-00000000000f','offer', 500000,
  array['00000000-0000-0000-0000-00000000000d']::uuid[]);
insert into commissions (deal_id, participants) values
 ('00000000-0000-0000-0000-0000000000d1',
  '[{"id":"p1","agent_id":"00000000-0000-0000-0000-00000000000d","name":"Daniel","allocation_pct":50},
    {"id":"p2","agent_id":"00000000-0000-0000-0000-00000000000e","name":"Nic","allocation_pct":50}]'::jsonb);
insert into documents (deal_id, agent_id, name) values
 ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-00000000000d','psa-d1.pdf'),
 ('00000000-0000-0000-0000-0000000000d2','00000000-0000-0000-0000-00000000000f','listing-d2.pdf');
insert into properties (id, address, assigned_agent_id) values
 ('00000000-0000-0000-0000-0000000000b1'::uuid,'123 Main','00000000-0000-0000-0000-00000000000d');
insert into integrations (type, config) values ('mailchimp', '{"api_key":"SECRET"}'::jsonb);

create or replace function assert_eq(label text, got bigint, want bigint) returns void language plpgsql as $$
begin
  if got is distinct from want then raise exception 'FAIL %: got %, want %', label, got, want; end if;
  raise notice 'PASS %: %', label, got;
end $$;

-- ── PHASE A BEHAVIOR: agents still see everything; anon holes closed ──
set role authenticated;
set request.jwt.claim.sub = '10000000-0000-0000-0000-00000000000e';
select assert_eq('phaseA nic sees ALL deals (unchanged)', (select count(*) from deals), 4);
select assert_eq('phaseA nic sees ALL contacts (unchanged)', (select count(*) from contacts), 0);
reset role;
set role anon;
select assert_eq('anon can still read properties (landing pages)', (select count(*) from properties), 1);
-- RLS filters silently: the delete matches no visible rows, data survives
delete from properties;
select assert_eq('anon property delete blocked (rows survive)', (select count(*) from properties), 1);
-- and anon sees zero integration rows (credentials hidden)
select assert_eq('anon integrations read blocked (0 rows visible)', (select count(*) from integrations), 0);
reset role;

-- ── PHASE B DRESS REHEARSAL (the real live-DB policy names) ──
do $$
declare t text;
begin
  foreach t in array array['contacts','deals','tasks','activities'] loop
    execute format('drop policy if exists agent_select on %I', t);
    execute format('drop policy if exists agent_insert on %I', t);
    execute format('drop policy if exists agent_update on %I', t);
    execute format('drop policy if exists agent_delete on %I', t);
  end loop;
end $$;
drop policy if exists agent_select on commissions;
drop policy if exists agent_insert on commissions;
drop policy if exists agent_update on commissions;
drop policy if exists agents_envelopes on docusign_envelopes;
drop policy if exists allow_all        on docusign_envelopes;
drop policy if exists auth_all_steps   on transaction_steps;
drop policy if exists allow_all        on transaction_steps;
drop policy if exists agent_notifications_policy on agent_notifications;
drop policy if exists allow_all                  on agent_notifications;
drop policy if exists deadline_reminders_all     on deadline_reminders;

-- ── Visibility matrix under enforcement ──
set role authenticated;
set request.jwt.claim.sub = '10000000-0000-0000-0000-00000000000d';
select assert_eq('daniel deals (D1+D4 own, D5 legacy colist)', (select count(*) from deals), 3);
select assert_eq('daniel sees D5 via co_agent_ids', (select count(*) from deals where id='00000000-0000-0000-0000-0000000000d5'), 1);
select assert_eq('daniel cannot see D2', (select count(*) from deals where id='00000000-0000-0000-0000-0000000000d2'), 0);

set request.jwt.claim.sub = '10000000-0000-0000-0000-00000000000e';
select assert_eq('nic deals (D1 participant, D2+D5 team)', (select count(*) from deals), 3);
select assert_eq('nic cannot see D4', (select count(*) from deals where id='00000000-0000-0000-0000-0000000000d4'), 0);
select assert_eq('nic sees D1 documents', (select count(*) from documents where deal_id='00000000-0000-0000-0000-0000000000d1'), 1);
update deals set stage='offer' where id='00000000-0000-0000-0000-0000000000d1';
select assert_eq('nic edited co-listed D1', (select count(*) from deals where id='00000000-0000-0000-0000-0000000000d1' and stage='offer'), 1);

set request.jwt.claim.sub = '10000000-0000-0000-0000-000000000010';
select assert_eq('emma deals (team only)', (select count(*) from deals), 2);

set request.jwt.claim.sub = '10000000-0000-0000-0000-00000000000a';
select assert_eq('admin sees all deals', (select count(*) from deals), 4);
select assert_eq('admin sees all documents', (select count(*) from documents), 2);

set request.jwt.claim.sub = '10000000-0000-0000-0000-00000000000d';
do $$ begin
  insert into deals (title, agent_id, value) values ('bad', '00000000-0000-0000-0000-00000000000d', -5);
  raise exception 'FAIL: negative deal value accepted';
exception when check_violation then raise notice 'PASS negative value rejected';
end $$;
do $$ begin
  insert into deals (title, agent_id) values ('sneaky', '00000000-0000-0000-0000-00000000000f');
  raise exception 'FAIL: cross-agent deal insert accepted';
exception when insufficient_privilege then raise notice 'PASS cross-agent insert rejected';
end $$;
reset role;
select 'ALL REPLICA BEHAVIOR TESTS PASSED' as result;
