-- ═════════════════════════════════════════════════════════════════════════════
-- 0037 — Website lead intake: durable round-robin, lead records, viewed
--        properties, drip hand-off
--
-- WHAT THIS REPLACES
-- The website lead path (api/property-public.js POST) picked an agent by
-- reading the most recent `lead_captures` row and taking the next agent
-- alphabetically. That is a read-modify-write over a history table, with three
-- problems this migration closes:
--
--   1. IT IS RACY. Two leads arriving in the same second both read the same
--      "last assigned" row and both get handed the SAME agent. This is the
--      exact failure mode 0031 fixed for QR scans, where ~2 of every 3
--      concurrent scans were lost. A brokerage website that gets a burst after
--      an email blast silently stacks leads on one agent.
--   2. THE POOL IS "EVERY AGENT OF THE SPECIALTY". There is no way to take an
--      agent out of the rotation — for vacation, for a performance plan, or
--      because they are an admin who never works leads. Listed as a planned
--      follow-up in docs/website-lead-integration.md; this is it.
--   3. DELETING LEAD HISTORY MOVED THE ROTATION. The cursor lived in the same
--      rows an admin deletes when cleaning up test leads.
--
-- The cursor now lives in `lead_rotations`, one row per lane, advanced inside a
-- `for update` lock. Rotation state is no longer inferable from, or damaged by,
-- lead history.
--
-- SAFE TO RUN BEFORE THE APP DEPLOY. Additive tables plus two functions; the
-- pre-deploy code never calls them. `lead_captures` and `visitor_events` are
-- untouched — the legacy landing-page capture keeps working unchanged.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. THE ROTATIONS
--
-- Two independent rings, keyed by lane. `cursor_agent_id` is the agent who took
-- the LAST lead in that lane; the next lead goes to whoever follows them in
-- ring order. `assigned_count` is what balances an "either specialty" lead
-- between the two rings (see lead_lane_for_both below).
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists lead_rotations (
  lane             text primary key check (lane in ('residential', 'commercial')),
  cursor_agent_id  uuid references agents(id) on delete set null,
  last_assigned_at timestamptz,
  assigned_count   bigint not null default 0,
  created_at       timestamptz default now()
);

insert into lead_rotations (lane) values ('residential'), ('commercial')
  on conflict (lane) do nothing;

-- Who is in each ring. `active` is the "in lead rotation" toggle — an agent can
-- be parked without being deleted, and can sit in BOTH rings (an agent who
-- genuinely works residential and commercial), which agents.specialty (a single
-- CHECK-constrained value) cannot express.
--
-- `sort_order` fixes the ring order. Equal values fall back to agent name, so
-- the default (all zeros) reproduces today's alphabetical rotation exactly.
create table if not exists lead_rotation_members (
  lane       text not null check (lane in ('residential', 'commercial')),
  agent_id   uuid not null references agents(id) on delete cascade,
  active     boolean not null default true,
  sort_order int     not null default 0,
  created_at timestamptz default now(),
  primary key (lane, agent_id)
);

create index if not exists idx_lead_rotation_members_lane
  on lead_rotation_members(lane, active);

-- Backfill the rings from agents.specialty, which is what the old round-robin
-- used as its pool. A null specialty went to residential there, so it does here.
insert into lead_rotation_members (lane, agent_id)
select case when a.specialty = 'commercial' then 'commercial' else 'residential' end, a.id
  from agents a
 on conflict (lane, agent_id) do nothing;

-- A NEW AGENT IS OTHERWISE INVISIBLE TO THE ROTATION. Ring membership is
-- explicit, which is the point — but that means hiring an agent and forgetting
-- this table would silently keep them out of the rotation forever, and nobody
-- notices a lead they never got. The trigger enrolls them the way the backfill
-- did, from their specialty.
--
-- INSERT only, on purpose: a later specialty change does NOT move them. Once an
-- admin has curated the rings (an agent parked, or deliberately in both), a
-- profile edit must not silently rewrite that.
create or replace function lead_rotation_autoenroll()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into lead_rotation_members (lane, agent_id)
  values (
    case when new.specialty = 'commercial' then 'commercial' else 'residential' end,
    new.id
  )
  on conflict (lane, agent_id) do nothing;
  return new;
end $$;

