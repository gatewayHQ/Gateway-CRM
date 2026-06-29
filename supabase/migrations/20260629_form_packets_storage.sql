-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: Create form-packets storage bucket + RLS policies
--
-- Fixes "Upload failed: new row violates row-level security policy" when
-- adding a packet in Form Library. The previous form_packets migration left
-- bucket creation as a manual step and never added storage.objects policies,
-- so authenticated uploads were denied by default.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Create the bucket (private — downloads use signed URLs)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'form-packets',
  'form-packets',
  false,
  52428800, -- 50 MB
  array['application/pdf']
)
on conflict (id) do nothing;

-- 2. Authenticated users can upload
do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename='objects' and schemaname='storage'
    and policyname='form-packets: authenticated upload'
  ) then
    create policy "form-packets: authenticated upload"
      on storage.objects for insert to authenticated
      with check (bucket_id = 'form-packets');
  end if;
end $$;

-- 3. Authenticated users can read (download via signed URL still works)
do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename='objects' and schemaname='storage'
    and policyname='form-packets: authenticated read'
  ) then
    create policy "form-packets: authenticated read"
      on storage.objects for select to authenticated
      using (bucket_id = 'form-packets');
  end if;
end $$;

-- 4. Authenticated users can update (needed for upsert: true in the upload call)
do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename='objects' and schemaname='storage'
    and policyname='form-packets: authenticated update'
  ) then
    create policy "form-packets: authenticated update"
      on storage.objects for update to authenticated
      using (bucket_id = 'form-packets')
      with check (bucket_id = 'form-packets');
  end if;
end $$;

-- 5. Authenticated users can delete
do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename='objects' and schemaname='storage'
    and policyname='form-packets: authenticated delete'
  ) then
    create policy "form-packets: authenticated delete"
      on storage.objects for delete to authenticated
      using (bucket_id = 'form-packets');
  end if;
end $$;
