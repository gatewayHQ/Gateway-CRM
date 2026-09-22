-- ═══════════════════════════════════════════════════════════════════════════
-- CONSOLIDATE DUPLICATE DEALS — office-wide
--
-- TWO PARTS. Run PART 1 alone first and read it. Only run PART 2 once you
-- agree with every keeper it picked.
--
-- WHAT A DUPLICATE IS HERE: two or more OPEN deals on the same property and
-- the same side. A buyer-side deal beside a seller-side one is normal business
-- and is never touched. Closed and lost deals are never touched.
--
-- WHAT PART 2 DOES, per group:
--   • picks a KEEPER — furthest along the pipeline, then most content, then
--     oldest. For a drafting record made by the office admin (a `lead` holding
--     envelopes) this correctly keeps the agent's real deal.
--   • moves the others' signature envelopes, document rows, tasks, timeline
--     notes and deal contacts ONTO the keeper
--   • marks the others `lost` with a note saying where their work went
--
-- IT DOES NOT DELETE ANYTHING. Deleting a deal cascades `boldsign_documents`
-- and `audit_log` — executed paperwork and compliance history. Marking the
-- loser `lost` frees the duplicate index (which only covers open stages),
-- keeps every row, and is reversible by setting the stage back.
--
-- WHAT IT CANNOT MOVE, and why it is reported instead:
--   • storage files. They live at `deal-<uuid>/…` and the path IS the link;
--     rewriting object rows in SQL risks desyncing metadata from the stored
--     object. Part 1 lists any loser holding files so you can download and
--     re-upload those few by hand.
--   • commissions. One row per deal by unique constraint, so a second cannot
--     be moved onto the keeper. It stays on the retired deal.
--   • checklist steps. Moving them would duplicate the keeper's own checklist.
-- ═══════════════════════════════════════════════════════════════════════════


-- ╔═════════════════════════════════════════════════════════════════════════╗
-- ║ PART 1 — REVIEW. Read-only. Run this on its own first.                  ║
-- ╚═════════════════════════════════════════════════════════════════════════╝

with open_dupes as (
  select d.*,
         coalesce(d.comp_data->>'transaction_type', 'unknown') as side_key,
         -- How far along, across both the residential and commercial tracks.
         case d.stage
           when 'due-diligence' then 6
           when 'under-contract' then 5  when 'psa' then 5
           when 'offer' then 4           when 'loi' then 4
           when 'showing' then 3         when 'on-market' then 3
           when 'listing-agreement' then 3 when 'active' then 3
           when 'qualified' then 2       when 'om-marketing' then 2
           else 1
         end as progress,
         (select count(*) from boldsign_documents b where b.deal_id = d.id) as envelopes,
         (select count(*) from storage.objects o
           where o.bucket_id = 'deal-documents' and o.name like 'deal-' || d.id || '/%') as files,
         (select count(*) from jsonb_object_keys(coalesce(d.comp_data, '{}'::jsonb))) as terms,
         (select count(*) from tasks t where t.deal_id = d.id) as tasks
    from deals d
   where d.property_id is not null
     and d.stage not in ('closed', 'lost')
),
grouped as (
  select *,
         count(*)      over w as in_group,
         row_number()  over (partition by property_id, side_key
                             order by progress desc,
                                      (envelopes + files + terms + tasks) desc,
                                      created_at asc) as rn
    from open_dupes
  window w as (partition by property_id, side_key)
)
select
  p.address,
  g.side_key                                            as side,
  case when g.rn = 1 then '>>> KEEP' else '    retire' end as action,
  left(g.id::text, 8)                                   as deal,
  a.name                                                as agent,
  g.stage,
  g.envelopes, g.files, g.terms, g.tasks,
  case when g.rn > 1 and g.files > 0
       then 'HAS FILES — download and re-upload these to the keeper by hand'
       else '' end                                      as warning
  from grouped g
  left join properties p on p.id = g.property_id
  left join agents a     on a.id = g.agent_id
 where g.in_group > 1
 order by p.address, g.side_key, g.rn;


