-- ═══════════════════════════════════════════════════════════════════════════
-- ACCESS AUDIT — does this database match the access model the repo describes?
--
-- READ-ONLY. Changes nothing. Safe against production, any time.
--
-- Paste the whole file into the Supabase SQL Editor and read the output. Every
-- row is one check; sort puts failures first.
--
-- This is the same set of checks as `app_access_audit()` (migration 0050),
-- written as plain SQL so it ALSO works on a database where 0050 — or 0049, or
-- nothing at all — has been applied. Once 0050 is in, prefer:
--
--     select * from app_access_audit() order by (status = 'ok'), area, item;
--
-- WHY THIS EXISTS
--   A deal's documents were invisible to every agent but the one who uploaded
--   them, for months. The `deal-documents` bucket had been created by hand in
--   the dashboard, whose default policy template is `owner = auth.uid()`, and
--   nothing ever compared the live database to the repository. CI parses
--   schema.sql as text and passes whether or not a migration has been applied;
--   the app cannot read pg_policies; and a storage policy that hides rows
--   FILTERS them rather than erroring, so the screen stays calm while the data
--   is gone. This file closes that gap: it asks the database itself.
-- ═══════════════════════════════════════════════════════════════════════════

with
-- Every storage policy migration 0049 owns.
known as (
  select unnest(array[
    'deal-documents: read', 'deal-documents: upload',
    'deal-documents: update', 'deal-documents: delete',
    'closing-packets: read',
    'form-packets: read', 'form-packets: admin write',
    'form-packets: admin update', 'form-packets: admin delete'
  ]) as policyname
),
expected_buckets as (
  select unnest(array['deal-documents', 'closing-packets', 'form-packets']) as id
),
-- Rows belonging to a deal must defer to app_visible_deal_ids().
deal_tables as (
  select unnest(array[
    'deals', 'documents', 'document_versions', 'boldsign_documents',
    'closing_packets', 'transaction_steps', 'deal_contacts'
  ]) as tablename
),

-- ── 1. Buckets exist and are private ──────────────────────────────────────
-- A public bucket needs no signed URL and consults no policy at all.
bucket_checks as (
  select 'storage bucket' as area, e.id as item,
         case
           when b.id is null then 'FAIL'
           when b.public     then 'FAIL'
           else 'ok'
         end as status,
         case
           when b.id is null then 'MISSING — uploads fail and the Documents tab shows a setup panel. Apply migration 0049.'
           when b.public     then 'PUBLIC — every file in it is readable by URL with no session. Apply migration 0049, which forces it private.'
           else 'private'
         end as detail
    from expected_buckets e
    left join storage.buckets b on b.id = e.id
),

-- ── 2. The policies 0049 owns are all present ─────────────────────────────
missing_policies as (
  select 'storage policy' as area, k.policyname as item, 'FAIL' as status,
         'policy is missing — apply migration 0049.' as detail
    from known k
   where not exists (
     select 1 from pg_policies p
      where p.schemaname = 'storage' and p.tablename = 'objects'
        and p.policyname = k.policyname
   )
),

-- ── 3. THE BUG ITSELF ─────────────────────────────────────────────────────
-- Any policy on a DEAL bucket scoped to the uploader. Matched by BODY, not by
-- name, because the next one will be named something else.
rogue_policies as (
  select 'storage policy' as area, p.policyname as item,
         case when body ~ '\mowner\M' then 'FAIL' else 'warn' end as status,
         case when body ~ '\mowner\M'
           then 'scopes a DEAL bucket by uploader (`owner`) — this is the rule that hid a deal''s documents from its co-agent. Drop it: drop policy "' || p.policyname || '" on storage.objects;'
           else 'unrecognised policy on a deal bucket (' || p.cmd || '). Read its body; if it does not defer to app_visible_deal_ids() it is changing access outside version control.'
         end as detail
    from (
      select policyname, cmd,
             coalesce(qual, '') || ' ' || coalesce(with_check, '') as body
        from pg_policies
       where schemaname = 'storage' and tablename = 'objects'
    ) p
   where p.body ~ 'deal-documents|closing-packets'
     and (p.body ~ '\mowner\M' or p.policyname not in (select policyname from known))
),

