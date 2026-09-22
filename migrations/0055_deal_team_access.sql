-- Migration 0055 — Everyone on the listing sees the deal
-- ===========================================================================
-- THE REPORT
--   Two agents share a listing. One creates the property, starts the deal,
--   adds the second agent to the listing, and uploads documents. The second
--   agent sees no deal and no documents.
--
-- ═══ WHY THE PREVIOUS FIXES DID NOT SETTLE IT ══════════════════════════════
--
-- 0025/0049/0051/0052/0053 all worked on the same assumption: that
-- `deals.co_agent_ids` is the truth about who is on a deal, and that the job
-- is to keep that column filled (backfills, unions, "run this before that").
--
-- It isn't the truth. It is a COPY, taken once, at the instant a property is
-- converted into a deal:
--
--     Properties.jsx > startDeal()  →  coAgentIdsForNewDeal(property, agent)
--     Pipeline.jsx   > save()       →  seededCoAgents, but `deal?.id ? [] : …`
--
-- Read that second line again: an EXISTING deal never re-seeds. So the exact
-- sequence in the report —
--
--     create property → start deal → THEN add the second agent to the listing
--
-- writes the new agent into `properties.details.co_agent_ids` and nowhere
-- else. The deal's column still holds the copy taken before they existed.
-- Every reader then splits into two camps:
--
--   • The UI reads the property as a fallback (`dealCoAgentIds`), so the
--     "Agents on deal" card shows BOTH names. The deal looks shared.
--   • RLS reads only `deals.co_agent_ids` — `app_visible_deal_ids()` — so the
--     deal, its documents rows, its `deal-<uuid>/` storage objects, its
--     signatures, its audit log and its key dates are all invisible to the
--     second agent.
--
-- The card says shared; the database says private. No backfill can close that,
-- because the divergence is re-created every time anybody edits a listing
-- after its deal exists. A backfill is a snapshot of a race.
--
-- ═══ THE ANGLE THIS FILE TAKES ═════════════════════════════════════════════
--
-- Stop treating the copy as the source of truth. DERIVE access from every
-- place the office actually records "this agent is on this deal", and make the
-- copy a cache that the database itself keeps in sync.
--
--   1. IDENTITY FIRST. `app_current_agent_id()` returned one row matched on
--      `auth_id` alone. An agent whose row was never linked to their login
--      (`agents.auth_id is null` — 0053 could only print these and say "fix by
--      hand") resolves to NULL, and NULL matches no policy: they see nothing
--      anywhere, whatever the co-agent columns say. Identity now also matches
--      the verified email on the JWT, and `app_my_agent_ids()` returns EVERY
--      agent row that belongs to the caller — so an office with a duplicate
--      roster row (one linked, one not, and the listing pointing at the wrong
--      one) stops being a silent blackout.
--
--   2. VISIBILITY IS DERIVED, from all five records of membership:
--        • deals.agent_id                        (the deal's own agent)
--        • deals.co_agent_ids                    (additional agents on the deal)
--        • properties.assigned_agent_id          (the listing agent)   ← NEW
--        • properties.details.co_agent_ids       (the listing's co-agents) ← NEW
--        • commissions.participants              (whoever gets paid)
--      The two NEW arms are the reported bug: add an agent to the listing at
--      any time — before the deal, after the deal, a year later — and the deal
--      is theirs to see, with no copy step in between and no migration to run.
--
--   3. THE COPY IS MAINTAINED BY THE DATABASE. Two triggers keep
--      `deals.co_agent_ids` and `properties.details.co_agent_ids` in step in
--      both directions, so the commission seed, the team card, the signer
--      prefill and the storage policy all read the same list no matter which
--      screen the agent used. Adding a co-agent on the DEAL now also puts them
--      on the LISTING (which is what makes the property itself visible to
--      them), and removing them from the listing removes them from its deals.
--
--   4. THE DEAL'S PEOPLE COME WITH THE DEAL. Seeing a deal and not its buyer
--      and seller is not collaboration. `contacts` was scoped to
--      own + team-peers only, so a co-agent opened a deal with a blank client,
--      an empty portal and a listing agreement that could not be prefilled.
--      Contacts named on a visible deal are now visible.
--
--   5. WRITING YOURSELF ONTO A LISTING IS CLOSED OFF. `properties` was
--      `allow_all_authenticated` — every signed-in agent could UPDATE every
--      property in the firm. With membership now derived from the listing,
--      that would have been a self-service grant: set yourself as a listing's
--      co-agent, see someone else's deal. Reads stay firm-wide (the property
--      roster always has been, and the duplicate-deal check in 0054 relies on
--      it). WRITES now require that you are already on that listing — its
--      agent, a sharing team peer, one of its co-agents, or an office admin.
--      Unassigned properties stay claimable. This is the guard that lets arm 2
--      exist; 0054's rule still holds — the owner widens the team, never the
--      person wanting in.
--
-- ═══ WHAT AN AGENT GETS BACK ═══════════════════════════════════════════════
--   Named on the listing or the deal, they see and may edit: the deal and its
--   terms, the property, the buyer and seller, the documents (rows AND the
--   files in storage), the signature packets and their events, the audit log,
--   transaction steps, key dates, deal contacts and the field layouts — every
--   table already written as `deal_id in (select app_visible_deal_ids())`
--   inherits all of this for free, which is the point of fixing it there.
--   Commissions stay admin-only and tasks stay personal, both unchanged.
--
-- SAFETY
--   Idempotent; safe to re-run. Additive for agents (every arm is a UNION —
--   nobody loses deal access) with exactly one deliberate narrowing: property
--   WRITES, per item 5. Apply after 0053. Read the NOTICES at the end.
-- ===========================================================================

begin;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. IDENTITY — who is calling, across every agent row that is theirs
-- ───────────────────────────────────────────────────────────────────────────

-- The verified email on the request's JWT, lowercased. Wrapped in plpgsql with
-- an exception guard because `request.jwt.claims` is absent for a direct psql
-- session and must not raise there.
create or replace function app_jwt_email()
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare claims text; found text;
begin
  -- PostgREST puts the whole verified token in `request.jwt.claims`.
  claims := current_setting('request.jwt.claims', true);
  if claims is not null and claims <> '' then
    found := lower(nullif(claims::jsonb ->> 'email', ''));
    if found is not null then return found; end if;
  end if;
  -- Older PostgREST (and the repo's own validation shim) set each claim
  -- separately instead. Checked second so the token always wins.
  return lower(nullif(current_setting('request.jwt.claim.email', true), ''));
exception when others then
  return null;
end $$;

-- EVERY agents row belonging to the caller: the one linked to their login,
-- plus any unlinked row carrying the same verified email. That second arm is
-- what stops a roster row nobody ever linked — or a duplicate row that a
-- listing happens to point at — from hiding a deal the agent is plainly on.
-- Only `auth_id is null` rows are claimed by email: a row already linked to a
-- DIFFERENT login belongs to that person, whatever its email column says.
create or replace function app_my_agent_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select a.id from agents a where a.auth_id = auth.uid()
  union
  select a.id from agents a
   where a.auth_id is null
     and app_jwt_email() is not null
     and lower(a.email) = app_jwt_email();
$$;

-- Unchanged contract: ONE id, for the many places that stamp authorship
-- (activities.agent_id, tasks.agent_id, audit_log.actor_id). The linked row
-- wins; an email-matched row is the fallback, so an agent whose login was
-- never linked can now act instead of silently seeing nothing.
create or replace function app_current_agent_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select a.id
    from agents a
   where a.auth_id = auth.uid()
      or (a.auth_id is null
          and app_jwt_email() is not null
          and lower(a.email) = app_jwt_email())
   order by (a.auth_id = auth.uid()) desc nulls last, a.created_at
   limit 1;
$$;

-- Office admin, over the same identity set. The two accounts that own the
-- toggle (migration 0032) keep their no-fallback rule: OFF means OFF.
create or replace function app_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(bool_or(
    is_admin
    or (role ilike '%admin%'
        and lower(coalesce(email, '')) not in ('erin@gatewayreadvisors.com', 'daniel@gatewayreadvisors.com'))
  ), false)
  from agents where id in (select app_my_agent_ids());
$$;

-- Self + team peers who share the named dimension, over the same identity set.
create or replace function app_visible_agent_ids(dimension text)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from agents where id in (select app_my_agent_ids())
  union
  select peer.agent_id
    from team_splits me
    join team_splits peer
      on peer.team_id = me.team_id
     and peer.agent_id <> me.agent_id
   where me.agent_id in (select app_my_agent_ids())
     and case dimension
           when 'contacts'   then peer.share_contacts
           when 'properties' then peer.share_properties
           when 'deals'      then peer.share_deals
           else false
         end is not false;
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The uuid list inside a `details.co_agent_ids` blob
-- ───────────────────────────────────────────────────────────────────────────
-- The property's co-agents live in a free-form jsonb blob, so anything can be
-- in there: a non-array value from an older shape, '' from a cleared picker, a
-- name typed where an id belongs. Everything that reads it needs the same
-- forgiving parse, in one place, or the policy and the trigger disagree about
-- who is on a listing.
create or replace function app_jsonb_uuid_array(j jsonb)
returns uuid[]
language sql
immutable
set search_path = public
as $$
  select coalesce(array_agg(distinct v::uuid), '{}'::uuid[])
    from jsonb_array_elements_text(
           case when jsonb_typeof(j) = 'array' then j else '[]'::jsonb end) t(v)
   where v ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. VISIBILITY — derived from every record of membership there is
-- ───────────────────────────────────────────────────────────────────────────
-- Every `deal_id in (select app_visible_deal_ids())` policy in the schema —
-- documents, document_versions, boldsign_documents, signature_packet_events,
-- transaction_steps, deal_contacts, deal_field_layouts, deal_template_drafts,
-- deadline_reminders, closing_packets, audit_log, agent_nudges — and the
-- storage policies from 0053 all inherit this function. Widening it here is
-- what makes the co-agent's documents appear.
create or replace function app_visible_deal_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  -- office admin / transaction coordinator: the whole firm
  select d.id from deals d where app_is_admin()
  union
  -- the deal's own agent, and team peers who share deals
  select d.id from deals d
   where d.agent_id in (select app_visible_agent_ids('deals'))
  union
  -- additional agents recorded on the deal
  select d.id from deals d
   where coalesce(d.co_agent_ids, '{}') && array(select m from app_my_agent_ids() m)
  union
  -- NEW: the listing agent of the property this deal is on. Whoever started
  -- the deal, the agent the listing is assigned to is on it.
  select d.id from deals d
   join properties p on p.id = d.property_id
   where p.assigned_agent_id in (select app_my_agent_ids())
  union
  -- NEW: co-agents named on the listing — at any time, before or after the
  -- deal was started. This is the reported bug, closed without a copy step.
  select d.id from deals d
   join properties p on p.id = d.property_id
   where app_jsonb_uuid_array(p.details -> 'co_agent_ids') && array(select m from app_my_agent_ids() m)
  union
  -- co-listed via structured commission participants (whoever gets paid)
  select c.deal_id
    from commissions c
    cross join lateral jsonb_array_elements(coalesce(c.participants, '[]'::jsonb)) p
   where (p->>'agent_id') is not null
     and (p->>'agent_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
     and (p->>'agent_id')::uuid in (select app_my_agent_ids());
$$;

-- Properties the caller may see. `properties` is readable firm-wide in RLS, so
-- this exists for the CLIENT: every property page filters its fetch, and those
-- filters are where a co-agent's listing used to disappear while the deal
-- stayed visible. One definition, called by both sides, cannot drift.
create or replace function app_visible_property_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.id from properties p where app_is_admin()
  union
  select p.id from properties p
   where p.assigned_agent_id in (select app_visible_agent_ids('properties'))
  union
  select p.id from properties p
   where app_jsonb_uuid_array(p.details -> 'co_agent_ids') && array(select m from app_my_agent_ids() m)
  union
  -- the listing behind any deal the caller is on
  select d.property_id from deals d
   where d.property_id is not null
     and d.id in (select app_visible_deal_ids());
$$;

-- Contacts the caller may see: their own book, their sharing team peers' —
-- and the people named on a deal they are on. A deal without its buyer and
-- seller is not a deal you can work.
do $$
declare
  has_sides boolean;
  side_arm  text := '';
begin
  select count(*) = 2 into has_sides
    from information_schema.columns
   where table_schema = 'public' and table_name = 'deals'
     and column_name in ('buyer_contact_id', 'seller_contact_id');

  -- deals.buyer_contact_id / seller_contact_id arrive with migration 0040; on
  -- a database without them the deal's single `contact_id` is the whole story.
  if has_sides then
    side_arm := ', (d.buyer_contact_id), (d.seller_contact_id)';
  end if;

  execute format($f$
    create or replace function app_visible_contact_ids()
    returns setof uuid
    language sql
    stable
    security definer
    set search_path = public
    as $body$
      select c.id from contacts c where app_is_admin()
      union
      select c.id from contacts c
       where c.assigned_agent_id in (select app_visible_agent_ids('contacts'))
      union
      -- the parties on a visible deal
      select x.cid
        from deals d
        cross join lateral (values (d.contact_id)%s) x(cid)
       where d.id in (select app_visible_deal_ids())
         and x.cid is not null
      union
      -- additional contacts / co-signers linked to a visible deal
      select dc.contact_id
        from deal_contacts dc
       where dc.deal_id in (select app_visible_deal_ids());
    $body$;
  $f$, side_arm);
end $$;

grant execute on function app_jwt_email()               to authenticated;
grant execute on function app_my_agent_ids()            to authenticated;
grant execute on function app_current_agent_id()        to authenticated;
grant execute on function app_is_admin()                to authenticated;
grant execute on function app_visible_agent_ids(text)   to authenticated;
grant execute on function app_jsonb_uuid_array(jsonb)   to authenticated;
grant execute on function app_visible_deal_ids()        to authenticated;
grant execute on function app_visible_property_ids()    to authenticated;
grant execute on function app_visible_contact_ids()     to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. CONTACTS — the deal's people come with the deal
-- ───────────────────────────────────────────────────────────────────────────
-- `using` widens to the derived list. `with check` keeps its original rule for
-- new rows (you may only file a contact under yourself or a sharing peer) and
-- adds the deal arm, so a co-agent can correct a phone number on the seller of
-- a deal they are working without being handed the owner's whole book.
drop policy if exists contacts_agent_scope on contacts;
create policy contacts_agent_scope on contacts for all to authenticated
  using (app_is_admin() or id in (select app_visible_contact_ids()))
  with check (
    app_is_admin()
    or assigned_agent_id in (select app_visible_agent_ids('contacts'))
    or id in (select app_visible_contact_ids())
  );

-- ───────────────────────────────────────────────────────────────────────────
-- 5. PROPERTIES — read firm-wide, write only if you are on the listing
-- ───────────────────────────────────────────────────────────────────────────
-- The guard that makes section 3's listing arms safe. Before this, one
-- `allow_all_authenticated` policy covered ALL commands: any signed-in agent
-- could write any property in the firm, which with derived membership would
-- have meant self-granting access to a colleague's deal.
--
-- SELECT stays open to every signed-in agent — it always has been, the pickers
-- and the duplicate-deal check in 0054 depend on it, and the client narrows
-- reads through app_visible_property_ids(). INSERT stays open: agents add
-- listings. UPDATE and DELETE now require being on the listing already.
--
-- There is no `with check` on UPDATE on purpose: USING decides WHO may write
-- this listing, and anyone who passes it is already on the team, so the row
-- they leave behind (including handing the listing to someone else, or taking
-- themselves off it) is an ordinary office action, not an escalation.
do $$ begin
  drop policy if exists allow_all             on properties;
  drop policy if exists allow_all_authenticated on properties;
  drop policy if exists properties_read       on properties;
  drop policy if exists properties_insert     on properties;
  drop policy if exists properties_update     on properties;
  drop policy if exists properties_delete     on properties;
end $$;

create policy properties_read on properties for select to authenticated
  using (true);

create policy properties_insert on properties for insert to authenticated
  with check (true);

create policy properties_update on properties for update to authenticated
  using (
    app_is_admin()
    or assigned_agent_id is null                     -- unclaimed: anyone may take it on
    or assigned_agent_id in (select app_visible_agent_ids('properties'))
    or app_jsonb_uuid_array(details -> 'co_agent_ids') && array(select m from app_my_agent_ids() m)
  )
  with check (true);

create policy properties_delete on properties for delete to authenticated
  using (
    app_is_admin()
    or assigned_agent_id is null
    or assigned_agent_id in (select app_visible_agent_ids('properties'))
    or app_jsonb_uuid_array(details -> 'co_agent_ids') && array(select m from app_my_agent_ids() m)
  );

-- ───────────────────────────────────────────────────────────────────────────
-- 6. THE CACHE, KEPT BY THE DATABASE
-- ───────────────────────────────────────────────────────────────────────────
-- Access no longer depends on `deals.co_agent_ids` being right, but plenty of
-- other things still read it: the commission seed (normalizeCommission), the
-- signer prefill, the deal announcement, /api/portal earnings. Those must not
-- be told a different team from the one RLS grants — which is the divergence
-- this whole file is about. So the database keeps the two lists in step,
-- whatever screen or script did the writing.
--
-- `pg_trigger_depth() > 1` on both sides is the recursion stop: each direction
-- fires only for a write that came from outside, never for the write its
-- counterpart just made.

-- LISTING → ITS DEALS. Applies the exact diff, so adding a co-agent to a
-- listing adds them to its deals and taking them off takes them off. An agent
-- added on the DEAL alone is untouched by a listing edit that did not mention
-- them.
create or replace function app_sync_property_coagents_to_deals()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  old_ids uuid[];
  new_ids uuid[];
  added   uuid[];
  removed uuid[];
begin
  if pg_trigger_depth() > 1 then return new; end if;

  old_ids := case when tg_op = 'UPDATE'
                  then app_jsonb_uuid_array(old.details -> 'co_agent_ids')
                  else '{}'::uuid[] end;
  new_ids := app_jsonb_uuid_array(new.details -> 'co_agent_ids');

  added   := array(select x from unnest(new_ids) x except select y from unnest(old_ids) y);
  removed := array(select x from unnest(old_ids) x except select y from unnest(new_ids) y);
  if added = '{}'::uuid[] and removed = '{}'::uuid[] then return new; end if;

  update deals d
     set co_agent_ids = (
           select coalesce(array_agg(distinct s.x), '{}'::uuid[])
             from (select unnest(coalesce(d.co_agent_ids, '{}')) as x
                   union
                   select unnest(added)) s
            where s.x is not null
              and s.x is distinct from d.agent_id   -- the deal's agent is never a co-agent
              and not (s.x = any(removed))
         )
   where d.property_id = new.id;

  return new;
end $$;

drop trigger if exists trg_property_coagents_to_deals on properties;
create trigger trg_property_coagents_to_deals
  after insert or update of details on properties
  for each row execute function app_sync_property_coagents_to_deals();

-- DEAL → ITS LISTING, union only. One property can carry several deals, so a
-- co-agent dropped from one deal must not be stripped off the listing (and off
-- the other deal with it); removal is an edit to the listing, which the
-- direction above then applies everywhere. The listing's own assigned agent is
-- never also one of its co-agents.
create or replace function app_sync_deal_coagents_to_property()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  cur      uuid[];
  merged   uuid[];
  owner_id uuid;
begin
  if pg_trigger_depth() > 1 then return new; end if;
  if new.property_id is null then return new; end if;
  if coalesce(new.co_agent_ids, '{}') = '{}'::uuid[] then return new; end if;

  select app_jsonb_uuid_array(p.details -> 'co_agent_ids'), p.assigned_agent_id
    into cur, owner_id
    from properties p where p.id = new.property_id;
  if not found then return new; end if;

  merged := array(
    select distinct s.x
      from (select unnest(cur) as x
            union
            select unnest(coalesce(new.co_agent_ids, '{}'))) s
     where s.x is not null
       and s.x is distinct from owner_id
     order by s.x);

  if cur @> merged and cur <@ merged then return new; end if;

  update properties
     set details = coalesce(details, '{}'::jsonb)
                   || jsonb_build_object('co_agent_ids', to_jsonb(merged::text[]))
   where id = new.property_id;

  return new;
end $$;

drop trigger if exists trg_deal_coagents_to_property on deals;
create trigger trg_deal_coagents_to_property
  after insert or update of co_agent_ids, property_id on deals
  for each row execute function app_sync_deal_coagents_to_property();

-- ───────────────────────────────────────────────────────────────────────────
-- 7. BACKFILL — one pass, both directions
-- ───────────────────────────────────────────────────────────────────────────
-- Not the fix (section 3 already grants access without it) but it makes the
-- commission seed, the team card and the signer prefill agree with the grant
-- from this moment on, for deals that pre-date the triggers.
do $$
declare n_deals int; n_props int;
begin
  with filled as (
    update deals d set co_agent_ids = m.ids
      from (
        select d2.id,
               (select coalesce(array_agg(distinct s.x), '{}'::uuid[])
                  from (select unnest(coalesce(d2.co_agent_ids, '{}')) as x
                        union
                        select unnest(app_jsonb_uuid_array(p.details -> 'co_agent_ids'))) s
                 where s.x is not null
                   and s.x is distinct from d2.agent_id) as ids
          from deals d2
          join properties p on p.id = d2.property_id
      ) m
     where d.id = m.id
       and not (coalesce(d.co_agent_ids, '{}') @> m.ids and coalesce(d.co_agent_ids, '{}') <@ m.ids)
    returning 1)
  select count(*) into n_deals from filled;

  with pushed as (
    update properties p
       set details = coalesce(p.details, '{}'::jsonb)
                     || jsonb_build_object('co_agent_ids', to_jsonb(m.ids::text[]))
      from (
        select p2.id,
               (select coalesce(array_agg(distinct s.x), '{}'::uuid[])
                  from (select unnest(app_jsonb_uuid_array(p2.details -> 'co_agent_ids')) as x
                        union
                        select unnest(coalesce(d.co_agent_ids, '{}'))
                          from deals d where d.property_id = p2.id) s
                 where s.x is not null
                   and s.x is distinct from p2.assigned_agent_id) as ids
          from properties p2
         where exists (select 1 from deals d where d.property_id = p2.id)
      ) m
     where p.id = m.id
       and not (app_jsonb_uuid_array(p.details -> 'co_agent_ids') @> m.ids
                and app_jsonb_uuid_array(p.details -> 'co_agent_ids') <@ m.ids)
    returning 1)
  select count(*) into n_props from pushed;

  raise notice '--- co-agent cache aligned: % deal(s), % listing(s) ---', n_deals, n_props;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 8. THE NIGHTLY AUDIT LEARNS THE NEW MODEL
-- ───────────────────────────────────────────────────────────────────────────
-- `app_access_audit()` (migration 0050) runs nightly from api/cron.js and
-- notifies office admins on any FAIL. It was written against the old model, so
-- left alone it would keep checking the wrong things and — worse — would pass a
-- database where THIS migration was never applied. CI cannot catch that: it
-- parses schema.sql as text and passes whether or not a migration has run,
-- which is precisely how a storage policy hid every deal's documents for
-- months without a single red build.
--
-- Rather than restate 0050's 250 lines here (two copies of an audit is how the
-- audit itself drifts), its function is RENAMED to `app_access_audit_core()`
-- and a wrapper takes its name: the wrapper returns every row core produced,
-- then adds the checks this migration is responsible for. If 0050 was never
-- applied the wrapper stands alone and says so.
do $$
begin
  if exists (
        select 1 from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
         where ns.nspname = 'public' and pr.proname = 'app_access_audit'
           and pg_get_function_identity_arguments(pr.oid) = '')
     and not exists (
        select 1 from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
         where ns.nspname = 'public' and pr.proname = 'app_access_audit_core')
  then
    alter function app_access_audit() rename to app_access_audit_core;
    raise notice '--- app_access_audit() from 0050 renamed to app_access_audit_core() ---';
  end if;
end $$;

create or replace function app_access_audit()
returns table (area text, item text, status text, detail text)
language plpgsql
security definer
set search_path = public
as $$
declare
  has_core boolean;
  n int;
  deal_fn text;
begin
  if not app_is_admin() then
    raise exception 'app_access_audit() is for office admins';
  end if;

  select exists (
    select 1 from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
     where ns.nspname = 'public' and pr.proname = 'app_access_audit_core'
  ) into has_core;

  -- Everything migration 0050 checks, unchanged — except for the one row whose
  -- ADVICE this migration invalidates. That check counted deals whose team card
  -- named a co-agent `deals.co_agent_ids` did not, and told the reader they had
  -- lost access and to run 0053. They have not: access is now derived from the
  -- listing too, so the only thing out of step is the cached column the
  -- commission seed reads. Same count, honest severity.
  if has_core then
    for area, item, status, detail in select c.area, c.item, c.status, c.detail from app_access_audit_core() c loop
      if item = 'deals displaying a co-agent RLS does not grant' and status <> 'ok' then
        status := 'warn';
        detail := replace(detail,
          'show a co-agent on the team card that RLS does not grant. Run migration 0053 — it MERGES the property''s co-agents in, where 0049/0051 only filled a column that was entirely empty.',
          'carry a co-agent cache that is behind their listing. Since migration 0055 this costs no ACCESS — the listing grants it directly — but the commission seed and the signer prefill read the cached column, so they may name a smaller team than the deal page does. The sync triggers fix this on the next edit either side.');
      end if;
      return next;
    end loop;
  else
    area := 'migration'; item := '0050 access audit';
    status := 'warn';
    detail := 'NOT APPLIED — only the migration 0055 checks below are running. Apply migrations/0050_access_audit.sql for the storage and anon-exposure checks.';
    return next;
  end if;

  -- ── Is the listing actually part of the model in THIS database? ───────────
  -- The one check that would have caught the reported bug. `app_visible_deal_ids()`
  -- is read out of the catalog rather than assumed: a file in the repository
  -- proves nothing about what is installed.
  area := 'migration'; item := '0055 deal team access';
  select pg_get_functiondef(pr.oid) into deal_fn
    from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
   where ns.nspname = 'public' and pr.proname = 'app_visible_deal_ids'
   limit 1;
  if deal_fn is null then
    status := 'FAIL';
    detail := 'app_visible_deal_ids() is missing entirely — no agent can see any deal. Run migrations/0055_deal_team_access.sql.';
  elsif deal_fn not like '%assigned_agent_id in (select app_my_agent_ids())%'
     or deal_fn not like '%app_jsonb_uuid_array(p.details -> ''co_agent_ids'')%' then
    status := 'FAIL';
    detail := 'NOT APPLIED — deal access still comes only from the copy taken when the property was converted, so an agent added to a listing AFTER its deal was started cannot see the deal or its documents. Run migrations/0055_deal_team_access.sql.';
  else
    status := 'ok'; detail := 'deal access is derived from the listing as well as the deal';
  end if;
  return next;

  -- ── The guard that makes the listing arms safe ────────────────────────────
  area := 'table policy'; item := 'properties write scope';
  select count(*) into n
    from pg_policies
   where schemaname = 'public' and tablename = 'properties'
     and permissive = 'PERMISSIVE' and cmd = 'ALL'
     and coalesce(qual, 'true') = 'true';
  if n > 0 then
    status := 'FAIL';
    detail := n || ' wide-open for-ALL policy/policies on properties: every signed-in agent can rewrite any listing in the firm, which with listing-derived deal access lets anyone grant themselves someone else''s deal. Run migrations/0055_deal_team_access.sql.';
  else
    status := 'ok'; detail := 'reads are firm-wide; writes require being on the listing';
  end if;
  return next;

  -- ── The cache the commission seed and signer prefill still read ───────────
  area := 'co-agent sync'; item := 'listing <-> deal triggers';
  select count(*) into n
    from pg_trigger
   where not tgisinternal
     and tgname in ('trg_property_coagents_to_deals', 'trg_deal_coagents_to_property');
  if n = 2 then
    status := 'ok'; detail := 'both directions installed';
  else
    status := 'FAIL';
    detail := n || ' of 2 sync triggers present. Without them the team a deal DISPLAYS can drift from the team it pays. Run migrations/0055_deal_team_access.sql.';
  end if;
  return next;

  -- ── Agents whose login may not resolve to their roster row ────────────────
  -- Reported, never repaired: an audit that rewrites identity at 3am is worse
  -- than one that tells a human. They now resolve by the email on their login,
  -- so this is a warning rather than the blackout it used to be.
  area := 'identity'; item := 'agents with no login link';
  select count(*) into n from agents where auth_id is null;
  if n = 0 then
    status := 'ok'; detail := 'every agent row is linked to a login';
  else
    status := 'warn';
    detail := n || ' agent row(s) have agents.auth_id = NULL. Since migration 0055 they resolve by the verified email on their login instead of seeing nothing — but only if that email matches the row exactly. Check them, and set auth_id by hand where it does not.';
  end if;
  return next;
end
$$;

grant execute on function app_access_audit() to authenticated, service_role;

commit;

-- ───────────────────────────────────────────────────────────────────────────
-- 9. THE REPORT — read these notices
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare r record; n int := 0;
begin
  raise notice '--- deals and who is on them ---';
  for r in
    select d.id, d.title,
           coalesce(array_length(d.co_agent_ids, 1), 0) as on_deal,
           coalesce(array_length(app_jsonb_uuid_array(p.details -> 'co_agent_ids'), 1), 0) as on_listing,
           (select count(*) from storage.objects o
             where o.bucket_id = 'deal-documents' and o.name like 'deal-' || d.id || '/%') as files
      from deals d left join properties p on p.id = d.property_id
     order by files desc nulls last, d.created_at desc
     limit 25
  loop
    raise notice '  % — % on deal, % on listing, % file(s)', r.title, r.on_deal, r.on_listing, r.files;
  end loop;

  raise notice '--- co-agent ids that are not real agent rows (a picker wrote a stale id) ---';
  for r in
    select distinct x as ghost
      from deals d cross join lateral unnest(coalesce(d.co_agent_ids, '{}')) x
     where not exists (select 1 from agents a where a.id = x)
     union
    select distinct x
      from properties p cross join lateral unnest(app_jsonb_uuid_array(p.details -> 'co_agent_ids')) x
     where not exists (select 1 from agents a where a.id = x)
  loop
    n := n + 1;
    raise notice '  % — listed on a deal or listing but no agents row exists', r.ghost;
  end loop;
  if n = 0 then raise notice '  none'; end if;

  raise notice '--- agents with no login link ---';
  n := 0;
  for r in select name, email from agents where auth_id is null order by name loop
    n := n + 1;
    raise notice '  % (%) — agents.auth_id is NULL. They now resolve by the email on their login instead of seeing nothing, PROVIDED that email matches this row exactly. If they sign in with a different address, set auth_id by hand.', r.name, r.email;
  end loop;
  if n = 0 then raise notice '  none — every agent row is linked'; end if;

  raise notice '--- duplicate roster rows (same email, more than one row) ---';
  n := 0;
  for r in
    select lower(email) as email, count(*) as rows from agents
     where email is not null and email <> '' group by 1 having count(*) > 1
  loop
    n := n + 1;
    raise notice '  % — % rows. Access now covers all of them; merge them when convenient.', r.email, r.rows;
  end loop;
  if n = 0 then raise notice '  none'; end if;
end $$;

-- ── Verification ───────────────────────────────────────────────────────────
-- As a given agent (run in the SQL editor with their JWT, or temporarily
-- impersonate by id) the two lists must match:
--
--   select count(*) from deals;                        -- what RLS lets them read
--   select count(*) from app_visible_deal_ids();       -- what the model grants
--
-- The property write guard, which is the one narrowing here:
--
--   select policyname, cmd, permissive from pg_policies
--    where tablename = 'properties' order by cmd;
--
-- And the sync, end to end — add an agent to a listing, then:
--
--   select d.title, d.co_agent_ids, p.details->'co_agent_ids'
--     from deals d join properties p on p.id = d.property_id
--    where p.id = '<the listing>';
