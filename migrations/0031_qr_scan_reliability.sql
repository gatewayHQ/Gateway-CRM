-- ═════════════════════════════════════════════════════════════════════════════
-- 0031 — QR scan reliability, attribution & analytics
--
-- Rebuilds the data layer behind /m/{token} so that a scan is (a) recorded in a
-- single atomic round trip, (b) impossible to double-count, (c) never silently
-- dropped, and (d) reportable in SQL instead of by pulling every row into a
-- serverless function.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────
-- The pre-0031 scan path had five defects, all of which lost or corrupted data:
--
--   1. The scan row was inserted fire-and-forget AFTER the 302 was flushed. On
--      Vercel the instance can be frozen the moment the response is sent, so
--      the write was a race against the runtime.
--   2. `scan_count` was bumped with a read-modify-write (`read N` → `write N+1`)
--      from a value read at the top of the request. Concurrent scans both read
--      N and both wrote N+1 — the classic lost update.
--   3. Two sequential round trips (SELECT the mailing, then INSERT the scan)
--      sat between the scan and the redirect.
--   4. `mailing_scans.recipient_id`, `mailing_recipients.scan_count`,
--      `first_scanned_at` and `last_scanned_at` were declared but never written
--      by any code, so "% of recipients scanned" always rendered 0%.
--   5. Every count was tallied in JavaScript over raw rows, which silently caps
--      at PostgREST's max-rows (1,000 by default on Supabase) and pulls the
--      whole scan table into memory on each page load.
--
-- ── DESIGN ───────────────────────────────────────────────────────────────────
-- • RECORD EVERYTHING, FILTER ON READ. Bot hits, prefetches and rapid repeats
--   are stored and flagged (`is_bot`, `is_duplicate`), never dropped. "Zero lost
--   scans" means zero lost rows; honest metrics come from filtering at read
--   time, where the decision can be revisited without having destroyed data.
-- • The caller supplies the scan's primary key, so a retry or a client-side
--   replay of the same scan collides on the PK and is absorbed — at-least-once
--   delivery becomes exactly-once storage.
-- • `visit_id` stitches scan → landing page → captured lead, which is how a
--   conversion is attributed to a scan when every mail piece shares one QR code.
--
-- Additive and idempotent — no column or row is dropped or rewritten. Safe to
-- re-run. Existing rows keep working: the new columns are nullable or defaulted.
--
-- ROLLBACK: see the commented block at the bottom.
-- ═════════════════════════════════════════════════════════════════════════════


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 1 — Columns
-- ─────────────────────────────────────────────────────────────────────────────

-- mailing_scans: classification, enrichment, and the visit stitching key.
alter table mailing_scans add column if not exists visit_id     text;
alter table mailing_scans add column if not exists visitor_hash text;
alter table mailing_scans add column if not exists is_bot       boolean default false;
alter table mailing_scans add column if not exists bot_reason   text;
alter table mailing_scans add column if not exists is_duplicate boolean default false;
alter table mailing_scans add column if not exists device_type  text;
alter table mailing_scans add column if not exists os           text;
alter table mailing_scans add column if not exists browser      text;
alter table mailing_scans add column if not exists region       text;
alter table mailing_scans add column if not exists city         text;
alter table mailing_scans add column if not exists latitude     text;
alter table mailing_scans add column if not exists longitude    text;
alter table mailing_scans add column if not exists timezone     text;
alter table mailing_scans add column if not exists source       text default 'qr';
alter table mailing_scans add column if not exists latency_ms   integer;

-- Backfill so the flags are never null on pre-0031 rows (partial indexes and
-- `where not is_bot` predicates would otherwise skip them).
update mailing_scans set is_bot       = false where is_bot       is null;
update mailing_scans set is_duplicate = false where is_duplicate is null;
update mailing_scans set source       = 'qr'  where source       is null;

alter table mailing_scans alter column is_bot       set default false;
alter table mailing_scans alter column is_duplicate set default false;

