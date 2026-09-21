-- Migration 0051 — Make 0049 actually stick
-- ===========================================================================
-- RUN THIS IF DOCUMENTS ARE STILL HIDDEN AFTER APPLYING 0049.
--
-- Safe to run whether or not 0049 applied. It re-asserts everything 0049 does
-- and then fixes the two ways 0049 could apply cleanly and still change nothing.
--
-- ── WHAT 0049 GOT WRONG ────────────────────────────────────────────────────
-- 0049 said: "permissive policies OR together, so this only ever widens."
-- True, and incomplete. Postgres has TWO kinds of policy:
--
--   PERMISSIVE  (the default) — OR'd together. Any one of them granting is
--               enough. 0049's reasoning holds.
--   RESTRICTIVE — AND'd with the result. Every one of them must pass. One
--               restrictive policy can veto every permissive policy there is.
--
-- The Supabase dashboard's "Give users access to own folder" template can be
-- created either way. If the leftover on `deal-documents` is RESTRICTIVE, then
-- after 0049 the check is:
--
--     (deal is visible to me)  AND  (owner = auth.uid())
--
-- and a co-agent still sees nothing. 0049 drops leftovers by four exact NAMES,
-- so a restrictive policy called anything else survives it untouched. Measured
-- on Postgres 16 against a deal with three files: co-agent sees 0 with the
-- restrictive policy in place, 3 after dropping it. Same 0049 policies both
-- times — the migration looked applied, because it was.
--
-- ── AND THE OTHER WAY IT LOOKS APPLIED BUT ISN'T ──────────────────────────
-- 0049 runs inside begin/commit, so ONE failed statement rolls back ALL of it.
-- The likeliest failure is `42501: must be owner of table objects` — in
-- Supabase, `storage.objects` belongs to `supabase_storage_admin`, and whether
-- the SQL Editor's role may write policies on it varies by project. Step 1
-- below checks that FIRST and says so in plain words, instead of letting the
-- error scroll past and the rollback go unnoticed.
--
-- ── SAFETY ─────────────────────────────────────────────────────────────────
-- Restrictive policies on the two DEAL buckets are dropped by DISCOVERY, not
-- by name, because the next one will be named something else. That is the one
-- place this file guesses, and it is bounded: a restrictive policy on these
-- buckets can only narrow access below what the deal already grants, nothing
-- in this repository ever creates one, and each one dropped is NAMED in a
-- notice so the change is never silent.
--
-- PERMISSIVE leftovers are only REPORTED, never dropped — they can only widen,
-- and dropping one could take away access somebody is relying on right now
-- (an object sitting at the bucket root, outside any `deal-<uuid>/` prefix).
--
-- No object is moved, renamed or deleted. Read the notices when it finishes.
-- ===========================================================================

begin;

-- ── 1. Can this role write storage policies at all? ────────────────────────
-- Asked before anything else, so the answer is the first thing you read rather
-- than a rollback you have to infer.
do $$
declare owner_role text;
begin
  select pg_get_userbyid(c.relowner) into owner_role
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'storage' and c.relname = 'objects';

  if owner_role is null then
    raise exception 'storage.objects does not exist — is this a Supabase database?';
  end if;

  if not pg_has_role(current_user, owner_role::regrole::oid, 'USAGE') then
    raise exception
      'This role (%) is not a member of %, which owns storage.objects, so it cannot create policies on it (42501). Nothing has been changed. Apply the deal-documents policies from Storage -> Policies in the dashboard instead, or ask Supabase support to grant it.',
      current_user, owner_role;
  end if;
end $$;

-- ── 2. Everything 0049 does, restated ──────────────────────────────────────
-- Idempotent, and self-contained on purpose: if 0049 rolled back, this file
-- alone is enough. If it applied, every statement here is a no-op.
create or replace function app_storage_deal_id(object_name text)
returns uuid language sql immutable set search_path = public as $$
  select nullif(substring(
    object_name from
    '^deal-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/'
  ), '')::uuid
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

