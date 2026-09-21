-- ONE FIX. Paste this whole thing into the Supabase SQL Editor.
-- Read the NOTICES it prints afterwards - they are the report.
do $$
declare r record; n int := 0;
begin
  raise notice '--- policies on storage.objects BEFORE ---';
  for r in select policyname, permissive, cmd, qual from pg_policies
            where schemaname='storage' and tablename='objects' order by permissive, policyname
  loop raise notice '[%] % / % USING(%)', r.permissive, r.policyname, r.cmd, coalesce(r.qual,'-'); end loop;

  -- Co-agents FIRST: storage is wide open today, so scoping to the deal takes
  -- access away from anyone missing from deals.co_agent_ids. Union, not
  -- fill-if-empty, or a deal already carrying one co-agent keeps only that one.
  with filled as (
    update deals d set co_agent_ids = m.ids from (
      select d2.id, (select coalesce(array_agg(distinct x),'{}') from (
                       select unnest(coalesce(d2.co_agent_ids,'{}')) as x
                       union select nullif(v,'')::uuid
                         from jsonb_array_elements_text(p.details->'co_agent_ids') t(v)
                        where v ~ '^[0-9a-fA-F-]{36}$') s
                      where x is not null and x is distinct from d2.agent_id) as ids
        from deals d2 join properties p on p.id=d2.property_id
       where jsonb_typeof(p.details->'co_agent_ids')='array') m
     where d.id=m.id and not (d.co_agent_ids @> m.ids and d.co_agent_ids <@ m.ids)
    returning 1)
  select count(*) into n from filled;
  raise notice '--- co-agents: % deal(s) updated ---', n;

  -- THE BUG: restrictive policies are ANDed, so one vetoes everything. No
  -- bucket filter here - the one in force named no bucket, which is exactly
  -- why every earlier query missed it.
  n := 0;
  for r in select policyname, cmd, array_to_string(roles,',') as roles, qual, with_check
             from pg_policies where schemaname='storage' and tablename='objects'
              and permissive='RESTRICTIVE'
  loop
    raise notice 'DROPPING restrictive "%". To restore: create policy % on storage.objects as restrictive for % to % using (%)%;',
      r.policyname, quote_ident(r.policyname), r.cmd, r.roles, coalesce(r.qual,'true'),
      case when r.with_check is null then '' else ' with check ('||r.with_check||')' end;
    execute format('drop policy %I on storage.objects', r.policyname);
    n := n + 1;
  end loop;
  raise notice '--- dropped % restrictive policy/policies ---', n;

  -- The wide-open agents_deal_docs and any other leftover on the deal buckets.
  for r in select policyname from pg_policies
            where schemaname='storage' and tablename='objects'
              and policyname not like 'deal-documents:%' and policyname not like 'closing-packets:%'
              and (coalesce(qual,'')||' '||coalesce(with_check,'')) ~ 'deal-documents|closing-packets'
  loop
    raise notice 'DROPPING superseded "%"', r.policyname;
    execute format('drop policy %I on storage.objects', r.policyname);
  end loop;

  for r in select name, email from agents where auth_id is null loop
    raise notice 'NO LOGIN LINK: % (%) - agents.auth_id is NULL, RLS hides everything from them. Fix by hand.', r.name, r.email;
  end loop;
end $$;

create or replace function app_storage_deal_id(object_name text) returns uuid
language sql immutable set search_path=public as $$
  select nullif(substring(object_name from '^deal-([0-9a-fA-F-]{36})/'),'')::uuid $$;
grant execute on function app_storage_deal_id(text) to authenticated;

update storage.buckets set public=false where id in ('deal-documents','closing-packets','form-packets');

drop policy if exists "deal-documents: read"   on storage.objects;
drop policy if exists "deal-documents: upload" on storage.objects;
drop policy if exists "deal-documents: update" on storage.objects;
drop policy if exists "deal-documents: delete" on storage.objects;
drop policy if exists "closing-packets: read"  on storage.objects;
create policy "deal-documents: read"   on storage.objects for select to authenticated
  using (bucket_id='deal-documents' and (app_is_admin() or app_storage_deal_id(name) in (select app_visible_deal_ids())));
create policy "deal-documents: upload" on storage.objects for insert to authenticated
  with check (bucket_id='deal-documents' and (app_is_admin() or app_storage_deal_id(name) in (select app_visible_deal_ids())));
create policy "deal-documents: update" on storage.objects for update to authenticated
  using (bucket_id='deal-documents' and (app_is_admin() or app_storage_deal_id(name) in (select app_visible_deal_ids())))
  with check (bucket_id='deal-documents' and (app_is_admin() or app_storage_deal_id(name) in (select app_visible_deal_ids())));
create policy "deal-documents: delete" on storage.objects for delete to authenticated
  using (bucket_id='deal-documents' and (app_is_admin() or app_storage_deal_id(name) in (select app_visible_deal_ids())));
create policy "closing-packets: read"  on storage.objects for select to authenticated
  using (bucket_id='closing-packets' and (app_is_admin() or app_storage_deal_id(name) in (select app_visible_deal_ids())));
