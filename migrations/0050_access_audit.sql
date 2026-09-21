-- Migration 0050 — Access audit: catch the next silent visibility hole
-- ===========================================================================
-- WHY
--   Migration 0049 fixed the deal-documents bucket: it had been created by
--   hand in the Supabase dashboard, whose default policy template is
--   `owner = auth.uid()`, so an uploader saw their files and no co-agent did.
--
--   The policy is fixed. The CONDITION that produced it is not. Nothing
--   anywhere compares the live database to what this repository says it should
--   be. CI parses `schema.sql` as text and passes whether or not a single
--   migration has been applied; the app cannot read `pg_policies`; and a
--   storage policy that hides rows FILTERS them rather than erroring, so the
--   screen looks calm while the data is gone. That combination is how one
--   dashboard click stayed invisible for months — and it would hide the next
--   one exactly as well.
--
--   Every part of the access model is one click from the same failure:
--     • a bucket flipped public (executed contracts readable by URL)
--     • a policy re-created without a `to authenticated` clause, which means
--       PUBLIC, which includes the anon key that ships in the browser bundle
--       (migration 0027 fixed eight tables that had exactly this)
--     • a scoped table's policy dropped or rewritten
--     • RLS disabled outright
--     • a co-agent displayed on a deal the database never granted them
--
-- WHAT
--   `app_access_audit()` — one function that checks the live database against
--   the access model and returns a row per finding. Read-only: it changes
--   nothing, ever, so it is safe to run against production at any time.
--
--   It is called three ways:
--     1. nightly by /api/cron?task=access-audit, which notifies every office
--        admin in-app the first time something fails
--     2. by an office admin in Settings → whenever they want
--     3. by hand in the SQL editor: `select * from app_access_audit();`
--
--   `scripts/db-verify/access_audit.sql` runs the SAME checks as raw SQL, so
--   you can audit a database where this migration has not been applied yet.
--
-- READING THE OUTPUT
--   status 'ok'   — matches the model
--          'FAIL' — an access hole or a missing guard. Act on it.
--          'warn' — drift that is not yet a hole (a pending migration, a
--                   display/permission mismatch). Worth knowing, not urgent.
--
-- SAFETY
--   Additive. One new function, no table touched, no policy changed.
-- ===========================================================================

begin;

drop function if exists app_access_audit();