-- ── 4. Deal-scoped tables still defer to deal visibility ──────────────────
-- RLS switched off means every policy on the table is inert and every agent
-- sees every row — and nothing in the UI would look different.
table_checks as (
  select 'table policy' as area, d.tablename as item,
         case
           when t.tablename is null then 'warn'
           when not c.relrowsecurity then 'FAIL'
           when not exists (
             select 1 from pg_policies p
              where p.schemaname = 'public' and p.tablename = d.tablename
                and (coalesce(p.qual,'') || ' ' || coalesce(p.with_check,''))
                    ~ 'app_visible_deal_ids|app_is_admin|app_current_agent_id'
           ) then 'FAIL'
           else 'ok'
         end as status,
         case
           when t.tablename is null then 'table not present in this database'
           when not c.relrowsecurity then 'ROW LEVEL SECURITY IS DISABLED — every signed-in agent can read and write every row.'
           when not exists (
             select 1 from pg_policies p
              where p.schemaname = 'public' and p.tablename = d.tablename
                and (coalesce(p.qual,'') || ' ' || coalesce(p.with_check,''))
                    ~ 'app_visible_deal_ids|app_is_admin|app_current_agent_id'
           ) then 'no policy defers to app_visible_deal_ids()/app_is_admin() — this table is not scoped to the deal.'
           else 'scoped'
         end as detail
    from deal_tables d
    left join pg_tables t on t.schemaname = 'public' and t.tablename = d.tablename
    left join pg_class c on c.relname = d.tablename
     and c.relnamespace = (select oid from pg_namespace where nspname = 'public')
),

-- ── 5. Role-less policies (the migration 0027 class) ──────────────────────
-- A policy with no `to <role>` applies to PUBLIC, which in Supabase includes
-- `anon` — and the anon key ships in the browser bundle.
anon_checks as (
  select 'anon exposure' as area,
         p.schemaname || '.' || p.tablename || ' / ' || p.policyname as item,
         'FAIL' as status,
         'policy has no TO clause, so it applies to PUBLIC — the anonymous key can use it. Re-create it with `to authenticated`.' as detail
    from pg_policies p
   where p.roles = '{public}'
     and p.schemaname in ('public', 'storage')
     -- Landing pages render campaign images straight from the public bucket.
     and p.policyname <> 'campaign-images: public read'
     -- The external website tracking snippet posts with the anon key.
     and p.policyname <> 'public_insert'
),

-- ── 6. The co-agent cache, behind its listing ─────────────────────────────
-- This used to mean "these agents have lost access": RLS read only
-- deals.co_agent_ids, so a co-agent the team card showed from the property saw
-- the card and nothing else on the deal.
--
-- Since migration 0055 access is DERIVED from the listing too, so a stale
-- column costs no access. What it still costs: the commission seed, the signer
-- prefill and /api/portal earnings read the cached column, so they can name a
-- smaller team than the deal page does. The sync triggers (check 10) correct it
-- on the next edit either side.
coagent_check as (
  select 'co-agent visibility' as area,
         'deals displaying a co-agent RLS does not grant' as item,
         case when count(*) > 0 then 'warn' else 'ok' end as status,
         case when count(*) > 0
           then count(*) || ' deal(s) carry a co-agent cache behind their listing. Since migration 0055 this costs no ACCESS, but the commission seed and signer prefill read the cached column. Fixed on the next edit either side; migration 0055 also aligns it once on apply.'
           else 'none'
         end as detail
    from deals d
    join properties p on p.id = d.property_id
   cross join lateral (
     select nullif(v, '')::uuid as shown
       from jsonb_array_elements_text(p.details->'co_agent_ids') as t(v)
      where v ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
   ) listed
   where jsonb_typeof(p.details->'co_agent_ids') = 'array'
     and listed.shown is distinct from d.agent_id
     and not (coalesce(d.co_agent_ids, '{}') @> array[listed.shown])
),

-- ── 6b. Is the LISTING part of the model in THIS database? ────────────────
-- The check that would have caught the bug 0055 fixes. `deals.co_agent_ids` is
-- a copy taken when the property was converted, and an existing deal never
-- re-seeds — so an agent added to a listing AFTER its deal was started reached
-- the team card and nothing else. Read out of the catalog: a file in the
-- repository proves nothing about what is installed.
deal_team_check as (
  select 'migration' as area, '0055 deal team access' as item,
         case
           when fn is null then 'FAIL'
           when fn like '%assigned_agent_id in (select app_my_agent_ids())%'
            and fn like '%app_jsonb_uuid_array(p.details -> ''co_agent_ids'')%' then 'ok'
           else 'FAIL'
         end as status,
         case
           when fn is null then 'app_visible_deal_ids() is missing entirely — no agent can see any deal. Run migrations/0055_deal_team_access.sql.'
           when fn like '%assigned_agent_id in (select app_my_agent_ids())%'
            and fn like '%app_jsonb_uuid_array(p.details -> ''co_agent_ids'')%'
             then 'deal access is derived from the listing as well as the deal'
           else 'NOT APPLIED — deal access still comes only from the copy taken when the property was converted, so an agent added to a listing AFTER its deal was started cannot see the deal or its documents. Run migrations/0055_deal_team_access.sql.'
         end as detail
    from (
      select (select pg_get_functiondef(pr.oid)
                from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
               where ns.nspname = 'public' and pr.proname = 'app_visible_deal_ids'
               limit 1) as fn
    ) f
),

