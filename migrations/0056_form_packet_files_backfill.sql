-- Migration 0056 — Form packets: give back the files the record lost
-- ===========================================================================
-- THE BUG
--   Agents click "Get Forms" on a multi-file packet (the Iowa buyer contract
--   package: purchase agreement + disclosures + addenda) and receive ONE PDF.
--   The download code is not the cause — both Get Forms buttons zip every file
--   the row lists. The row lists one.
--
-- HOW THE ROW LOST ITS FILES
--   `storage_paths` (0022) holds a packet's files; `storage_path` is the
--   single-file column it replaced, kept as "file 1". 0022 sat PENDING in
--   production (migrations/production/README.md) while multi-file uploads were
--   already live, and FormLibrary's save() answered the missing column by
--   retrying WITHOUT it — silently. Every PDF went into the bucket; the row kept
--   `storage_path` alone; the admin was told "Form packet added".
--
--   When 0022 finally ran, those rows got its default `[]`. Any later edit of
--   the packet (Active, Required to close, a rebuild) re-saved "the files on
--   file" — the one — as `storage_paths = [file 1]`. So an affected row now
--   looks like either of:
--       storage_paths = []          storage_path = <file 1>
--       storage_paths = [<file 1>]  storage_path = <file 1>
--   and nothing distinguishes it from a real one-file packet except the bucket.
--
-- WHAT THIS DOES
--   Form Library names every upload `<STATE>/<type>/<Date.now()>-<i>-<name>`,
--   one index per file, uploaded one after another. For every packet whose row
--   names exactly one file, and that file is index 0 of such an upload, it
--   reads the folder in storage.objects and rebuilds the upload:
--
--     file k is in the upload when it is index k, uploaded at or after file
--     k-1, within 15 minutes of it, and before the NEXT upload's file 0.
--
--   The same rule, in the same words, is `uploadBatch()` in
--   src/lib/packetDownload.js — which is also what Get Forms uses to deliver an
--   affected packet whole until this has run.
--
--   Rebuilt uploads with more than one file are written back to storage_paths
--   in upload order. A row is NOT touched when:
--     • two objects claim the same position in the upload (AMBIGUOUS), or
--     • a rebuilt file is already on a different packet's row (CLAIMED).
--   Both are reported for a human; re-uploading the packet in Form Library is
--   the fix for either. (CLAIMED is a check only this file can make — the
--   browser does not see every row. The Form Library cannot produce it: every
--   save uploads its own files, and a row's first file is always index 0.)
--
-- CHANGES BEHAVIOR?
--   Only for affected rows, and only toward what the admin uploaded: the Form
--   Library shows "N files" and Get Forms zips all of them. One-file packets,
--   packets that already list several files, and files that do not follow the
--   upload naming are left exactly as they are.
--
-- SAFE TO RE-RUN. A repaired row lists several files, so a second run leaves
-- it alone. Nothing is deleted — not rows, not storage objects.
--
-- RUN IT in Supabase Dashboard → SQL Editor. The last statement is the report:
-- one row per packet. Read the `result` column.
-- ===========================================================================

drop table if exists pg_temp.form_packet_repair;

create temp table form_packet_repair as
with recursive
-- The files each row lists, as packetFiles() reads them: storage_paths entries
-- that are objects with a path, in order.
recorded as (
  select fp.id, fp.storage_path, f.list
  from form_packets fp
  cross join lateral (
    select coalesce(jsonb_agg(e order by o), '[]'::jsonb) as list
    from jsonb_array_elements(
           case when jsonb_typeof(fp.storage_paths) = 'array' then fp.storage_paths else '[]'::jsonb end
         ) with ordinality as t(e, o)
    where jsonb_typeof(e) = 'object' and coalesce(e->>'path', '') <> ''
  ) f
),
-- Rows that name exactly one file — the file Get Forms has been handing out.
single as (
  select id,
         coalesce(list->0->>'path', storage_path) as anchor,
         list->0->>'name'                         as anchor_name
  from recorded
  where jsonb_array_length(list) = 1
     or (jsonb_array_length(list) = 0 and coalesce(storage_path, '') <> '')
),
-- …and that file is index 0 of a Form Library upload.
anchors as (
  select s.id, s.anchor, x.m[1] as folder, x.m[2]::numeric as ts,
         coalesce(nullif(s.anchor_name, ''), x.m[4]) as fname
  from single s
  cross join lateral (select regexp_match(s.anchor, '^(.*)/(\d+)-(\d+)-([^/]+)$') as m) x
  where x.m is not null and x.m[3]::numeric = 0
),
-- Every upload-named object directly inside that folder.
objs as (
  select a.id, o.name as path, x.m[1]::numeric as ts, x.m[2]::numeric as idx, x.m[3] as fname
  from anchors a
  join storage.objects o
    on o.bucket_id = 'form-packets'
   and left(o.name, length(a.folder) + 1) = a.folder || '/'
  cross join lateral (
    select regexp_match(substr(o.name, length(a.folder) + 2), '^(\d+)-(\d+)-([^/]+)$') as m
  ) x
  where x.m is not null
),
-- Where the next upload into the folder starts; nothing after it is ours.
bounds as (
  select a.id, min(o.ts) as next_upload
  from anchors a
  join objs o on o.id = a.id and o.idx = 0 and o.ts > a.ts
  group by a.id
),
chain(id, idx, ts, path, fname, next_upload) as (
  select a.id, 0::numeric, a.ts, a.anchor, a.fname, b.next_upload
  from anchors a
  left join bounds b on b.id = a.id
  union all
  select c.id, o.idx, o.ts, o.path, o.fname, c.next_upload
  from chain c
  join objs o
    on o.id = c.id
   and o.idx = c.idx + 1
   and o.ts >= c.ts
   and o.ts - c.ts <= 15 * 60 * 1000
   and (c.next_upload is null or o.ts < c.next_upload)
),
-- A rebuilt file that another packet's row already lists.
claimed as (
  select distinct c.id
  from chain c
  join form_packets other
    on other.id <> c.id
   and (other.storage_path = c.path
        or (jsonb_typeof(other.storage_paths) = 'array'
            and other.storage_paths @> jsonb_build_array(jsonb_build_object('path', c.path))))
  where c.idx > 0
),
summary as (
  select id,
         count(*)            as candidates,
         count(distinct idx) as files,
         jsonb_agg(jsonb_build_object('path', path, 'name', fname) order by idx, path) as list
  from chain
  group by id
)
select s.id, s.files, s.list,
       case when s.candidates > s.files then 'ambiguous'
            when cl.id is not null        then 'claimed'
            when s.files > 1              then 'repair'
            else 'single' end as action
from summary s
left join claimed cl on cl.id = s.id;

update form_packets fp
   set storage_paths = r.list,
       storage_path  = r.list->0->>'path'
  from form_packet_repair r
 where r.id = fp.id
   and r.action = 'repair';

-- ───────────────────────────────────────────────────────────────────────────
-- REPORT — one row per packet, after the update above.
--   REPAIRED        was one file on record; now lists its whole upload
--   CHECK BY HAND   not repaired — re-upload the packet's PDFs in Form Library
--   ok              nothing to do
-- ───────────────────────────────────────────────────────────────────────────
select fp.state,
       fp.transaction_type,
       fp.name,
       n.files_on_record,
       case r.action
         when 'repair'    then 'REPAIRED — the record listed 1 file; its upload holds ' || r.files || '. Get Forms now zips all of them.'
         when 'ambiguous' then 'CHECK BY HAND — two stored files claim the same place in this upload. Re-upload the packet''s PDFs in Form Library.'
         when 'claimed'   then 'CHECK BY HAND — a file from this upload is also listed on another packet. Re-upload the packet''s PDFs in Form Library.'
         when 'single'    then 'ok — a one-file packet'
         else case
           when n.files_on_record = 0 then 'ok — no file uploaded (not downloadable)'
           when n.files_on_record > 1 then 'ok — ' || n.files_on_record || ' files on record'
           else 'ok — one file, not the first file of a Form Library upload, so not checked'
         end
       end as result,
       fp.id
from form_packets fp
-- Counted the way packetFiles() reads a row: storage_paths entries with a path,
-- else the legacy storage_path as one file.
cross join lateral (
  select coalesce(nullif((
           select count(*)::int
           from jsonb_array_elements(
                  case when jsonb_typeof(fp.storage_paths) = 'array' then fp.storage_paths else '[]'::jsonb end) e
           where jsonb_typeof(e) = 'object' and coalesce(e->>'path', '') <> ''
         ), 0),
         case when coalesce(fp.storage_path, '') <> '' then 1 else 0 end) as files_on_record
) n
left join form_packet_repair r on r.id = fp.id
order by (r.action = 'repair') desc nulls last, (r.action in ('ambiguous', 'claimed')) desc nulls last,
         fp.state, fp.transaction_type, fp.name;
