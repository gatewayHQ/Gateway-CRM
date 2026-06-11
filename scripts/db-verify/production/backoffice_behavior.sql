\set ON_ERROR_STOP on
-- Replica already has Phase B enforced + seed data (admin a, daniel d, nic e; commission on D1)
set role authenticated;
set request.jwt.claim.sub = '10000000-0000-0000-0000-00000000000d';
select assert_eq('daniel (co-owner!) sees zero commission rows', (select count(*) from commissions), 0);
do $$ begin
  insert into commissions (deal_id, gross_pct) values ('00000000-0000-0000-0000-0000000000d4', 3);
  raise exception 'FAIL: non-admin inserted a commission';
exception when insufficient_privilege then raise notice 'PASS non-admin commission insert rejected';
end $$;
set request.jwt.claim.sub = '10000000-0000-0000-0000-00000000000a';
select assert_eq('admin sees all commissions', (select count(*) from commissions), 1);
update agents set cap_amount = 25000, cap_anniversary = '2024-03-15' where email = 'daniel@gw.com';
select assert_eq('admin set a cap', (select count(*) from agents where cap_amount = 25000), 1);
reset role;
select 'BACK OFFICE RLS TESTS PASSED' as result;
