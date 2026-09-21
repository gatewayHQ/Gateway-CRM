-- Migration 0053 — Deal documents, the whole fix, one file
-- ===========================================================================
-- SUPERSEDES 0049, 0051 and 0052. Apply this ALONE. It is self-contained and
-- idempotent; whether none, some or all of those ran first makes no difference.
--
-- ═══ THE ACTUAL ROOT CAUSE ═════════════════════════════════════════════════
--
-- A RESTRICTIVE policy on `storage.objects` scoped to `owner = auth.uid()`
-- WITH NO BUCKET CLAUSE.
--
-- Postgres has two kinds of row policy. PERMISSIVE ones (the default) are OR'd
-- together — any one granting is enough. RESTRICTIVE ones are AND'd, so every
-- one must pass. A single restrictive policy vetoes every permissive policy
-- there is.
--
-- This database's only deal-documents policy is wide open — the one the app's
-- own setup panel printed:
--
--     create policy "agents_deal_docs" on storage.objects for all to authenticated
--     using (bucket_id = 'deal-documents') with check (bucket_id = 'deal-documents');
--
-- On its own that grants every signed-in agent every file. But a restrictive
-- policy shaped like the Supabase "view their own data only" template:
--
--     as restrictive for select to authenticated using (owner = auth.uid())
--
-- ANDs on top of it, and the effective rule becomes `owner = auth.uid()`. The
-- uploader sees their files; nobody else sees anything. Reproduced exactly:
-- uploader 3 of 3, co-agent 0 of 3.
--
-- ═══ WHY IT TOOK THREE MIGRATIONS TO FIND ══════════════════════════════════
--
-- That restrictive policy names no bucket. Every query written to investigate
-- this — the diagnostics AND the discovery loop inside 0051 — filtered
-- policies by whether their body mentioned 'deal-documents':
--
--     and coalesce(qual,'') || coalesce(with_check,'') ~ 'deal-documents'
--
-- A bucket-agnostic policy matches nothing and is silently skipped. So the
-- diagnostic printed a clean bill of health for the one bucket policy it could
-- see, while the rule actually in force never appeared in the output at all.
-- The filter that was meant to avoid touching unrelated buckets is exactly
-- what hid the cause. This file looks at EVERY policy on storage.objects.
--
-- ═══ WHAT IT DOES, IN THIS ORDER (the order matters) ═══════════════════════
--
--   1. Prints every existing policy on storage.objects, unfiltered, with the
--      exact statement to recreate it. Nothing is dropped unrecorded.
--   2. Merges each linked property's co-agents into deals.co_agent_ids —
--      BEFORE anything narrows. Storage is wide open right now, so every agent
--      can currently read every deal's files; scoping to the deal takes access
--      away from anyone missing from that column. Filling it first means no
--      agent loses a document they can see today.
--   3. Drops every RESTRICTIVE policy on storage.objects. They can only
--      subtract, nothing in this repository creates one, and one of them is the
--      bug. Each is named, with its recreate statement, in a notice.
--   4. Replaces the wide-open `agents_deal_docs` with deal-scoped policies.
--      That closes the other half: right now any agent can open any other
--      agent's executed contracts.
--   5. Prints who can see what, so the result is visible without a second
--      round trip.
--
-- Read the NOTICES when it finishes — they are the report.
-- ===========================================================================

begin;

-- ── 1. Everything on storage.objects, unfiltered, before anything changes ──
do $$
declare r record; n int := 0;
begin
  raise notice '--- storage.objects policies BEFORE ---';
  for r in
    select policyname, permissive, cmd, array_to_string(roles, ',') as roles, qual, with_check
      from pg_policies where schemaname = 'storage' and tablename = 'objects'
     order by permissive, policyname
  loop
    n := n + 1;
    raise notice '[%] % / % / to %  USING(%)  CHECK(%)',
      r.permissive, r.policyname, r.cmd, r.roles, coalesce(r.qual,'-'), coalesce(r.with_check,'-');
  end loop;
  if n = 0 then raise notice '(none — the bucket has no policies at all)'; end if;
end $$;