-- ╔═════════════════════════════════════════════════════════════════════════╗
-- ║ PART 2 — CONSOLIDATE. Run only after reading Part 1.                    ║
-- ║ Everything is one transaction: it all applies or none of it does.       ║
-- ╚═════════════════════════════════════════════════════════════════════════╝
--
-- Uncomment from `begin;` to `commit;` and run.
--
-- begin;
--
-- create temp table dupe_plan on commit drop as
-- with open_dupes as (
--   select d.id, d.property_id, d.created_at,
--          coalesce(d.comp_data->>'transaction_type','unknown') as side_key,
--          case d.stage
--            when 'due-diligence' then 6
--            when 'under-contract' then 5  when 'psa' then 5
--            when 'offer' then 4           when 'loi' then 4
--            when 'showing' then 3         when 'on-market' then 3
--            when 'listing-agreement' then 3 when 'active' then 3
--            when 'qualified' then 2       when 'om-marketing' then 2
--            else 1 end as progress,
--          (select count(*) from boldsign_documents b where b.deal_id = d.id)
--        + (select count(*) from storage.objects o where o.bucket_id='deal-documents'
--            and o.name like 'deal-'||d.id||'/%')
--        + (select count(*) from jsonb_object_keys(coalesce(d.comp_data,'{}'::jsonb)))
--        + (select count(*) from tasks t where t.deal_id = d.id) as content
--     from deals d
--    where d.property_id is not null and d.stage not in ('closed','lost')
-- ),
-- ranked as (
--   select *, count(*) over (partition by property_id, side_key) as in_group,
--          first_value(id) over (partition by property_id, side_key
--                                order by progress desc, content desc, created_at asc) as keeper_id
--     from open_dupes
-- )
-- select id as loser_id, keeper_id from ranked
--  where in_group > 1 and id <> keeper_id;
--
-- -- Signature envelopes: the reason not to delete, and the reason to move.
-- -- Paperwork drafted on the wrong record is missing from the keeper's closing
-- -- packet, which merges by deal_id.
-- update boldsign_documents b set deal_id = pl.keeper_id
--   from dupe_plan pl where b.deal_id = pl.loser_id;
--
-- update document_versions v set deal_id = pl.keeper_id
--   from dupe_plan pl where v.deal_id = pl.loser_id;
--
-- update documents dc set deal_id = pl.keeper_id
--   from dupe_plan pl where dc.deal_id = pl.loser_id;
--
-- update tasks t set deal_id = pl.keeper_id
--   from dupe_plan pl where t.deal_id = pl.loser_id;
--
-- update activities ac set deal_id = pl.keeper_id
--   from dupe_plan pl where ac.deal_id = pl.loser_id;
--
-- -- deal_contacts is unique on (deal_id, contact_id): drop the rows that would
-- -- collide with one the keeper already has, then move the rest.
-- delete from deal_contacts dcx
--  using dupe_plan pl
--  where dcx.deal_id = pl.loser_id
--    and exists (select 1 from deal_contacts k
--                 where k.deal_id = pl.keeper_id and k.contact_id = dcx.contact_id);
-- update deal_contacts dcx set deal_id = pl.keeper_id
--   from dupe_plan pl where dcx.deal_id = pl.loser_id;
--
-- -- Retire, never delete. `lost` is outside the duplicate index, so this frees
-- -- it; every row on the retired deal survives and the stage can be set back.
-- update deals d
--    set stage = 'lost',
--        notes = coalesce(d.notes || E'\n', '')
--                || 'Retired ' || to_char(now(), 'YYYY-MM-DD')
--                || ' as a duplicate; its paperwork moved to deal ' || pl.keeper_id || '.'
--   from dupe_plan pl where d.id = pl.loser_id;
--
-- commit;


-- ╔═════════════════════════════════════════════════════════════════════════╗
-- ║ PART 3 — the backstop, once Part 2 has run.                             ║
-- ╚═════════════════════════════════════════════════════════════════════════╝
-- create unique index if not exists deals_one_open_per_property_side
--   on deals (property_id, (coalesce(comp_data->>'transaction_type','unknown')))
--   where property_id is not null and stage not in ('closed','lost');