drop trigger if exists agents_lead_rotation_autoenroll on agents;
create trigger agents_lead_rotation_autoenroll
  after insert on agents
  for each row execute function lead_rotation_autoenroll();

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. THE LEAD RECORD
--
-- Distinct from `lead_captures`, which stays as-is for the legacy landing-page
-- form: that table is a flat capture row with a required first/last name and a
-- single free-text property address, anonymously insertable. `leads` is the
-- canonical intake record for the website webhook — service-key writes only,
-- structured interest, many viewed properties, and a drip hand-off.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists leads (
  id                 uuid primary key default gen_random_uuid(),

  -- The CRM contact this lead created or matched. Nullable so a lead is never
  -- lost to a contacts failure.
  contact_id         uuid references contacts(id) on delete set null,

  name               text not null,
  email              text not null,
  phone              text,

  -- What the visitor said they want.
  interest_type      text not null default 'residential'
                       check (interest_type in ('residential', 'commercial', 'both')),
  -- Which ring actually assigned them. For 'both' this records the lane the
  -- balancer chose, so the decision is auditable after the fact.
  lane               text check (lane in ('residential', 'commercial')),

  -- The one accountable owner. A lead with two owners has none.
  assigned_agent_id  uuid references agents(id) on delete set null,
  -- Notified-only courtesy for an 'both' lead: the other lane's next agent.
  -- Never the owner; see the email's own wording.
  secondary_agent_id uuid references agents(id) on delete set null,

  source             text not null default 'website',
  source_detail      text,                        -- e.g. 'manus', a campaign slug
  message            text,

  -- Exactly what the sender posted, after size limits. Keeps a webhook payload
  -- inspectable when a mapping turns out to be wrong.
  raw_payload        jsonb not null default '{}'::jsonb,

  -- Idempotency. A webhook sender that retries (or fires twice on a double
  -- click) must not create two leads or burn two rotation turns.
  dedupe_key         text,

  status             text not null default 'new'
                       check (status in ('new', 'contacted', 'qualified', 'converted', 'lost')),

  -- Drip hand-off. 'enrolled' means a contact_sequences row exists and
  -- /api/cron?task=sequence will pick it up; 'skipped' means no sequence is
  -- configured for the lane yet (the lead is still fully usable).
  drip_status        text not null default 'pending'
                       check (drip_status in ('pending', 'enrolled', 'skipped')),
  drip_sequence_id   uuid references sequences(id) on delete set null,

  assigned_at        timestamptz,
  created_at         timestamptz default now()
);

-- Partial, so the many legitimately-null keys don't collide.
create unique index if not exists idx_leads_dedupe_key
  on leads(dedupe_key) where dedupe_key is not null;

create index if not exists idx_leads_agent   on leads(assigned_agent_id, created_at desc);
create index if not exists idx_leads_email   on leads(lower(email));
create index if not exists idx_leads_status   on leads(status);
create index if not exists idx_leads_contact  on leads(contact_id);
-- The secondary lookup is its own index because RLS reads it per row.
create index if not exists idx_leads_secondary on leads(secondary_agent_id)
  where secondary_agent_id is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. WHAT THEY LOOKED AT
--
-- `property_id` is filled in when the posted URL or title resolves to a CRM
-- listing, and left null when it does not — an unmatched view is still the most
-- useful line in the agent's notification, so it is never dropped.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists lead_property_views (
  id          uuid primary key default gen_random_uuid(),
  lead_id     uuid not null references leads(id) on delete cascade,
  property_id uuid references properties(id) on delete set null,
  url         text,
  title       text,
  position    int,                        -- order as posted; the last view is the hottest
  viewed_at   timestamptz,
  created_at  timestamptz default now(),
  constraint lead_property_views_identifiable check (url is not null or title is not null)
);

create index if not exists idx_lead_property_views_lead     on lead_property_views(lead_id, position);
create index if not exists idx_lead_property_views_property on lead_property_views(property_id)
  where property_id is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. DRIP HAND-OFF
--
-- The drip machinery already exists (sequences / sequence_steps /
-- contact_sequences, run daily by /api/cron?task=sequence). All a new lead
-- needs is to be enrolled in the right sequence, so this marks ONE sequence per
-- lane as the auto-enroll target. No new cron, no second scheduler.
-- ─────────────────────────────────────────────────────────────────────────────
alter table sequences add column if not exists auto_enroll_lane text;

alter table sequences drop constraint if exists sequences_auto_enroll_lane_check;
alter table sequences add  constraint sequences_auto_enroll_lane_check
  check (auto_enroll_lane is null or auto_enroll_lane in ('residential', 'commercial'));

