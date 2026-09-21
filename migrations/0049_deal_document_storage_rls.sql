-- Migration 0049 — Deal documents follow the deal (storage RLS)
-- ===========================================================================
-- THE BUG
--   Two agents on the same deal: the assigned agent uploads contracts and sees
--   them in Documents; the co-agent opens the SAME deal, sees the header, the
--   people card with her name on it, the Signatures tab — and "No documents
--   yet."
--
-- WHY
--   Every other deal child is scoped in SQL that lives in this repository:
--   `documents`, `document_versions`, `boldsign_documents`, `closing_packets`,
--   `transaction_steps` all read `app_visible_deal_ids()` (schema.sql, the
--   "SCOPED RLS POLICIES" section). The Documents tab does not read any of
--   them. It lists Supabase STORAGE directly:
--
--       supabase.storage.from('deal-documents').list(`deal-${deal.id}`)
--       — src/pages/Pipeline.jsx (DocumentsTab), src/pages/DealPage.jsx
--
--   and `storage.objects` is a table like any other: what an agent may list is
--   decided by ITS row policies. Those policies were never in this repository.
--   The `deal-documents` bucket has no `insert into storage.buckets` here, no
--   `create policy` here — it was made by hand in the Supabase dashboard, and
--   the dashboard's default policy template is owner-scoped:
--
--       bucket_id = 'deal-documents' and owner = auth.uid()
--
--   That is the whole bug. `owner` is whoever uploaded the object, so the
--   uploader sees their files and NOBODY else does — not a co-agent, not a
--   team peer, not an office admin. It is invisible from the app's side
--   because storage list does not error on a denied row, it FILTERS: the
--   co-agent gets `[]` and the tab renders its empty state, which reads as
--   "this deal has no documents" rather than "you were not allowed to see
--   them". Three separate people can be looking at three different Documents
--   tabs on one deal.
--
--   `closing-packets` has the same hole (migration 0015 creates the bucket and
--   stops there), and so does `form-packets` (never created by any migration —
--   FormLibrary.jsx just tells you to make one).
--
-- WHAT THIS DOES
--   Puts the buckets and their policies under version control, and scopes the
--   two DEAL buckets to the deal — the same `app_visible_deal_ids()` that
--   already answers "may this agent see this deal?" for every other child
--   table. After this, the Documents tab shows the same files to the assigned
--   agent, every co-agent, every sharing team peer and every office admin,
--   because they all resolve to the same set of visible deal ids.
--
--   The link from an object to a deal is the path. Every writer in the app and
--   the API agrees on it — `deal-<uuid>/<file>`, plus `deal-<uuid>/print/...`
--   for throwaway review copies:
--     • src/pages/Pipeline.jsx      upload / split / merge / markup
--     • src/lib/services/documents.js
--     • api/boldsign.js             archived signed PDFs + audit trails
--     • api/_handlers/closing-packet.js
--   `app_storage_deal_id()` below reads the deal id back out of that path.
--
-- FAILS CLOSED
--   An object whose name does not start with `deal-<uuid>/` yields NULL, and
--   `null in (select …)` is NULL, which is not TRUE — so a stray object at the
--   bucket root is readable by admins only. That is deliberate: a file nobody
--   can attribute to a deal is not a file to hand out.
--
-- SERVICE KEY IS UNAFFECTED
--   `service_role` bypasses RLS, so the BoldSign webhook archive, the closing
--   packet builder and /api/portal's client-facing signed URLs keep working
--   exactly as they do today. Only the browser's anon-key session is scoped.
--
-- SAFETY
--   Additive and idempotent. Postgres ORs permissive policies together, so
--   these WIDEN access wherever a hand-made policy is still in place; they
--   never narrow it. Nothing is dropped except policies by the exact names
--   this file owns (plus the two well-known hand-made names, listed below).
--   No object is moved, renamed or deleted.
-- ===========================================================================

begin;

-- ── 1. The deal id inside a storage path ───────────────────────────────────
-- `deal-2f4a…-9c1e/Earnest Money 5.pdf` → the uuid. Anything else → NULL.
-- IMMUTABLE so the planner can use it freely inside a policy; it touches no
-- table, so `security definer` would buy nothing.
create or replace function app_storage_deal_id(object_name text)
returns uuid
language sql
immutable
set search_path = public
as $$
  select nullif(substring(
    object_name from
    '^deal-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/'
  ), '')::uuid
$$;

grant execute on function app_storage_deal_id(text) to authenticated;

-- ── 2. The buckets ─────────────────────────────────────────────────────────
-- All three PRIVATE. `deal-documents` holds executed contracts and the
-- compliance audit trails BoldSign archives; a public bucket would make every
-- one of them readable by URL with no session at all.
--
-- `do update` rather than `do nothing` on the two deal buckets: if one of them
-- is public right now (the hardening check in the 2026-07-31 production
-- migration exists because that has happened), this closes it.
insert into storage.buckets (id, name, public, file_size_limit)
values ('deal-documents', 'deal-documents', false, 52428800)   -- 50 MB, matches the UI's limit
on conflict (id) do update set public = false;

insert into storage.buckets (id, name, public, file_size_limit)
values ('closing-packets', 'closing-packets', false, 104857600) -- 100 MB, a packet is every doc merged
on conflict (id) do update set public = false;

insert into storage.buckets (id, name, public, file_size_limit)
values ('form-packets', 'form-packets', false, 52428800)
on conflict (id) do update set public = false;

