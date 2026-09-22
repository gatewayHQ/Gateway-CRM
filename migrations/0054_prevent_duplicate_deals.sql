-- Migration 0054 — One deal per property per side
-- ===========================================================================
-- THE BUG
--   Two agents each had a deal on 102 7th St. SE. Steph's carried 22 filled
--   terms, 3 documents and a task; Emma's was empty. Nothing "failed to
--   transfer" — they were two `deals` ROWS. Everything hangs off the deal id
--   (comp_data, `deal-<uuid>/` storage, key dates, tasks, commission,
--   signatures), so two rows are two parallel sets with nothing joining them.
--
-- HOW A SECOND ROW GETS CREATED
--   `Properties.jsx > startDeal()` is a bare insert. The "Start Deal" button
--   renders whenever the property exists and never asks whether the property
--   already has one. `agent_id` is whoever clicked. So:
--
--     Emma opens the property. Steph's deal is invisible to her — RLS only
--     shows deals you are on. The property looks untouched. She clicks
--     Start Deal. Now there are two, owned by different people.
--
--   The access model MANUFACTURES the duplicates: the rule that hides a
--   colleague's deal is what makes an agent create a second one.
--
-- WHY THE CHECK CANNOT LIVE IN THE BROWSER
--   `PropertyDrawer` already receives `deals` — but that is the RLS-SCOPED
--   list. Emma's browser never contained Steph's deal, so "does this property
--   have a deal?" answers false for her no matter how it is asked client-side.
--   Detection has to run with a view of all deals. Hence
--   `app_open_deal_on_property()` below: `security definer`, so it sees past
--   RLS for this one narrow question.
--
--   It is deliberately NOT an API route: api/ is at the Vercel Hobby cap of 12
--   functions, and this needs no secret anyway.
--
-- WHAT IT DISCLOSES, ON PURPOSE
--   The existence, address, stage and owning agent of a deal the caller cannot
--   otherwise see. That is the minimum required to say "Steph already has a
--   deal here" instead of silently making a second. It returns no value, no
--   commission, no contacts. Properties are already org-wide readable
--   (`allow_all_authenticated`) and the agent roster is already readable, so
--   this adds the fact of the deal and nothing else.
--
-- PER SIDE, NOT PER PROPERTY
--   Confirmed against live data: 375 S. Hayes Ave. has a buyer-side AND a
--   seller-side deal, both Steph's, both closed — legitimate business run as
--   two deals. A flat one-deal-per-property rule would have rejected it. Two
--   OPEN deals on the same property and the SAME side are the duplicates.
--
--   `coalesce(..., 'unknown')` is load-bearing. On the live data `side` is
--   absent on 6 of 10 duplicate rows, and Postgres treats NULLs as DISTINCT in
--   a unique index — so keying on the raw value would silently permit
--   unlimited duplicates on exactly the deals that lack the field.
-- ===========================================================================

begin;

-- ── 1. Whitespace, which hides duplicates from every report ────────────────
-- Live data carries '102 7th St. SE ', '375 S. Hayes Ave. ', 'Steph Dattolico '.
-- `Properties.jsx` validates with .trim() but SAVES the raw value, so
-- '102 7th St. SE' and '102 7th St. SE ' are two different property rows — and
-- duplicates split across them are invisible to any property-grouped report
-- and to the index below. Four deals matched '7th St'; only two shared a
-- property row. The app-side fix ships with this migration.
update properties set address = btrim(address) where address <> btrim(address);
update properties set unit    = btrim(unit)    where unit    is not null and unit    <> btrim(unit);
update properties set city    = btrim(city)    where city    is not null and city    <> btrim(city);
update deals      set title   = btrim(title)   where title   is not null and title   <> btrim(title);
update agents     set name    = btrim(name)    where name    <> btrim(name);
update contacts   set first_name = btrim(first_name) where first_name <> btrim(first_name);
update contacts   set last_name  = btrim(last_name)  where last_name  <> btrim(last_name);