-- ── 2. Co-agents FIRST, while storage is still wide open ──────────────────
-- A union, not a fill-if-empty: a deal already carrying one co-agent whose
-- property lists two would otherwise keep only the first, and the second agent
-- — the one the team card has been showing all along — would lose access the
-- moment step 4 narrows. Nothing is removed; the assigned agent is never also
-- a co-agent.
do $$
declare n int;
begin
  with filled as (
    update deals d set co_agent_ids = m.ids
      from (
        select d2.id,
               (select coalesce(array_agg(distinct x), '{}')
                  from (select unnest(coalesce(d2.co_agent_ids, '{}')) as x
                        union
                        select nullif(v, '')::uuid
                          from jsonb_array_elements_text(p.details->'co_agent_ids') as t(v)
                         where v ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                       ) s
                 where x is not null and x is distinct from d2.agent_id) as ids
          from deals d2 join properties p on p.id = d2.property_id
         where jsonb_typeof(p.details->'co_agent_ids') = 'array'
      ) m
     where d.id = m.id
       and not (d.co_agent_ids @> m.ids and d.co_agent_ids <@ m.ids)
    returning 1)
  select count(*) into n from filled;
  raise notice '--- co-agents: % deal(s) updated to match what their team card already showed ---', n;
end $$;

-- ── 3. The bug: every RESTRICTIVE policy, whatever bucket it names ────────
do $$
declare r record; n int := 0;
begin
  for r in
    select policyname, cmd, array_to_string(roles, ',') as roles, qual, with_check
      from pg_policies
     where schemaname = 'storage' and tablename = 'objects' and permissive = 'RESTRICTIVE'
  loop
    -- Printed so it is recoverable if it turns out to have been deliberate.
    raise notice 'DROPPING restrictive policy "%". To put it back: create policy % on storage.objects as restrictive for % to % using (%)%;',
      r.policyname, quote_ident(r.policyname), r.cmd, r.roles, coalesce(r.qual, 'true'),
      case when r.with_check is null then '' else ' with check (' || r.with_check || ')' end;
    execute format('drop policy %I on storage.objects', r.policyname);
    n := n + 1;
  end loop;
  if n = 0 then
    raise notice '--- no restrictive policy found on storage.objects ---';
  else
    raise notice '--- dropped % restrictive policy/policies — this was the veto ---', n;
  end if;
end $$;

-- ── 4. Scope the deal buckets to the deal ─────────────────────────────────
create or replace function app_storage_deal_id(object_name text)
returns uuid language sql immutable set search_path = public as $$
  select nullif(substring(object_name from
    '^deal-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/'), '')::uuid
$$;
grant execute on function app_storage_deal_id(text) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit)
values ('deal-documents', 'deal-documents', false, 52428800)
on conflict (id) do update set public = false;
insert into storage.buckets (id, name, public, file_size_limit)
values ('closing-packets', 'closing-packets', false, 104857600)
on conflict (id) do update set public = false;
insert into storage.buckets (id, name, public, file_size_limit)
values ('form-packets', 'form-packets', false, 52428800)
on conflict (id) do update set public = false;

-- The wide-open policy, and every uploader-scoped permissive leftover. These
-- are dropped by DISCOVERY as well: naming them was what missed the cause.
do $$
declare r record;
begin
  for r in
    select policyname from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname not like 'deal-documents:%'
       and policyname not like 'closing-packets:%'
       and policyname not like 'form-packets:%'
       and policyname not like 'campaign-%'
       and (coalesce(qual,'') || ' ' || coalesce(with_check,'')) ~ 'deal-documents|closing-packets'
  loop
    raise notice 'DROPPING superseded policy "%" on the deal buckets', r.policyname;
    execute format('drop policy %I on storage.objects', r.policyname);
  end loop;
end $$;

drop policy if exists "deal-documents: read"   on storage.objects;
drop policy if exists "deal-documents: upload" on storage.objects;
drop policy if exists "deal-documents: update" on storage.objects;
drop policy if exists "deal-documents: delete" on storage.objects;
drop policy if exists "closing-packets: read"  on storage.objects;
drop policy if exists "form-packets: read"         on storage.objects;
drop policy if exists "form-packets: admin write"  on storage.objects;
drop policy if exists "form-packets: admin update" on storage.objects;
drop policy if exists "form-packets: admin delete" on storage.objects;

