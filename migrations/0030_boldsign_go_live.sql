-- ─────────────────────────────────────────────────────────────────────────────
-- 0030 — BoldSign go-live hardening (Sandbox → Live)
--
-- Three changes, all of which only matter once documents are legally binding:
--
-- 1. ONE ROW PER BOLDSIGN DOCUMENT.
--    `boldsign_documents.document_id` had no unique constraint. Two rows for the
--    same document are reachable (a retried send path, a hand-written row), and
--    every server-side lookup used `.maybeSingle()` — which THROWS on more than
--    one row. In the webhook that throw was caught and answered 200, so BoldSign
--    never redelivered: the document silently stopped updating forever, right at
--    the "Completed" event that archives the signed PDF and the audit trail.
--    The app has been made duplicate-tolerant as well (it takes the newest row),
--    but the constraint is what stops the situation arising.
--
-- 2. THE FORM CATALOG BECOMES ADMIN-WRITE.
--    `form_packets` carried `for all to authenticated using (true) with check
--    (true)` — every signed-in agent could edit or DELETE any row in the
--    brokerage-wide catalog of state-required forms, including repointing a
--    packet's `boldsign_template_id` at a different BoldSign template. The UI
--    already gates those buttons on `isAdmin`; this makes the database agree.
--    Reads stay open to all authenticated users — agents must still see the
--    catalog to send from it.
--
-- 3. IN-FLIGHT LOOKUP INDEX for the document-id path used by the webhook and by
--    every download/remind/delete action.
--
-- Safe to re-run. Nothing here drops or rewrites data.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Unique document_id ────────────────────────────────────────────────────
-- Duplicates are reported, NEVER auto-deleted: a duplicate row may be the one
-- carrying the archived signed PDF's storage path, and picking a survivor is a
-- judgment call about a legal record, not something a migration should guess.
-- If this raises the notice, resolve the listed rows by hand and re-run.
do $$
declare dupes integer := 0;
begin
  select count(*) into dupes from (
    select document_id from boldsign_documents
    where document_id is not null
    group by document_id having count(*) > 1
  ) d;

  if dupes > 0 then
    raise warning 'boldsign_documents has % duplicated document_id value(s) — unique index NOT created. Resolve them, then re-run this file. List them with: select document_id, count(*), array_agg(id) from boldsign_documents group by document_id having count(*) > 1;', dupes;
  else
    create unique index if not exists uq_boldsign_documents_document_id
      on boldsign_documents(document_id);
    raise notice 'uq_boldsign_documents_document_id in place';
  end if;
end $$;

-- ── 2. form_packets — read by all, written by admins ─────────────────────────
alter table form_packets enable row level security;

drop policy if exists "form_packets_all"   on form_packets;
drop policy if exists form_packets_all     on form_packets;
drop policy if exists form_packets_read    on form_packets;
drop policy if exists form_packets_write   on form_packets;

-- Every agent needs to read the catalog to send from it.
create policy form_packets_read on form_packets
  for select to authenticated using (true);

-- Only admins may add, change, or remove a compliance form.
create policy form_packets_write on form_packets
  for all to authenticated
  using      (app_is_admin())
  with check (app_is_admin());

-- ── 3. Lookup index ──────────────────────────────────────────────────────────
-- idx_boldsign_docs_docid already exists on most databases; kept here so a
-- database that skipped an earlier file still gets it. Redundant with the unique
-- index above when that one is created, and harmless when it isn't.
create index if not exists idx_boldsign_docs_docid on boldsign_documents(document_id);

-- ── Verification ─────────────────────────────────────────────────────────────
-- Expect: one row for the unique index (unless duplicates were reported above),
-- and exactly two policies on form_packets (read + write).
select indexname from pg_indexes
 where tablename = 'boldsign_documents' and indexname = 'uq_boldsign_documents_document_id';

select policyname, cmd from pg_policies
 where tablename = 'form_packets' order by policyname;