-- ── 2. Does this property already have an open deal on this side? ──────────
-- Security definer: the whole point is to see a deal the caller cannot.
create or replace function app_open_deal_on_property(
  p_property_id uuid,
  p_side        text default null   -- null = any side
)
returns table (
  deal_id    uuid,
  title      text,
  stage      text,
  side       text,
  agent_id   uuid,
  agent_name text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select d.id, d.title, d.stage,
         coalesce(d.comp_data->>'transaction_type', 'unknown'),
         d.agent_id, a.name, d.created_at
    from deals d
    left join agents a on a.id = d.agent_id
   where d.property_id = p_property_id
     and d.stage not in ('closed', 'lost')
     and (p_side is null
          or coalesce(d.comp_data->>'transaction_type', 'unknown')
             = coalesce(nullif(btrim(p_side), ''), 'unknown'))
   order by d.created_at
$$;

grant execute on function app_open_deal_on_property(uuid, text) to authenticated;

-- ── 3. Ask the owner for access — never take it ────────────────────────────
-- An agent who finds a colleague's deal needs a way forward that is not "make
-- a second one". This notifies the owner; it grants NOTHING. A function that
-- let any agent add themselves to any deal would be a privilege escalation
-- dressed up as a convenience.
create or replace function app_request_deal_access(p_deal_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid; me_name text; owner_id uuid; d_title text;
begin
  me := app_current_agent_id();
  if me is null then return false; end if;

  select d.agent_id, d.title into owner_id, d_title from deals d where d.id = p_deal_id;
  if owner_id is null or owner_id = me then return false; end if;

  -- One pending ask per agent per deal. Clicking twice must not page someone
  -- twice, and a stuck request must not become a nightly reminder.
  if exists (
    select 1 from agent_notifications n
     where n.agent_id = owner_id and n.deal_id = p_deal_id
       and n.type = 'deal_access_request' and n.read = false
       and n.message like '%' || me::text || '%'
  ) then
    return true;
  end if;

  select a.name into me_name from agents a where a.id = me;

  insert into agent_notifications (agent_id, deal_id, title, message, type)
  values (
    owner_id,
    p_deal_id,
    coalesce(me_name, 'An agent') || ' wants access to ' || coalesce(d_title, 'a deal'),
    coalesce(me_name, 'An agent') || ' opened this property and found your deal instead of starting their own. '
      || 'Add them under Agents on deal if they are working it with you.  [' || me::text || ']',
    'deal_access_request'
  );
  return true;
end
$$;

grant execute on function app_request_deal_access(uuid) to authenticated;

-- ── 4. The backstop ────────────────────────────────────────────────────────
-- The UI check is what people see; this is what makes it true. Two agents
-- clicking at the same moment, an import, a hand-written insert — all land
-- here.
--
-- Wrapped because EXISTING duplicates make the index fail to build, and a
-- migration that aborts on data it was written to prevent helps nobody. If it
-- cannot be created the rows blocking it are named, and re-running this file
-- after they are resolved creates it.
do $$
declare r record; n int := 0;
begin
  if to_regclass('public.deals_one_open_per_property_side') is not null then
    raise notice 'Duplicate guard already in place.';
    return;
  end if;

  begin
    create unique index deals_one_open_per_property_side
      on deals (property_id, (coalesce(comp_data->>'transaction_type', 'unknown')))
      where property_id is not null and stage not in ('closed', 'lost');
    raise notice 'Duplicate guard created: one OPEN deal per property per side.';
  exception when others then
    raise notice 'Duplicate guard NOT created: %. The UI check in this release still', sqlerrm;
    raise notice 'prevents new duplicates; this index is the database-level backstop.';
    raise notice 'Resolve the rows below (close, mark lost, or merge) and re-run this file:';
    for r in
      select p.address, d.id, d.stage,
             coalesce(d.comp_data->>'transaction_type', 'unknown') as side,
             a.name as agent
        from deals d
        left join properties p on p.id = d.property_id
        left join agents a on a.id = d.agent_id
       where d.property_id is not null
         and d.stage not in ('closed', 'lost')
         and exists (
           select 1 from deals d2
            where d2.property_id = d.property_id
              and d2.id <> d.id
              and d2.stage not in ('closed', 'lost')
              and coalesce(d2.comp_data->>'transaction_type', 'unknown')
                  = coalesce(d.comp_data->>'transaction_type', 'unknown'))
       order by p.address, d.created_at
    loop
      n := n + 1;
      raise notice '  % | % | % | % | %', coalesce(r.address, '(no property)'), r.id, r.side, r.stage, r.agent;
    end loop;
    raise notice '  (% row(s))', n;
  end;
end $$;

commit;

-- ── Verification ───────────────────────────────────────────────────────────
-- select * from app_open_deal_on_property('<property uuid>');
-- select indexname from pg_indexes where indexname = 'deals_one_open_per_property_side';
-- select count(*) from properties where address <> btrim(address);   -- expect 0