comment on column sequences.auto_enroll_lane is
  'Marks this sequence as the drip a new website lead in that lane is enrolled '
  'in automatically. Null = not an auto-enroll sequence. At most one per lane.';

create unique index if not exists idx_sequences_auto_enroll_lane
  on sequences(auto_enroll_lane) where auto_enroll_lane is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. ASSIGNMENT — one atomic round trip
--
-- Returns the agent AND the lane that actually assigned them, because the lane
-- can differ from the one asked for: a brokerage that has not staffed
-- commercial must still capture a commercial lead rather than drop it, so the
-- other ring is tried before giving up.
--
-- gen_random_uuid()/no extension dependency and an explicit search_path: the
-- 0033 outage was a `security definer ... set search_path = public` function
-- calling uuid_generate_v4(), which Supabase installs into `extensions`.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function assign_lead_round_robin(p_lane text)
returns table (agent_id uuid, lane text)
language plpgsql
security definer
set search_path = public
as $$
-- The OUT parameters are named agent_id and lane so PostgREST returns those
-- keys. That makes a bare `lane` ambiguous between the out-parameter and the
-- lead_rotations column — and an ON CONFLICT target must be a bare column name,
-- so `on conflict (lane)` below fails to parse at RUN TIME with "column
-- reference lane is ambiguous". This pragma resolves bare names to the column;
-- every other reference in the body is explicitly qualified regardless.
#variable_conflict use_column
declare
  v_lane   text;
  v_cursor uuid;
  v_next   uuid;
begin
  if p_lane is null or p_lane not in ('residential', 'commercial') then
    raise exception 'assign_lead_round_robin: unknown lane %', p_lane
      using errcode = '22023';
  end if;

  foreach v_lane in array array[
    p_lane,
    case p_lane when 'residential' then 'commercial' else 'residential' end
  ] loop
    v_next   := null;
    v_cursor := null;

    insert into lead_rotations (lane) values (v_lane) on conflict (lane) do nothing;

    -- THE LOCK THAT MAKES THIS CORRECT. Concurrent webhook deliveries for the
    -- same lane queue here, so each one reads a cursor that already includes
    -- the assignment before it. Without it they read the same cursor and hand
    -- the same agent every lead in the burst.
    select r.cursor_agent_id into v_cursor
      from lead_rotations r
     where r.lane = v_lane
       for update;

    with ring as (
      select m.agent_id                                                   as id,
             row_number() over (order by m.sort_order, a.name, m.agent_id) as rn,
             count(*)     over ()                                          as total
        from lead_rotation_members m
        join agents a on a.id = m.agent_id
       where m.lane = v_lane
         and m.active
    )
    select r.id into v_next
      from ring r
     where r.rn = (
       -- Position of the previous assignee, wrapped. A null cursor (first lead
       -- ever) and a cursor whose agent has since left the ring both resolve to
       -- max(rn), so the next pick is rn 1 — the ring restarts at its head
       -- rather than throwing.
       coalesce(
         (select c.rn from ring c where c.id = v_cursor),
         (select max(c.rn) from ring c)
       ) % (select max(c.total) from ring c)
     ) + 1;

    if v_next is not null then
      update lead_rotations r
         set cursor_agent_id  = v_next,
             last_assigned_at = now(),
             assigned_count   = r.assigned_count + 1
       where r.lane = v_lane;

      return query select v_next, v_lane;
      return;
    end if;
  end loop;

  -- Both rings empty: no agents configured at all. The caller stores the lead
  -- unassigned rather than rejecting the webhook — an unassigned lead in the
  -- CRM is recoverable, a 500 to the website is a lost lead.
  return;
end $$;

-- Which ring should take an "either specialty" lead. The ring that has taken
-- fewer leads, so 'both' traffic does not quietly starve one side. Only
-- considers rings that actually have an active member.
create or replace function lead_lane_for_both()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select r.lane
    from lead_rotations r
   where exists (
     select 1 from lead_rotation_members m
      where m.lane = r.lane and m.active
   )
   order by r.assigned_count asc, r.lane asc
   limit 1;
$$;