-- mailing_leads / mailing_subscribers: the other half of the stitch.
alter table mailing_leads       add column if not exists visit_id text;
alter table mailing_leads       add column if not exists scan_id  uuid;
alter table mailing_subscribers add column if not exists visit_id text;
alter table mailing_subscribers add column if not exists scan_id  uuid;

-- FKs added separately so a partially-migrated database can't fail the whole
-- file, and so re-running is a no-op.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'mailing_leads_scan_id_fkey') then
    alter table mailing_leads
      add constraint mailing_leads_scan_id_fkey
      foreign key (scan_id) references mailing_scans(id) on delete set null;
  end if;
exception when others then null; end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'mailing_subscribers_scan_id_fkey') then
    alter table mailing_subscribers
      add constraint mailing_subscribers_scan_id_fkey
      foreign key (scan_id) references mailing_scans(id) on delete set null;
  end if;
exception when others then null; end $$;

-- mailings: a cheap "is this campaign live right now" signal for sorting and
-- for the activity feed, maintained by the scan RPC.
alter table mailings add column if not exists last_scan_at timestamptz;


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 2 — Indexes
--
-- The dashboard's 30-day query filters on scanned_at alone; the only existing
-- index was (mailing_id, scanned_at desc), which cannot serve it, so it was a
-- sequential scan over the whole table on every page load.
-- ─────────────────────────────────────────────────────────────────────────────

create index if not exists mailing_scans_scanned_at_idx
  on mailing_scans(scanned_at desc);

-- The shape every analytics query uses: one campaign's real human scans, newest
-- first. Partial, so bot rows don't bloat it.
create index if not exists mailing_scans_real_idx
  on mailing_scans(mailing_id, scanned_at desc)
  where is_bot = false and is_duplicate = false;

create index if not exists mailing_scans_visit_idx
  on mailing_scans(visit_id) where visit_id is not null;

create index if not exists mailing_scans_visitor_idx
  on mailing_scans(mailing_id, visitor_hash) where visitor_hash is not null;

create index if not exists mailing_leads_visit_idx
  on mailing_leads(visit_id) where visit_id is not null;

create index if not exists mailing_subscribers_visit_idx
  on mailing_subscribers(visit_id) where visit_id is not null;

