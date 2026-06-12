# Cutting Supabase cached egress (image bytes)

## What was happening

Supabase "Cached Egress" is image bytes served from the public Storage buckets
through the CDN. Two compounding problems put it over the free 5 GB cap:

1. **Uploads weren't compressed.** Agents' raw phone photos (3–8 MB) went
   straight into `campaign-images` and `property-photos`.
2. **Those images are served a lot** — every QR-mailer scan / landing-page
   view re-downloads them. (Symptom: only ~166 MB *stored* but ~8 GB *served*
   — each image delivered ~50×.)

## The fixes (no features lost)

**1. Compress on upload — shipped** (`src/lib/imageCompress.js`).
Every public-bucket upload (campaigns/landing, property photos, advisor
headshots) is now resized + re-encoded to WebP in the browser before it's
sent: ~3–8 MB → ~150–300 KB, with a 1-year immutable cache header (safe — every
filename is unique). New content is small from now on.

**2. Re-compress what's already there — one-time, run locally**
(`scripts/recompress-storage.mjs`). New uploads being small doesn't shrink the
images your *current live mailers* point at. This script re-encodes every
existing public image in place (same path, same URL — only smaller bytes +
the long cache header):

```bash
npm i -D sharp
# preview first — uploads nothing:
SUPABASE_URL="https://<your-project>.supabase.co" \
SUPABASE_SERVICE_KEY="<service-role-key>" \
node scripts/recompress-storage.mjs --dry-run
# then for real:
SUPABASE_URL="https://<your-project>.supabase.co" \
SUPABASE_SERVICE_KEY="<service-role-key>" \
node scripts/recompress-storage.mjs
```

Find the service key in Supabase → Project Settings → API → `service_role`.
Keep it secret; it bypasses all security. The script is safe to re-run
(already-small / already-optimized files are skipped) and never changes object
paths, so all stored URLs keep working.

## Expected result

With existing images re-compressed (~166 MB → ~25–40 MB of distinct bytes) and
every serve ~10× smaller, plus browser caching for repeat viewers, cached
egress should land comfortably under 5 GB — no plan upgrade needed. Give
Supabase up to an hour to refresh the usage number, and check again after the
next billing cycle starts.

## If it's still high

- Check Supabase → Storage for any single very-large object the buckets missed.
- Consider a branded image CDN later (the OG social-preview images in
  `api/campaigns` are a candidate to serve pre-sized).
