-- Paste-sized diagnostic. Read-only. Edit '7th St' to match the deal.
select 'migration 0049' as check, case when to_regproc('app_storage_deal_id') is null
       then 'NOT APPLIED' else 'applied' end as result
union all
select 'policy: '||policyname, permissive||' / '||cmd||
       case when coalesce(qual,'')~'\mowner\M' then ' / SCOPED BY UPLOADER' else '' end
  from pg_policies where schemaname='storage' and tablename='objects'
   and coalesce(qual,'')||coalesce(with_check,'') ~ 'deal-documents'
union all
select 'deal '||left(d.id::text,8), 'granted co-agents='||coalesce(array_length(d.co_agent_ids,1),0)
       ||' shown-via-property='||coalesce(jsonb_array_length(p.details->'co_agent_ids'),0)
  from deals d left join properties p on p.id=d.property_id
 where d.title ilike '%7th St%'
union all
select 'agent '||a.name, case when a.auth_id is null then 'NO auth_id - invisible to RLS' else 'ok' end
  from agents a where a.auth_id is null
union all
select 'files on deal', count(*)::text from storage.objects o
 where o.bucket_id='deal-documents'
   and o.name like 'deal-'||(select id from deals where title ilike '%7th St%' limit 1)||'/%';