-- `qr_token` already carries a UNIQUE constraint, which is backed by its own
-- index — mailings_qr_token_idx (schema.sql:996) is a duplicate that costs a
-- write on every mailing update and is never chosen by the planner.
drop index if exists mailings_qr_token_idx;


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 3 — record_mailing_scan()
--
-- Resolves the token AND records the scan AND bumps the counter in ONE round
-- trip. Replaces: SELECT-then-INSERT-then-UPDATE across three network hops.
--
-- Counter semantics: `mailings.scan_count` counts what an agent means by a
-- scan — a real human, first hit within the dedupe window. Bot and duplicate
-- rows are still stored and are still returned by the analytics RPCs, they just
-- don't inflate the headline number.
--
-- p_record = false resolves the mailing without recording, which is what the
-- social-crawler branch needs (it must render Open Graph tags but must not
-- count as a scan).
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function record_mailing_scan(
  p_token        text,
  p_scan_id      uuid    default null,
  p_visit_id     text    default null,
  p_ip_hash      text    default null,
  p_visitor_hash text    default null,
  p_user_agent   text    default null,
  p_referrer     text    default null,
  p_country      text    default null,
  p_region       text    default null,
  p_city         text    default null,
  p_latitude     text    default null,
  p_longitude    text    default null,
  p_timezone     text    default null,
  p_device_type  text    default null,
  p_os           text    default null,
  p_browser      text    default null,
  p_is_bot       boolean default false,
  p_bot_reason   text    default null,
  p_source       text    default 'qr',
  p_latency_ms   integer default null,
  p_record       boolean default true,
  p_dedupe_secs  integer default 30
)
returns table (
  mailing_id         uuid,
  name               text,
  landing_type       text,
  landing_custom_url text,
  landing_config     jsonb,
  property_id        uuid,
  status             text,
  scan_id            uuid,
  recorded           boolean,
  duplicate          boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  m            record;
  -- gen_random_uuid(), NOT uuid_generate_v4(). This function pins
  -- `set search_path = public` (below), and Supabase installs uuid-ossp into the
  -- `extensions` schema — so uuid_generate_v4() is UNRESOLVABLE from in here even
  -- though it works fine in table defaults, which resolve against the session's
  -- search_path. Name resolution happens before COALESCE short-circuits, so this
  -- failed on EVERY call even though the caller always passes p_scan_id: every
  -- QR scan errored, and every scanner got the retry page. gen_random_uuid() is
  -- core Postgres (pg_catalog), so no search_path can hide it.
  v_scan_id    uuid    := coalesce(p_scan_id, gen_random_uuid());
  v_duplicate  boolean := false;
  v_recorded   boolean := false;
  v_inserted   integer := 0;
begin
  select mg.id, mg.name, mg.landing_type, mg.landing_custom_url,
         mg.landing_config, mg.property_id, mg.status
    into m
    from mailings mg
   where mg.qr_token = p_token
   limit 1;

  -- Unknown token: return zero rows so the caller can 404 without a second trip.
  if not found then
    return;
  end if;

  if p_record then
    -- A repeat hit from the same visitor inside the window is the same physical
    -- scan (iOS preview then open, a double-tap, a refresh). Stored, flagged,
    -- and kept out of the headline count.
    if p_visitor_hash is not null then
      select exists (
        select 1 from mailing_scans s
         where s.mailing_id   = m.id
           and s.visitor_hash = p_visitor_hash
           and s.is_bot       = false
           and s.scanned_at   > now() - make_interval(secs => greatest(p_dedupe_secs, 0))
      ) into v_duplicate;
    end if;

    -- The caller owns the primary key, so a retried request or a client-side
    -- replay of a write that already landed collides here and is absorbed.
    insert into mailing_scans (
      id, mailing_id, ip_hash, visitor_hash, visit_id, user_agent, referrer,
      country, region, city, latitude, longitude, timezone,
      device_type, os, browser, is_bot, bot_reason, is_duplicate,
      source, latency_ms
    ) values (
      v_scan_id, m.id, p_ip_hash, p_visitor_hash, p_visit_id,
      left(coalesce(p_user_agent, ''), 500), left(coalesce(p_referrer, ''), 500),
      p_country, p_region, p_city, p_latitude, p_longitude, p_timezone,
      p_device_type, p_os, p_browser, coalesce(p_is_bot, false), p_bot_reason,
      v_duplicate, coalesce(p_source, 'qr'), p_latency_ms
    )
    on conflict (id) do nothing;

    get diagnostics v_inserted = row_count;
    v_recorded := v_inserted > 0;

    -- Atomic increment off the stored value — never a read-modify-write from
    -- something the application read earlier. Concurrent scans serialize on the
    -- row and every one of them counts.
    if v_recorded and not coalesce(p_is_bot, false) and not v_duplicate then
      update mailings
         set scan_count   = coalesce(scan_count, 0) + 1,
             last_scan_at = now()
       where id = m.id;
    end if;
  end if;

  return query select
    m.id, m.name, m.landing_type, m.landing_custom_url,
    m.landing_config, m.property_id, m.status,
    v_scan_id, v_recorded, v_duplicate;
end $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 4 — link_visit_conversion()
--
-- Called when a landing page captures a lead or a subscriber. Ties the
-- conversion back to the scan that produced it via the visit id, and — because
-- that scan is the only evidence we have with one QR code per campaign — rolls
-- the recipient-side scan columns forward when the converting person can be
-- matched to a known recipient by contact.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function link_visit_conversion(
  p_visit_id   text,
  p_mailing_id uuid,
  p_lead_id    uuid default null,
  p_sub_id     uuid default null,
  p_contact_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_scan_id      uuid;
  v_recipient_id uuid;
  v_scanned_at   timestamptz;
begin
  if p_visit_id is null or p_visit_id = '' then
    return null;
  end if;

  select s.id, s.scanned_at
    into v_scan_id, v_scanned_at
    from mailing_scans s
   where s.visit_id = p_visit_id
     and (p_mailing_id is null or s.mailing_id = p_mailing_id)
   order by s.scanned_at asc
   limit 1;

  if v_scan_id is null then
    return null;
  end if;

  if p_lead_id is not null then
    update mailing_leads set scan_id = v_scan_id where id = p_lead_id;
  end if;
  if p_sub_id is not null then
    update mailing_subscribers set scan_id = v_scan_id where id = p_sub_id;
  end if;

  -- Deterministic recipient attribution: only when the converting contact is
  -- actually on this campaign's recipient list. Never guessed from geography.
  if p_contact_id is not null and p_mailing_id is not null then
    select r.id into v_recipient_id
      from mailing_recipients r
     where r.mailing_id = p_mailing_id
       and r.contact_id = p_contact_id
     limit 1;

    if v_recipient_id is not null then
      update mailing_scans
         set recipient_id = v_recipient_id
       where id = v_scan_id and recipient_id is null;

      update mailing_recipients
         set scan_count       = coalesce(scan_count, 0) + 1,
             first_scanned_at = least(coalesce(first_scanned_at, v_scanned_at), v_scanned_at),
             last_scanned_at  = greatest(coalesce(last_scanned_at, v_scanned_at), v_scanned_at)
       where id = v_recipient_id;

      if p_lead_id is not null then
        update mailing_leads set recipient_id = v_recipient_id
         where id = p_lead_id and recipient_id is null;
      end if;
    end if;
  end if;

  return v_scan_id;
end $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 5 — mailing_stats()
--
-- Per-campaign totals computed in SQL. Replaces the JS tally in `action=list`,
-- which fetched every scan row for every campaign and therefore stopped being
-- correct past PostgREST's row cap.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function mailing_stats(p_ids uuid[])
returns table (
  mailing_id      uuid,
  scans           bigint,
  raw_scans       bigint,
  bot_scans       bigint,
  unique_visitors bigint,
  leads           bigint,
  subscribers     bigint,
  recipients      bigint,
  converted       bigint,
  last_scan_at    timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with ids as (select unnest(p_ids) as id)
  select
    ids.id,
    coalesce(sc.scans, 0),
    coalesce(sc.raw_scans, 0),
    coalesce(sc.bot_scans, 0),
    coalesce(sc.unique_visitors, 0),
    coalesce(ld.leads, 0),
    coalesce(sb.subscribers, 0),
    coalesce(rc.recipients, 0),
    coalesce(ld.converted, 0),
    sc.last_scan_at
  from ids
  left join (
    select s.mailing_id,
           count(*) filter (where not s.is_bot and not s.is_duplicate) as scans,
           count(*)                                                     as raw_scans,
           count(*) filter (where s.is_bot)                             as bot_scans,
           count(distinct s.visitor_hash) filter (
             where not s.is_bot and s.visitor_hash is not null
           )                                                            as unique_visitors,
           max(s.scanned_at) filter (where not s.is_bot)                as last_scan_at
      from mailing_scans s
     where s.mailing_id = any(p_ids)
     group by s.mailing_id
  ) sc on sc.mailing_id = ids.id
  left join (
    select l.mailing_id,
           count(*)                                    as leads,
           count(*) filter (where l.scan_id is not null) as converted
      from mailing_leads l
     where l.mailing_id = any(p_ids)
     group by l.mailing_id
  ) ld on ld.mailing_id = ids.id
  left join (
    select b.mailing_id, count(*) as subscribers
      from mailing_subscribers b
     where b.mailing_id = any(p_ids) and b.status = 'subscribed'
     group by b.mailing_id
  ) sb on sb.mailing_id = ids.id
  left join (
    select r.mailing_id, count(*) as recipients
      from mailing_recipients r
     where r.mailing_id = any(p_ids)
     group by r.mailing_id
  ) rc on rc.mailing_id = ids.id;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 6 — mailing_analytics()
--
-- One campaign's full report as a single jsonb document, computed in SQL.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function mailing_analytics(p_mailing_id uuid, p_days integer default 90)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with bounds as (
    select (now() - make_interval(days => greatest(p_days, 1)))::timestamptz as since
  ),
  scans as (
    select s.* from mailing_scans s, bounds
     where s.mailing_id = p_mailing_id and s.scanned_at >= bounds.since
  ),
  real_scans as (
    select * from scans where not is_bot and not is_duplicate
  ),
  recips as (
    select * from mailing_recipients where mailing_id = p_mailing_id
  ),
  lds as (
    select l.* from mailing_leads l, bounds
     where l.mailing_id = p_mailing_id and l.created_at >= bounds.since
  ),
  days as (
    select generate_series(
      (select since::date from bounds), current_date, interval '1 day'
    )::date as d
  )
  select jsonb_build_object(
    'window_days',          greatest(p_days, 1),
    'recipients_total',     (select count(*) from recips),
    'recipients_scanned',   (select count(*) from recips where coalesce(scan_count, 0) > 0),
    'recipients_responded', (select count(*) from recips where responded),
    'total_scans',          (select count(*) from real_scans),
    'raw_scans',            (select count(*) from scans),
    'bot_scans',            (select count(*) from scans where is_bot),
    'duplicate_scans',      (select count(*) from scans where is_duplicate and not is_bot),
    'unique_scanners',      (select count(distinct visitor_hash) from real_scans where visitor_hash is not null),
    'returning_scanners',   (select count(*) from (
                               select visitor_hash from real_scans
                                where visitor_hash is not null
                                group by visitor_hash having count(*) > 1
                             ) t),
    'total_leads',          (select count(*) from lds),
    'attributed_leads',     (select count(*) from lds where scan_id is not null),
    'first_scan_at',        (select min(scanned_at) from real_scans),
    'last_scan_at',         (select max(scanned_at) from real_scans),
    -- Scans per 100 pieces mailed. With one QR code per campaign we cannot know
    -- WHICH recipients scanned, so this is a response index, not a per-person
    -- rate — the UI must label it as such.
    'response_index',       case when (select count(*) from recips) > 0
                              then round(((select count(*) from real_scans)::numeric
                                          / (select count(*) from recips)) * 100, 1)
                              else null end,
    'conversion_rate',      case when (select count(*) from real_scans) > 0
                              then round(((select count(*) from lds)::numeric
                                          / (select count(*) from real_scans)), 4)
                              else 0 end,
    'response_rate',        case when (select count(*) from recips) > 0
                              then round(((select count(*) from recips where responded)::numeric
                                          / (select count(*) from recips)), 4)
                              else 0 end,
    'timeline',             (select coalesce(jsonb_agg(jsonb_build_object(
                               'date', d, 'count', c, 'unique', u
                             ) order by d), '[]'::jsonb) from (
                               select days.d,
                                      count(r.id)                      as c,
                                      count(distinct r.visitor_hash)   as u
                                 from days
                                 left join real_scans r on r.scanned_at::date = days.d
                                group by days.d
                             ) t),
    'by_hour',              (select coalesce(jsonb_agg(jsonb_build_object(
                               'hour', h, 'count', c) order by h), '[]'::jsonb) from (
                               select extract(hour from scanned_at)::int as h, count(*) as c
                                 from real_scans group by 1
                             ) t),
    'by_device',            (select coalesce(jsonb_object_agg(k, c), '{}'::jsonb) from (
                               select coalesce(device_type, 'unknown') as k, count(*) as c
                                 from real_scans group by 1
                             ) t),
    'by_os',                (select coalesce(jsonb_object_agg(k, c), '{}'::jsonb) from (
                               select coalesce(os, 'unknown') as k, count(*) as c
                                 from real_scans group by 1
                             ) t),
    'by_country',           (select coalesce(jsonb_object_agg(k, c), '{}'::jsonb) from (
                               select coalesce(country, 'unknown') as k, count(*) as c
                                 from real_scans group by 1
                             ) t),
    'by_region',            (select coalesce(jsonb_agg(jsonb_build_object(
                               'region', k, 'city', ct, 'count', c) order by c desc), '[]'::jsonb) from (
                               select coalesce(region, '—') as k, coalesce(city, '—') as ct, count(*) as c
                                 from real_scans group by 1, 2 order by count(*) desc limit 25
                             ) t),
    'by_response',          (select coalesce(jsonb_object_agg(k, c), '{}'::jsonb) from (
                               select response_type as k, count(*) as c
                                 from recips where response_type is not null group by 1
                             ) t)
  );
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 7 — mailing_dashboard()
--
-- Org- or agent-scoped rollup. Scoping is applied inside the query so an agent
-- can never be handed another agent's totals.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function mailing_dashboard(
  p_agent_id uuid    default null,
  p_all      boolean default false,
  p_days     integer default 30
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with bounds as (
    select (now() - make_interval(days => greatest(p_days, 1)))::timestamptz as since
  ),
  scoped as (
    select m.* from mailings m
     where p_all
        or (p_agent_id is not null and (
              m.agent_id = p_agent_id
              or (m.landing_config -> 'agent_ids') @> to_jsonb(p_agent_id::text)
           ))
  ),
  scans as (
    select s.* from mailing_scans s, bounds
     where s.mailing_id in (select id from scoped)
       and s.scanned_at >= bounds.since
       and not s.is_bot and not s.is_duplicate
  ),
  lds as (
    select l.* from mailing_leads l, bounds
     where l.mailing_id in (select id from scoped) and l.created_at >= bounds.since
  ),
  days as (
    select generate_series(
      (select since::date from bounds), current_date, interval '1 day'
    )::date as d
  )
  select jsonb_build_object(
    'window_days',      greatest(p_days, 1),
    'total_mailings',   (select count(*) from scoped),
    'active_mailings',  (select count(*) from scoped where status in ('active', 'sent')),
    'total_recipients', (select coalesce(sum(coalesce(recipient_count, 0)), 0) from scoped),
    'total_scans_30d',  (select count(*) from scans),
    'unique_scanners',  (select count(distinct visitor_hash) from scans where visitor_hash is not null),
    'total_leads_30d',  (select count(*) from lds),
    'attributed_leads', (select count(*) from lds where scan_id is not null),
    'scans_today',      (select count(*) from scans where scanned_at::date = current_date),
    'scans_last_hour',  (select count(*) from scans where scanned_at > now() - interval '1 hour'),
    'trend',            (select coalesce(jsonb_agg(jsonb_build_object(
                           'date', d, 'count', c) order by d), '[]'::jsonb) from (
                           select days.d, count(s.id) as c
                             from days left join scans s on s.scanned_at::date = days.d
                            group by days.d
                         ) t),
    'top_mailings',     (select coalesce(jsonb_agg(jsonb_build_object(
                           'id', id, 'name', name, 'status', status,
                           'agent_id', agent_id, 'scan_count', c,
                           'recipient_count', recipient_count) order by c desc), '[]'::jsonb) from (
                           select sc.id, sc.name, sc.status, sc.agent_id, sc.recipient_count,
                                  count(s.id) as c
                             from scoped sc left join scans s on s.mailing_id = sc.id
                            group by sc.id, sc.name, sc.status, sc.agent_id, sc.recipient_count
                            order by count(s.id) desc limit 5
                         ) t)
  );
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 8 — reconcile_mailing_counters()
--
-- Self-healing safety net, run nightly by /api/cron?task=scan-reconcile. The
-- denormalized counters are a cache; the event tables are the truth. Any drift
-- (a counter bumped for a row that rolled back, a row inserted by a replay after
-- the counter had already been read) is repaired here, so the cards and the
-- drill-down can never disagree for more than a day.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function reconcile_mailing_counters()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fixed integer := 0;
begin
  with truth as (
    select m.id,
           (select count(*) from mailing_scans s
             where s.mailing_id = m.id and not s.is_bot and not s.is_duplicate) as scans,
           (select count(*) from mailing_leads l      where l.mailing_id = m.id) as leads,
           (select count(*) from mailing_recipients r where r.mailing_id = m.id) as recips,
           (select max(s.scanned_at) from mailing_scans s
             where s.mailing_id = m.id and not s.is_bot)                         as last_scan
      from mailings m
  ),
  drifted as (
    select t.* from truth t
      join mailings m on m.id = t.id
     where coalesce(m.scan_count, 0)      is distinct from t.scans
        or coalesce(m.lead_count, 0)      is distinct from t.leads
        or coalesce(m.recipient_count, 0) is distinct from t.recips
        or m.last_scan_at                 is distinct from t.last_scan
  ),
  upd as (
    update mailings m
       set scan_count      = d.scans,
           lead_count      = d.leads,
           recipient_count = d.recips,
           last_scan_at    = d.last_scan
      from drifted d
     where m.id = d.id
     returning m.id
  )
  select count(*) into v_fixed from upd;

  return jsonb_build_object(
    'ok', true,
    'mailings_repaired', v_fixed,
    'ran_at', now()
  );
end $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 9 — Grants
--
-- These run under the service key (which bypasses RLS) from api/campaigns.js.
-- `anon` is deliberately NOT granted: the public /m/ and landing-page paths all
-- go through the serverless function, so the browser never needs to call these
-- directly, and record_mailing_scan is SECURITY DEFINER — granting it to anon
-- would let anyone forge scans straight into the table.
-- ─────────────────────────────────────────────────────────────────────────────

revoke all on function record_mailing_scan(
  text, uuid, text, text, text, text, text, text, text, text, text, text, text,
  text, text, text, boolean, text, text, integer, boolean, integer
) from public, anon;

revoke all on function link_visit_conversion(text, uuid, uuid, uuid, uuid) from public, anon;
revoke all on function mailing_stats(uuid[])                    from public, anon;
revoke all on function mailing_analytics(uuid, integer)         from public, anon;
revoke all on function mailing_dashboard(uuid, boolean, integer) from public, anon;
revoke all on function reconcile_mailing_counters()             from public, anon;

grant execute on function mailing_stats(uuid[])                     to authenticated;
grant execute on function mailing_analytics(uuid, integer)          to authenticated;
grant execute on function mailing_dashboard(uuid, boolean, integer) to authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 10 — VERIFY (read-only; run after applying)
-- ─────────────────────────────────────────────────────────────────────────────
-- Expect one row per function, all present:
--   select proname from pg_proc
--    where proname in ('record_mailing_scan','link_visit_conversion','mailing_stats',
--                      'mailing_analytics','mailing_dashboard','reconcile_mailing_counters');
--
-- Expect the new columns:
--   select column_name from information_schema.columns
--    where table_name = 'mailing_scans' order by ordinal_position;
--
-- Expect zero drift immediately after a reconcile:
--   select reconcile_mailing_counters();


-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK — the application falls back to its pre-0031 query path when these
-- functions are absent, so dropping them is safe and needs no code deploy.
-- The columns are additive and can be left in place.
-- ─────────────────────────────────────────────────────────────────────────────
-- drop function if exists record_mailing_scan(text, uuid, text, text, text, text, text, text, text, text, text, text, text, text, text, text, boolean, text, text, integer, boolean, integer);
-- drop function if exists link_visit_conversion(text, uuid, uuid, uuid, uuid);
-- drop function if exists mailing_stats(uuid[]);
-- drop function if exists mailing_analytics(uuid, integer);
-- drop function if exists mailing_dashboard(uuid, boolean, integer);
-- drop function if exists reconcile_mailing_counters();
