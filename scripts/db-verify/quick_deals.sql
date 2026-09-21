-- Which deal row are the files actually under? Read-only.
-- Edit '7th St' to match. One row per deal that shares the address.
select left(d.id::text,8) as deal, d.title, d.stage,
       a.name as assigned, d.created_at::date as created,
       coalesce(array_length(d.co_agent_ids,1),0) as co_agents,
       (select count(*) from storage.objects o
         where o.bucket_id='deal-documents'
           and o.name like 'deal-'||d.id||'/%') as files
  from deals d left join agents a on a.id=d.agent_id
 where d.title ilike '%7th St%'
 order by files desc, d.created_at;