create or replace function app_access_audit()
returns table (area text, item text, status text, detail text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  is_service boolean;
  -- The buckets whose contents are scoped to a deal. `form-packets` is a
  -- deliberately shared catalog and is checked separately.
  deal_buckets text[] := array['deal-documents', 'closing-packets'];
  -- Every storage policy migration 0049 owns. Anything else on these buckets
  -- is a leftover, and is reported.
  known_storage_policies text[] := array[
    'deal-documents: read', 'deal-documents: upload',
    'deal-documents: update', 'deal-documents: delete',
    'closing-packets: read',
    'form-packets: read', 'form-packets: admin write',
    'form-packets: admin update', 'form-packets: admin delete'
  ];
  -- Tables whose rows belong to a deal and must defer to app_visible_deal_ids().
  deal_scoped_tables text[] := array[
    'deals', 'documents', 'document_versions', 'boldsign_documents',
    'closing_packets', 'transaction_steps', 'deal_contacts'
  ];
  r record;
  n integer;
begin
  -- Findings name policies and buckets, which is a map of where the guards are
  -- and where they are missing. Office admins and the server only.
  is_service :=
       current_user = 'service_role'
    or coalesce(current_setting('role', true), '') = 'service_role'
    or coalesce(auth.jwt() ->> 'role', '') = 'service_role'
    or coalesce(current_setting('request.jwt.claim.role', true), '') = 'service_role'
    or (auth.uid() is null and current_user in ('postgres', 'supabase_admin'));

  if not (is_service or app_is_admin()) then
    raise exception 'app_access_audit() is restricted to office admins';
  end if;

  -- ── 1. Buckets exist and are private ─────────────────────────────────────
  foreach item in array (deal_buckets || array['form-packets']) loop
    area := 'storage bucket';
    if not exists (select 1 from storage.buckets b where b.id = item) then
      status := 'FAIL';
      detail := 'bucket is missing — uploads fail and the Documents tab shows a setup panel. Apply migration 0049.';
    elsif exists (select 1 from storage.buckets b where b.id = item and b.public) then
      -- A public bucket needs no signed URL and consults no policy at all.
      status := 'FAIL';
      detail := 'bucket is PUBLIC — every file in it is readable by URL with no session. Apply migration 0049, which forces it private.';
    else
      status := 'ok';
      detail := 'private';
    end if;
    return next;
  end loop;

  -- ── 2. The deal buckets defer to deal visibility ─────────────────────────
  area := 'storage policy';
  foreach item in array known_storage_policies loop
    if not exists (
      select 1 from pg_policies p
       where p.schemaname = 'storage' and p.tablename = 'objects'
         and p.policyname = item
    ) then
      status := 'FAIL';
      detail := 'policy is missing — apply migration 0049.';
      return next;
    end if;
  end loop;

  -- ── 3. THE BUG ITSELF: any policy on a deal bucket scoped to the uploader ─
  -- This is the exact shape that hid a deal's documents from its co-agent. It
  -- is checked by BODY, not by name, because the next one will be named
  -- something else.
  -- PERMISSIVE vs RESTRICTIVE is the whole story here, and 0049 missed it.
  -- Permissive policies are OR'd, so a leftover can only widen and the deal
  -- policies still grant. RESTRICTIVE policies are AND'd: a single one vetoes
  -- every permissive policy there is, so an uploader-scoped restrictive rule
  -- survives 0049 completely and the co-agent still sees nothing — with the
  -- migration correctly applied. Measured: 0 files of 3 with it, 3 without.
  for r in
    select p.policyname, p.cmd, p.permissive,
           coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '') as body
      from pg_policies p
     where p.schemaname = 'storage' and p.tablename = 'objects'
  loop
    if r.body !~ 'deal-documents|closing-packets' then
      continue;
    end if;
    area := 'storage policy';
    item := r.policyname;

    if r.permissive = 'RESTRICTIVE' then
      -- Always a FAIL, whatever its body says: nothing in this repository ever
      -- creates a restrictive policy on these buckets, and one that exists can
      -- only take access away from agents the deal already grants.
      status := 'FAIL';
      detail := 'RESTRICTIVE policy on a deal bucket (' || r.cmd || '). Restrictive policies are ANDed, so this vetoes the deal check no matter what else is in place — the migration can look applied and change nothing. Run migration 0051, or: drop policy ' || quote_ident(r.policyname) || ' on storage.objects;';
      return next;
    elsif r.body ~ '\mowner\M' and not (r.policyname = any(known_storage_policies)) then
      -- Permissive and uploader-scoped: it can only widen, so it is untidy
      -- rather than harmful. Reported so it can be cleaned up deliberately —
      -- dropping it blind could remove access to an object that sits outside
      -- any deal- prefix.
      status := 'warn';
      detail := 'permissive policy scoping a deal bucket by uploader (`owner`). It cannot block anything — permissive policies are ORed — but it is the shape that caused the original outage. Drop it once you are satisfied: drop policy ' || quote_ident(r.policyname) || ' on storage.objects;';
      return next;
    elsif not (r.policyname = any(known_storage_policies)) then
      status := 'warn';
      detail := 'unrecognised policy on a deal bucket (' || r.cmd || '). Read its body; if it does not defer to app_visible_deal_ids() it is changing access outside version control.';
      return next;
    end if;
  end loop;

  -- ── 4. Deal-scoped tables still defer to deal visibility ─────────────────
  foreach item in array deal_scoped_tables loop
    area := 'table policy';
    if not exists (select 1 from pg_tables t where t.schemaname = 'public' and t.tablename = item) then
      status := 'warn';
      detail := 'table not present in this database';
    elsif not exists (
      select 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = 'public' and c.relname = item and c.relrowsecurity
    ) then
      -- RLS off means every policy on the table is inert and every agent sees
      -- every row. Nothing in the UI would look different.
      status := 'FAIL';
      detail := 'ROW LEVEL SECURITY IS DISABLED — every signed-in agent can read and write every row.';
    elsif not exists (
      select 1 from pg_policies p
       where p.schemaname = 'public' and p.tablename = item
         and (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) ~ 'app_visible_deal_ids|app_is_admin|app_current_agent_id'
    ) then
      status := 'FAIL';
      detail := 'no policy defers to app_visible_deal_ids()/app_is_admin() — this table is not scoped to the deal.';
    else
      status := 'ok';
      detail := 'scoped';
    end if;
    return next;
  end loop;

  -- ── 5. Role-less policies (the migration 0027 class) ──────────────────────
  -- A policy with no `to <role>` applies to PUBLIC, which in Supabase includes
  -- `anon` — and the anon key ships in the browser bundle. `{public}` in
  -- pg_policies.roles is exactly that.
  area := 'anon exposure';
  for r in
    select p.schemaname, p.tablename, p.policyname
      from pg_policies p
     where p.roles = '{public}'
       and p.schemaname in ('public', 'storage')
       -- Landing pages render campaign images straight from the public bucket.
       and p.policyname <> 'campaign-images: public read'
       -- The external website tracking snippet posts with the anon key.
       and p.policyname <> 'public_insert'
     order by p.schemaname, p.tablename, p.policyname
  loop
    item   := r.schemaname || '.' || r.tablename || ' / ' || r.policyname;
    status := 'FAIL';
    detail := 'policy has no TO clause, so it applies to PUBLIC — the anonymous key can use it. Re-create it with `to authenticated`.';
    return next;
  end loop;
  if not found then
    item := 'policies without a TO clause'; status := 'ok'; detail := 'none';
    return next;
  end if;

  -- ── 6. Co-agents displayed but not granted ───────────────────────────────
  -- src/lib/coAgents.js falls back to the linked property to DISPLAY a deal's
  -- co-agents, while RLS reads only deals.co_agent_ids. Where the two differ,
  -- the "Agents on deal" card names someone the database has never heard of —
  -- they see the card, and nothing else on the deal. Migration 0049 backfills
  -- this; a deal converted by a pre-0025 client build can reintroduce it.
  area := 'co-agent visibility';
  item := 'deals displaying a co-agent RLS does not grant';
  select count(*) into n
    from deals d
    join properties p on p.id = d.property_id
   where coalesce(array_length(d.co_agent_ids, 1), 0) = 0
     and jsonb_typeof(p.details->'co_agent_ids') = 'array'
     and jsonb_array_length(p.details->'co_agent_ids') > 0;
  if n > 0 then
    status := 'warn';
    detail := n || ' deal(s). They show a co-agent on the team card who cannot open the deal. Re-run the backfill at the end of migration 0049.';
  else
    status := 'ok';
    detail := 'none';
  end if;
  return next;

  -- ── 7. Is 0049 actually applied? ─────────────────────────────────────────
  -- Asked last so it reads as the explanation for everything above it: a run
  -- full of FAILs plus this one means "apply the migration", not "investigate".
  area := 'migration';
  item := '0049 deal document storage RLS';
  if exists (
    select 1 from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
     where ns.nspname = 'public' and pr.proname = 'app_storage_deal_id'
  ) then
    status := 'ok';    detail := 'applied';
  else
    status := 'FAIL';  detail := 'NOT APPLIED — deal documents are still scoped by whoever uploaded them. Run migrations/0049_deal_document_storage_rls.sql.';
  end if;
  return next;
end
$$;

-- Execute is granted broadly; the function refuses a non-admin caller itself,
-- which keeps the refusal message useful instead of a bare permission error.
grant execute on function app_access_audit() to authenticated, service_role;

commit;

-- ── Verification ───────────────────────────────────────────────────────────
-- select * from app_access_audit() order by (status = 'ok'), area, item;
--
-- Everything 'ok' means the live database matches the access model this
-- repository describes. Any FAIL names what to do about it.