-- ── 3. Clear the vetoes ────────────────────────────────────────────────────
-- Every RESTRICTIVE policy on the two deal buckets, whatever it is called.
-- This is the fix. Each one is named in a notice as it goes.
do $$
declare
  r record;
  dropped int := 0;
  reported int := 0;
begin
  for r in
    select policyname, cmd, permissive,
           coalesce(qual, '') || ' ' || coalesce(with_check, '') as body
      from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and (coalesce(qual, '') || ' ' || coalesce(with_check, ''))
           ~ 'deal-documents|closing-packets'
  loop
    if r.permissive = 'RESTRICTIVE' then
      -- A restrictive policy ANDs with the deal check and can veto it outright.
      -- This is what makes a correctly-applied 0049 look like it did nothing.
      execute format('drop policy %I on storage.objects', r.policyname);
      dropped := dropped + 1;
      raise notice 'DROPPED restrictive policy "%" (% on %) — it was ANDed with the deal check and could veto it. Body: %',
        r.policyname, r.cmd, 'storage.objects', r.body;
    elsif r.body ~ '\mowner\M' and r.policyname not like 'deal-documents:%'
                               and r.policyname not like 'closing-packets:%' then
      -- Permissive, so it can only widen. Left in place deliberately; dropping
      -- it could take away access to an object outside any deal- prefix.
      reported := reported + 1;
      -- `raise notice` has no %I — only format() does — so the identifier is
      -- quoted explicitly here. Printing an unusable drop statement would be
      -- worse than printing none.
      raise notice 'LEFT IN PLACE: permissive policy "%" scopes by uploader. Harmless alongside the deal policies, but you can drop it once you are satisfied: drop policy % on storage.objects;',
        r.policyname, quote_ident(r.policyname);
    end if;
  end loop;

  if dropped = 0 then
    raise notice 'No restrictive policy was blocking the deal buckets.';
  end if;
  if reported = 0 and dropped = 0 then
    raise notice 'No leftover uploader-scoped policy found either — if documents are still hidden, the cause is not storage policy. Run scripts/db-verify/deal_documents_diagnose.sql.';
  end if;
end $$;

-- The four names 0049 knew about, in case 0049 itself never ran.
drop policy if exists "agents_deal_docs" on storage.objects;
drop policy if exists "Give users access to own folder 1oj01fe_0" on storage.objects;
drop policy if exists "Give users access to own folder 1oj01fe_1" on storage.objects;
drop policy if exists "Give users access to own folder 1oj01fe_2" on storage.objects;
drop policy if exists "Give users access to own folder 1oj01fe_3" on storage.objects;

-- ── 4. The deal-scoped policies ────────────────────────────────────────────
drop policy if exists "deal-documents: read" on storage.objects;
create policy "deal-documents: read"
  on storage.objects for select to authenticated
  using (bucket_id = 'deal-documents'
         and (app_is_admin() or app_storage_deal_id(name) in (select app_visible_deal_ids())));

drop policy if exists "deal-documents: upload" on storage.objects;
create policy "deal-documents: upload"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'deal-documents'
         and (app_is_admin() or app_storage_deal_id(name) in (select app_visible_deal_ids())));

drop policy if exists "deal-documents: update" on storage.objects;
create policy "deal-documents: update"
  on storage.objects for update to authenticated
  using (bucket_id = 'deal-documents'
         and (app_is_admin() or app_storage_deal_id(name) in (select app_visible_deal_ids())))
  with check (bucket_id = 'deal-documents'
         and (app_is_admin() or app_storage_deal_id(name) in (select app_visible_deal_ids())));

drop policy if exists "deal-documents: delete" on storage.objects;
create policy "deal-documents: delete"
  on storage.objects for delete to authenticated
  using (bucket_id = 'deal-documents'
         and (app_is_admin() or app_storage_deal_id(name) in (select app_visible_deal_ids())));