-- ── 6c. The guard that makes deriving from the listing safe ───────────────
-- properties was `allow_all_authenticated` for every command: any signed-in
-- agent could rewrite any listing in the firm. With listing-derived deal access
-- that is a self-service grant — write yourself onto a listing, see someone
-- else's deal.
property_write_check as (
  select 'table policy' as area, 'properties write scope' as item,
         case when count(*) > 0 then 'FAIL' else 'ok' end as status,
         case when count(*) > 0
           then count(*) || ' wide-open for-ALL policy/policies on properties: every signed-in agent can rewrite any listing, which with listing-derived deal access lets anyone grant themselves someone else''s deal. Run migrations/0055_deal_team_access.sql.'
           else 'reads are firm-wide; writes require being on the listing'
         end as detail
    from pg_policies
   where schemaname = 'public' and tablename = 'properties'
     and permissive = 'PERMISSIVE' and cmd = 'ALL'
     and coalesce(qual, 'true') = 'true'
),

-- ── 6d. The triggers that keep the cache in step ──────────────────────────
sync_trigger_check as (
  select 'co-agent sync' as area, 'listing <-> deal triggers' as item,
         case when count(*) = 2 then 'ok' else 'FAIL' end as status,
         case when count(*) = 2 then 'both directions installed'
           else count(*) || ' of 2 sync triggers present. Without them the team a deal DISPLAYS can drift from the team it pays. Run migrations/0055_deal_team_access.sql.'
         end as detail
    from pg_trigger
   where not tgisinternal
     and tgname in ('trg_property_coagents_to_deals', 'trg_deal_coagents_to_property')
),

-- ── 6e. Agents whose login may not resolve to their roster row ────────────
-- Before migration 0055 a NULL auth_id meant matching no policy anywhere: a
-- blank CRM, whatever the co-agent columns said. They now resolve by the
-- verified email on their login — but only if it matches the row exactly.
identity_check as (
  select 'identity' as area, 'agents with no login link' as item,
         case when count(*) = 0 then 'ok' else 'warn' end as status,
         case when count(*) = 0 then 'every agent row is linked to a login'
           else count(*) || ' agent row(s) have agents.auth_id = NULL. They resolve by the verified email on their login instead of seeing nothing — but only if that email matches the row exactly. Set auth_id by hand where it does not.'
         end as detail
    from agents where auth_id is null
),

-- ── 7. Are the migrations actually applied? ───────────────────────────────
-- Last, so it reads as the explanation for everything above it: a run full of
-- FAILs plus this one means "apply the migration", not "investigate".
migration_checks as (
  select 'migration' as area, '0049 deal document storage RLS' as item,
         case when exists (
           select 1 from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
            where ns.nspname = 'public' and pr.proname = 'app_storage_deal_id'
         ) then 'ok' else 'FAIL' end as status,
         case when exists (
           select 1 from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
            where ns.nspname = 'public' and pr.proname = 'app_storage_deal_id'
         ) then 'applied'
         else 'NOT APPLIED — deal documents are still scoped by whoever uploaded them. Run migrations/0049_deal_document_storage_rls.sql.' end as detail
  union all
  select 'migration', '0050 access audit',
         case when exists (
           select 1 from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
            where ns.nspname = 'public' and pr.proname = 'app_access_audit'
         ) then 'ok' else 'warn' end,
         case when exists (
           select 1 from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
            where ns.nspname = 'public' and pr.proname = 'app_access_audit'
         ) then 'applied — the nightly cron can run this audit for you'
         else 'not applied — this file still works, but nothing audits the database on its own. Run migrations/0050_access_audit.sql.' end
)

-- Failures first, then warnings, then everything that is fine.
select area, item, status, detail from (
  select * from bucket_checks
  union all select * from missing_policies
  union all select * from rogue_policies
  union all select * from table_checks
  union all select * from anon_checks
  union all select * from coagent_check
  union all select * from deal_team_check
  union all select * from property_write_check
  union all select * from sync_trigger_check
  union all select * from identity_check
  union all select * from migration_checks
) findings
order by case status when 'FAIL' then 0 when 'warn' then 1 else 2 end, area, item;
