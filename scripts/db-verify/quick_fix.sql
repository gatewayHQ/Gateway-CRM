-- Paste-sized repair. No begin/commit on purpose: if one statement fails on
-- permissions, the rest still apply and you can see exactly which one broke.
create or replace function app_storage_deal_id(object_name text) returns uuid
language sql immutable set search_path=public as $$
  select nullif(substring(object_name from '^deal-([0-9a-fA-F-]{36})/'),'')::uuid $$;
grant execute on function app_storage_deal_id(text) to authenticated;

do $$ declare r record; begin
  for r in select policyname from pg_policies where schemaname='storage'
    and tablename='objects' and permissive='RESTRICTIVE'
    and coalesce(qual,'')||coalesce(with_check,'') ~ 'deal-documents|closing-packets'
  loop
    execute format('drop policy %I on storage.objects', r.policyname);
    raise notice 'DROPPED restrictive policy: %', r.policyname;
  end loop;
end $$;

drop policy if exists "deal-documents: read"   on storage.objects;
drop policy if exists "deal-documents: upload" on storage.objects;
drop policy if exists "deal-documents: update" on storage.objects;
drop policy if exists "deal-documents: delete" on storage.objects;
create policy "deal-documents: read"   on storage.objects for select to authenticated
  using (bucket_id='deal-documents' and (app_is_admin() or app_storage_deal_id(name) in (select app_visible_deal_ids())));
create policy "deal-documents: upload" on storage.objects for insert to authenticated
  with check (bucket_id='deal-documents' and (app_is_admin() or app_storage_deal_id(name) in (select app_visible_deal_ids())));
create policy "deal-documents: update" on storage.objects for update to authenticated
  using (bucket_id='deal-documents' and (app_is_admin() or app_storage_deal_id(name) in (select app_visible_deal_ids())))
  with check (bucket_id='deal-documents' and (app_is_admin() or app_storage_deal_id(name) in (select app_visible_deal_ids())));
create policy "deal-documents: delete" on storage.objects for delete to authenticated
  using (bucket_id='deal-documents' and (app_is_admin() or app_storage_deal_id(name) in (select app_visible_deal_ids())));

update deals d set co_agent_ids = sub.ids from (
  select d2.id, coalesce(array_agg(distinct x) filter (where x is distinct from d2.agent_id),'{}') as ids
    from deals d2 join properties p on p.id=d2.property_id
    cross join lateral (select (v)::uuid as x from jsonb_array_elements_text(p.details->'co_agent_ids') t(v)
                         where v ~ '^[0-9a-fA-F-]{36}$') ids
   where coalesce(array_length(d2.co_agent_ids,1),0)=0
     and jsonb_typeof(p.details->'co_agent_ids')='array'
   group by d2.id, d2.agent_id) sub
 where d.id=sub.id and coalesce(array_length(sub.ids,1),0)>0;
