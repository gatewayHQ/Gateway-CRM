-- ═══════════════════════════════════════════════════════════════════════════
-- WHY CAN'T THIS AGENT SEE THE DEAL'S DOCUMENTS?
--
-- READ-ONLY. Changes nothing. Paste the whole thing into the Supabase SQL
-- Editor and send the output back.
--
-- ONE statement on purpose: the SQL Editor only displays the result of the
-- LAST statement in a script, so a diagnostic split into several SELECTs shows
-- you the answer to one question and silently drops the rest. Everything here
-- is UNION ALL'd into a single table of (step, finding, detail).
--
-- No dollar-quoted blocks either — the Editor's statement splitter understands
-- `$$` but not a custom `$tag$`, and cuts the script in half at the first `;`
-- inside one. That is the "syntax error at end of input / LINE 0" with nothing
-- underneath it.
--
-- Run this when migration 0049 has been applied and an agent still sees "No
-- documents yet" on a deal that has files. It answers, in order: did 0049
-- actually commit, is something still overriding it, and is the agent on the
-- deal in the way the database understands.
-- ═══════════════════════════════════════════════════════════════════════════

select step, finding, detail from (

-- ── A. Did 0049 commit? ────────────────────────────────────────────────────
-- 0049 is wrapped in begin/commit, so ONE failed statement rolls back all of
-- it. If the function is missing, nothing in 0049 applied — whatever error the
-- editor showed is the whole story, and the policies below will be missing too.
select 'A. migration' as step,
       'app_storage_deal_id() function' as finding,
       case when exists (
         select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'app_storage_deal_id'
       ) then 'present — 0049 committed'
         else 'MISSING — 0049 did NOT commit. Re-run it and copy the exact error.' end as detail

union all
select 'A. migration', 'app_visible_deal_ids() function',
       case when exists (
         select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'app_visible_deal_ids'
       ) then 'present' else 'MISSING — the whole deal visibility model is absent (migration 0011/0025).' end

-- ── B. Can this role even write storage policies? ──────────────────────────
-- `storage.objects` is owned by `supabase_storage_admin`. Creating or dropping
-- a policy on it requires ownership, and the SQL Editor runs as `postgres`. On
-- some projects postgres is a member of that role and it just works; on others
-- the same statement raises `42501: must be owner of table objects` — which,
-- inside 0049's transaction, silently rolls back everything else too.
union all
select 'B. permissions', 'storage.objects owner vs current role',
       'owner=' || coalesce((
         select pg_get_userbyid(c.relowner) from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'storage' and c.relname = 'objects'), '?')
       || ' · you=' || current_user
       || ' · member of owner: ' || coalesce((
         select case when pg_has_role(current_user, c.relowner, 'USAGE') then 'YES' else 'NO — policy writes on storage.objects will fail with 42501' end
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'storage' and c.relname = 'objects'), '?')

union all
select 'B. permissions', 'row level security on storage.objects',
       coalesce((
         select case when c.relrowsecurity then 'enabled' else 'DISABLED — policies here are inert' end
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'storage' and c.relname = 'objects'), 'table not found')

-- ── C. Are the 0049 policies actually there? ───────────────────────────────
union all
select 'C. policies', 'deal-documents policies from 0049',
       coalesce((select count(*)::text from pg_policies
                  where schemaname='storage' and tablename='objects'
                    and policyname like 'deal-documents:%'), '0') || ' of 4 present'

-- ── D. Is anything still overriding them? ──────────────────────────────────
-- THE DECISIVE CHECK. Permissive policies OR together, so 0049 can only widen
-- access — UNLESS a leftover policy is RESTRICTIVE, which ANDs instead. A
-- restrictive `owner = auth.uid()` survives 0049 completely and still hides
-- every file from everyone but its uploader. Read the `permissive` column.
union all
select 'D. conflicts',
       p.policyname || '  [' || p.permissive || ' · ' || p.cmd || ' · ' || array_to_string(p.roles, ',') || ']',
       case
         when p.permissive = 'RESTRICTIVE'
           then 'RESTRICTIVE — this ANDs with everything and can block on its own. ' ||
                case when coalesce(p.qual,'') ~ '\mowner\M' then 'It scopes by UPLOADER. This is almost certainly your problem: drop policy "' || p.policyname || '" on storage.objects;'
                     else 'Read its body below.' end
         when coalesce(p.qual,'') || coalesce(p.with_check,'') ~ '\mowner\M'
           then 'permissive but scopes by uploader — harmless alongside 0049, still worth dropping.'
         else 'ok'
       end
  from pg_policies p
 where p.schemaname = 'storage' and p.tablename = 'objects'
   and (coalesce(p.qual,'') || ' ' || coalesce(p.with_check,'')) ~ 'deal-documents'
   and (p.permissive = 'RESTRICTIVE' or (coalesce(p.qual,'') || coalesce(p.with_check,'')) ~ '\mowner\M')

-- ── E. Is the agent on the deal in the way the DATABASE understands? ───────
-- The "Agents on deal" card reads deals.co_agent_ids and FALLS BACK to the
-- linked property (src/lib/coAgents.js). RLS reads only the column. So the
-- card can name someone the database has never heard of — they see the deal
-- header and nothing filed under it. `granted` below is the column RLS uses;
-- `displayed only` is the property fallback that RLS cannot see.
union all
select 'E. deal',
       coalesce(d.title, '(untitled)') || '  ' || left(d.id::text, 8),
       'assigned=' || coalesce(left(d.agent_id::text, 8), 'none')
       || ' · granted co-agents=' || coalesce(array_length(d.co_agent_ids, 1), 0)::text
       || ' · displayed-only via property=' || coalesce((
            select jsonb_array_length(pr.details->'co_agent_ids') from properties pr
             where pr.id = d.property_id and jsonb_typeof(pr.details->'co_agent_ids') = 'array'), 0)::text
       || case when coalesce(array_length(d.co_agent_ids,1),0) = 0
                and coalesce((select jsonb_array_length(pr.details->'co_agent_ids') from properties pr
                               where pr.id = d.property_id and jsonb_typeof(pr.details->'co_agent_ids')='array'),0) > 0
               then '  <-- card shows a co-agent RLS does NOT grant. Re-run 0049 step 7 (the backfill).'
               else '' end
  from deals d
 where d.title ilike '%7th St%'        -- <<< EDIT THIS to match the deal in question
    or d.id::text = '00000000-0000-0000-0000-000000000000'

-- ── F. Does each agent resolve to a database identity? ────────────────────
-- app_current_agent_id() maps auth.uid() -> agents.auth_id. An agent whose
-- auth_id is null resolves to NULL, and every `in (select app_visible_deal_ids())`
-- test then yields NULL, which is not TRUE — they see nothing, anywhere.
union all
select 'F. identity', a.name || '  ' || left(a.id::text, 8),
       case when a.auth_id is null
            then 'auth_id is NULL — this agent resolves to no identity and RLS hides everything from them.'
            else 'auth_id set' || case when a.is_admin then ' · office admin' else '' end end
  from agents a
 where a.id in (
   select d.agent_id from deals d where d.title ilike '%7th St%'    -- <<< same filter as E
   union
   select unnest(d.co_agent_ids) from deals d where d.title ilike '%7th St%'
   union
   -- The agents the CARD shows via the property fallback. They must be here:
   -- the whole complaint is about someone the screen says is on the deal, and
   -- if their auth_id is null that is the answer on its own.
   select (jsonb_array_elements_text(pr.details->'co_agent_ids'))::uuid
     from deals d join properties pr on pr.id = d.property_id
    where d.title ilike '%7th St%'
      and jsonb_typeof(pr.details->'co_agent_ids') = 'array'
 )

-- ── G. Are there files to see at all? ─────────────────────────────────────
-- If this is 0, the tab is right and the files were never uploaded to the path
-- the app reads (`deal-<uuid>/`).
union all
select 'G. files', 'objects under this deal''s prefix',
       coalesce((select count(*)::text from storage.objects o
                  where o.bucket_id = 'deal-documents'
                    and o.name like 'deal-' || (select d.id from deals d where d.title ilike '%7th St%' limit 1) || '/%'), '0')

) findings
order by step, finding;