create policy "deal-documents: read"   on storage.objects for select to authenticated
  using (bucket_id = 'deal-documents'
         and (app_is_admin() or app_storage_deal_id(name) in (select app_visible_deal_ids())));
create policy "deal-documents: upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'deal-documents'
         and (app_is_admin() or app_storage_deal_id(name) in (select app_visible_deal_ids())));
create policy "deal-documents: update" on storage.objects for update to authenticated
  using (bucket_id = 'deal-documents'
         and (app_is_admin() or app_storage_deal_id(name) in (select app_visible_deal_ids())))
  with check (bucket_id = 'deal-documents'
         and (app_is_admin() or app_storage_deal_id(name) in (select app_visible_deal_ids())));
create policy "deal-documents: delete" on storage.objects for delete to authenticated
  using (bucket_id = 'deal-documents'
         and (app_is_admin() or app_storage_deal_id(name) in (select app_visible_deal_ids())));

-- Packets are built with the service key and pointed at by the audit log, so
-- agents read and never write.
create policy "closing-packets: read" on storage.objects for select to authenticated
  using (bucket_id = 'closing-packets'
         and (app_is_admin() or app_storage_deal_id(name) in (select app_visible_deal_ids())));

-- Blank state forms at `IA/seller/…`: a shared catalog, not deal files. Mirrors
-- the form_packets TABLE — every agent reads, only office admins write.
create policy "form-packets: read" on storage.objects for select to authenticated
  using (bucket_id = 'form-packets');
create policy "form-packets: admin write" on storage.objects for insert to authenticated
  with check (bucket_id = 'form-packets' and app_is_admin());
create policy "form-packets: admin update" on storage.objects for update to authenticated
  using      (bucket_id = 'form-packets' and app_is_admin())
  with check (bucket_id = 'form-packets' and app_is_admin());
create policy "form-packets: admin delete" on storage.objects for delete to authenticated
  using (bucket_id = 'form-packets' and app_is_admin());

-- ── 5. The report ─────────────────────────────────────────────────────────
do $$
declare r record; n int := 0;
begin
  raise notice '--- storage.objects policies AFTER ---';
  for r in select policyname, permissive, cmd from pg_policies
            where schemaname = 'storage' and tablename = 'objects'
            order by permissive, policyname
  loop raise notice '[%] % / %', r.permissive, r.policyname, r.cmd; end loop;

  raise notice '--- deals whose team card still shows an agent RLS does not grant ---';
  for r in
    select d.id, d.title from deals d join properties p on p.id = d.property_id
     cross join lateral (select nullif(v,'')::uuid as shown
                           from jsonb_array_elements_text(p.details->'co_agent_ids') t(v)
                          where v ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') l
     where jsonb_typeof(p.details->'co_agent_ids') = 'array'
       and l.shown is distinct from d.agent_id
       and not (coalesce(d.co_agent_ids,'{}') @> array[l.shown])
     group by d.id, d.title
  loop n := n + 1; raise notice '  % (%) — the listed agent is not a real agent row', r.title, r.id; end loop;
  if n = 0 then raise notice '  none — every displayed co-agent is granted'; end if;

  for r in select name, email from agents where auth_id is null loop
    raise notice 'AGENT WITH NO LOGIN LINK: % (%) — agents.auth_id is NULL, so RLS hides everything from them regardless of policy. Fix by hand.', r.name, r.email;
  end loop;
end $$;

commit;

-- ── Verification ───────────────────────────────────────────────────────────
-- Read the notices above. Then, per deal, who can see its files:
--
-- select left(d.id::text,8) as deal, d.title,
--        coalesce(array_length(d.co_agent_ids,1),0) as co_agents,
--        (select count(*) from storage.objects o where o.bucket_id='deal-documents'
--          and o.name like 'deal-'||d.id||'/%') as files
--   from deals d order by files desc nulls last limit 20;
--
-- Nothing restrictive should remain:
-- select policyname, permissive from pg_policies
--  where schemaname='storage' and tablename='objects' order by permissive;