drop policy if exists "closing-packets: read" on storage.objects;
create policy "closing-packets: read"
  on storage.objects for select to authenticated
  using (bucket_id = 'closing-packets'
         and (app_is_admin() or app_storage_deal_id(name) in (select app_visible_deal_ids())));

drop policy if exists "form-packets: read" on storage.objects;
create policy "form-packets: read"
  on storage.objects for select to authenticated
  using (bucket_id = 'form-packets');

drop policy if exists "form-packets: admin write" on storage.objects;
create policy "form-packets: admin write"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'form-packets' and app_is_admin());

drop policy if exists "form-packets: admin update" on storage.objects;
create policy "form-packets: admin update"
  on storage.objects for update to authenticated
  using      (bucket_id = 'form-packets' and app_is_admin())
  with check (bucket_id = 'form-packets' and app_is_admin());

drop policy if exists "form-packets: admin delete" on storage.objects;
create policy "form-packets: admin delete"
  on storage.objects for delete to authenticated
  using (bucket_id = 'form-packets' and app_is_admin());

-- ── 5. The co-agent backfill, again ────────────────────────────────────────
-- Restated for the same reason as everything above: if 0049 rolled back, this
-- never ran. The "Agents on deal" card falls back to the linked property to
-- DISPLAY co-agents while RLS reads only deals.co_agent_ids — so until these
-- agree, the card names someone the database has never heard of, and fixing
-- the storage policy does nothing for them.
do $$
declare n int;
begin
  with filled as (
    update deals d
       set co_agent_ids = sub.ids
      from (
        select d2.id,
               coalesce(array_agg(distinct x) filter (where x is distinct from d2.agent_id), '{}') as ids
          from deals d2
          join properties p on p.id = d2.property_id
          cross join lateral (
            select nullif(v, '')::uuid as x
              from jsonb_array_elements_text(p.details->'co_agent_ids') as t(v)
             where v ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
          ) ids
         where coalesce(array_length(d2.co_agent_ids, 1), 0) = 0
           and jsonb_typeof(p.details->'co_agent_ids') = 'array'
         group by d2.id, d2.agent_id
      ) sub
     where d.id = sub.id
       and coalesce(array_length(sub.ids, 1), 0) > 0
    returning 1
  )
  select count(*) into n from filled;
  raise notice 'Co-agent backfill: % deal(s) gained the co-agents their team card was already showing.', n;
end $$;

-- ── 6. An agent with no identity sees nothing, anywhere ────────────────────
-- app_current_agent_id() maps auth.uid() -> agents.auth_id. An agent whose
-- auth_id is NULL resolves to NULL, every `in (select app_visible_deal_ids())`
-- yields NULL rather than TRUE, and RLS hides everything from them — no policy
-- in this file can help. Reported, never guessed at: linking the wrong auth
-- user to an agent hands them somebody else's book of business.
do $$
declare r record; n int := 0;
begin
  for r in select name, email from agents where auth_id is null order by name loop
    n := n + 1;
    raise notice 'AGENT WITHOUT AN IDENTITY: % (%) — agents.auth_id is NULL, so RLS hides every record from them. Match it to their auth user id by hand.', r.name, r.email;
  end loop;
  if n = 0 then
    raise notice 'Every agent has an auth_id.';
  end if;
end $$;

commit;

-- ── Verification ───────────────────────────────────────────────────────────
-- Read the NOTICES above first — they say what was dropped and what was left.
--
-- Then, the whole picture in one query:
--   scripts/db-verify/deal_documents_diagnose.sql
--
-- Or, if 0050 is applied:
--   select * from app_access_audit() order by (status = 'ok'), area, item;
--
-- Nothing restrictive should remain on the deal buckets:
-- select policyname, permissive, cmd, roles, qual from pg_policies
--  where schemaname='storage' and tablename='objects' order by permissive, policyname;