-- ── 3. Retire the hand-made policies ───────────────────────────────────────
-- By exact name only. `agents_deal_docs` is the one the app's own setup panel
-- printed (src/pages/Pipeline.jsx); the "Give users access to own folder"
-- names are the Supabase dashboard templates that produced the owner-scoped
-- rule this migration exists to undo. A policy under any other name is left
-- alone and reported by the verification query at the bottom — dropping
-- policies this file did not write, by guessing at their bodies, is how an
-- upload starts failing at 2am.
drop policy if exists "agents_deal_docs" on storage.objects;
drop policy if exists "Give users access to own folder 1oj01fe_0" on storage.objects;
drop policy if exists "Give users access to own folder 1oj01fe_1" on storage.objects;
drop policy if exists "Give users access to own folder 1oj01fe_2" on storage.objects;
drop policy if exists "Give users access to own folder 1oj01fe_3" on storage.objects;

-- ── 4. deal-documents — follows the deal ───────────────────────────────────
-- Split per command rather than `for all` so the intent of each is readable,
-- and so a future decision to make deletes stricter than reads is a one-line
-- change instead of a rewrite.
drop policy if exists "deal-documents: read"   on storage.objects;
create policy "deal-documents: read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'deal-documents'
    and (app_is_admin() or app_storage_deal_id(name) in (select app_visible_deal_ids()))
  );

drop policy if exists "deal-documents: upload" on storage.objects;
create policy "deal-documents: upload"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'deal-documents'
    and (app_is_admin() or app_storage_deal_id(name) in (select app_visible_deal_ids()))
  );

-- Update covers `upsert: true` and storage's own move/copy.
drop policy if exists "deal-documents: update" on storage.objects;
create policy "deal-documents: update"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'deal-documents'
    and (app_is_admin() or app_storage_deal_id(name) in (select app_visible_deal_ids()))
  )
  with check (
    bucket_id = 'deal-documents'
    and (app_is_admin() or app_storage_deal_id(name) in (select app_visible_deal_ids()))
  );

-- Anyone who can EDIT the deal can delete its documents — the same answer
-- `deals_agent_scope` already gives for the deal row itself. A co-agent who
-- cannot remove a file they uploaded to a colleague's deal is the mirror image
-- of the bug this migration fixes.
drop policy if exists "deal-documents: delete" on storage.objects;
create policy "deal-documents: delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'deal-documents'
    and (app_is_admin() or app_storage_deal_id(name) in (select app_visible_deal_ids()))
  );

-- ── 5. closing-packets — follows the deal, read-only to agents ─────────────
-- Packets are BUILT by api/_handlers/closing-packet.js with the service key,
-- which bypasses RLS. The browser only ever signs a URL to download one, so
-- agents get select and nothing else: an agent cannot hand-edit a frozen
-- closing bundle that the audit log points at.
drop policy if exists "closing-packets: read" on storage.objects;
create policy "closing-packets: read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'closing-packets'
    and (app_is_admin() or app_storage_deal_id(name) in (select app_visible_deal_ids()))
  );

-- ── 6. form-packets — the shared catalog ───────────────────────────────────
-- Blank state forms, not deal files: paths are `IA/seller/…`, there is no deal
-- to scope to, and every agent needs to pull the Iowa listing agreement. This
-- mirrors the `form_packets` TABLE exactly — readable by any signed-in agent,
-- writable by office admins only (migration 0030, which closed agent writes to
-- the form catalog at the row level while the bucket stayed wide open).
drop policy if exists "form-packets: read"  on storage.objects;
create policy "form-packets: read"
  on storage.objects for select to authenticated
  using (bucket_id = 'form-packets');

drop policy if exists "form-packets: admin write"  on storage.objects;
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

-- ── 7. Backfill the co-agents the conversion dropped ───────────────────────
-- The other half of "she is on the deal but cannot see it". Migration 0025
-- added `deals.co_agent_ids` and the co-listing branch of
-- `app_visible_deal_ids()`, but deals converted from a property BEFORE it
-- shipped still have an empty array. The app papers over that for DISPLAY —
-- `dealCoAgentIds()` in src/lib/coAgents.js falls back to the linked
-- property's `details.co_agent_ids` — so the "Agents on deal" card names a
-- co-agent that RLS has never heard of. The card says she is on the deal; the
-- database says she is not. Nothing else in the app can be right while those
-- two disagree.
--
-- 0025 shipped this as a commented-out convenience. It is not a convenience:
-- it is what makes the display and the access rules agree. Idempotent — only
-- rows whose array is still empty are touched, and re-running finds none.
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
   and coalesce(array_length(sub.ids, 1), 0) > 0;

commit;

-- ── Verification (read-only — paste into the SQL editor after running) ─────
--
-- 1. The three buckets exist and none of them is public:
-- select id, public, file_size_limit from storage.buckets
--  where id in ('deal-documents','closing-packets','form-packets');
--
-- 2. Every policy now on storage.objects. The eleven named in this file should
--    be here; ANY OTHER ROW mentioning one of these buckets is a leftover
--    hand-made policy — read its `qual`, and if it says `owner = auth.uid()`
--    drop it by name, because it is the rule that hid the documents:
-- select policyname, cmd, roles, qual, with_check
--   from pg_policies where schemaname = 'storage' and tablename = 'objects'
--  order by policyname;
--
-- 3. The path parser, against a real object:
-- select name, app_storage_deal_id(name) from storage.objects
--  where bucket_id = 'deal-documents' limit 5;
--
-- 4. Who can see one deal's files. Run as the co-agent who reported the bug
--    (Supabase SQL editor runs as postgres, so this is the shape, not a live
--    check — the honest test is the co-agent reloading the Documents tab):
-- select d.id, d.agent_id, d.co_agent_ids from deals d
--  where d.id = '<deal uuid>';
--
-- 5. What the backfill changed:
-- select count(*) from deals where coalesce(array_length(co_agent_ids,1),0) > 0;
