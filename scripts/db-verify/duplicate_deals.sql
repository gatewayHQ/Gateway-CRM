-- Duplicate deals on one property. READ-ONLY.
--
-- Everything on a deal hangs off its id: deal terms (comp_data), documents
-- (storage path `deal-<uuid>/`), key dates, tasks, commission, signatures. Two
-- rows for the same property are two parallel sets with nothing joining them,
-- which is why work done on one never appears on the other.
--
-- Nothing prevents this today: deals.property_id has an index but no unique
-- constraint, and all three creation paths (Properties "Start Deal",
-- the pipeline deal drawer, QuickAdd) insert without checking.
--
-- `files` is the count under that deal's own storage prefix. The row with the
-- most filled terms and the most files is the one that has been worked.
select
  coalesce(p.address, d.title)                              as property,
  left(d.id::text, 8)                                       as deal,
  a.name                                                    as primary_agent,
  d.stage,
  d.created_at::date                                        as created,
  coalesce(array_length(d.co_agent_ids, 1), 0)              as co_agents,
  (select count(*) from jsonb_object_keys(coalesce(d.comp_data, '{}'::jsonb))) as terms_filled,
  (select count(*) from storage.objects o
    where o.bucket_id = 'deal-documents'
      and o.name like 'deal-' || d.id || '/%')              as files,
  (select count(*) from tasks t where t.deal_id = d.id)     as tasks,
  (select count(*) from boldsign_documents b where b.deal_id = d.id) as signatures
  from deals d
  left join properties p on p.id = d.property_id
  left join agents a on a.id = d.agent_id
 where d.property_id in (
   -- properties carrying more than one deal
   select property_id from deals
    where property_id is not null
    group by property_id having count(*) > 1
 )
 order by property, files desc, terms_filled desc, d.created_at;