-- Service role only. These advance shared state and bypass RLS by design;
-- an authenticated agent must not be able to spin the rotation onto themselves.
revoke all on function assign_lead_round_robin(text) from public;
revoke all on function lead_lane_for_both()          from public;
grant execute on function assign_lead_round_robin(text) to service_role;
grant execute on function lead_lane_for_both()          to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. RLS
--
-- Every write here comes from /api/webhooks/website-lead on the SERVICE key,
-- which bypasses RLS. So unlike `lead_captures` — which carries
-- `create policy public_insert ... to anon` because the landing-page form posts
-- with the anon key that ships in the browser bundle — these tables get NO anon
-- policy at all. Nothing in the browser can write a lead, forge an assignment,
-- or read someone else's pipeline.
--
-- Every policy names `to authenticated` explicitly. A policy with no TO clause
-- applies to PUBLIC, which in Supabase includes anon; that is exactly how eight
-- tables ended up anonymously writable before 0027, and
-- src/lib/__tests__/rlsPolicyHygiene.test.js fails the build if it recurs.
-- ─────────────────────────────────────────────────────────────────────────────
alter table leads                enable row level security;
alter table lead_property_views  enable row level security;
alter table lead_rotations       enable row level security;
alter table lead_rotation_members enable row level security;

-- LEADS — read-only to agents, and only their own: the assigned owner, the
-- notified secondary on a 'both' lead, sharing team peers (same dimension as
-- contacts, since a lead becomes a contact), and admins.
--
-- Deliberately `for select` and nothing else. A lead's assignment is the
-- round-robin's output; an agent who could UPDATE it could reassign a peer's
-- lead to themselves, and one who could DELETE it could erase the evidence.
-- Reassignment is an admin action (below) and status changes belong to the
-- contact record the agent already owns.
drop policy if exists leads_read_scope on leads;
create policy leads_read_scope on leads for select to authenticated
  using (
    app_is_admin()
    or assigned_agent_id  in (select app_visible_agent_ids('contacts'))
    or secondary_agent_id = app_current_agent_id()
  );

-- Admins can correct an assignment (agent quit, lead landed in the wrong lane).
drop policy if exists leads_admin_write on leads;
create policy leads_admin_write on leads for update to authenticated
  using (app_is_admin()) with check (app_is_admin());

drop policy if exists leads_admin_delete on leads;
create policy leads_admin_delete on leads for delete to authenticated
  using (app_is_admin());

-- VIEWED PROPERTIES — visible through the parent lead, same rule, no separate
-- grant. Read-only for the same reason.
drop policy if exists lead_property_views_scope on lead_property_views;
create policy lead_property_views_scope on lead_property_views for select to authenticated
  using (exists (
    select 1 from leads l
     where l.id = lead_property_views.lead_id
       and (
         app_is_admin()
         or l.assigned_agent_id  in (select app_visible_agent_ids('contacts'))
         or l.secondary_agent_id = app_current_agent_id()
       )
  ));

-- THE ROTATIONS — readable by any authenticated agent (whose turn is next is
-- not a secret, and hiding it is how a rotation loses trust), writable by
-- admins only. `lead_rotations` holds the cursor: an agent who could UPDATE it
-- could point it at the person before them and take every lead.
drop policy if exists lead_rotations_read on lead_rotations;
create policy lead_rotations_read on lead_rotations for select to authenticated
  using (true);

drop policy if exists lead_rotations_admin_write on lead_rotations;
create policy lead_rotations_admin_write on lead_rotations for all to authenticated
  using (app_is_admin()) with check (app_is_admin());

drop policy if exists lead_rotation_members_read on lead_rotation_members;
create policy lead_rotation_members_read on lead_rotation_members for select to authenticated
  using (true);

drop policy if exists lead_rotation_members_admin_write on lead_rotation_members;
create policy lead_rotation_members_admin_write on lead_rotation_members for all to authenticated
  using (app_is_admin()) with check (app_is_admin());

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. VERIFY (read-only — run after applying)
-- ─────────────────────────────────────────────────────────────────────────────
-- Who is in each ring, in the order leads will be handed out:
--   select m.lane, a.name, m.active, m.sort_order
--     from lead_rotation_members m join agents a on a.id = m.agent_id
--    order by m.lane, m.sort_order, a.name;
--
-- Both rings should be staffed, or 'both' leads all land on one side:
--   select lane, assigned_count, cursor_agent_id from lead_rotations;
--
-- Dry-run the ring order WITHOUT advancing the cursor (assign_lead_round_robin
-- is a write — calling it to "check" consumes a turn):
--   with ring as (
--     select a.name, row_number() over (order by m.sort_order, a.name, m.agent_id) rn
--       from lead_rotation_members m join agents a on a.id = m.agent_id
--      where m.lane = 'residential' and m.active
--   ) select * from ring order by rn;
