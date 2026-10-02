-- Migration 0062 — Agent workflow fixes (Agent Experience Audit, Oct 2026)
-- ===========================================================================
-- Five independent fixes, each safe to re-run.
--
--   1. CONTACT HANDOFF. An agent may assign a contact they can see to ANY agent
--      in the firm — a lead handed to the colleague who covers that market.
--      Until now the database refused it unless the receiving agent was on the
--      sender's team with contact sharing on. USING (who can see / change a row)
--      is unchanged, so an agent can only hand off a contact they can already
--      see; WITH CHECK (what the row may say afterwards) gains one arm: the new
--      owner is a real agent. The sender usually loses sight of the contact
--      once it's handed off, so the app saves a handoff without reading the row
--      back (INSERT/UPDATE ... RETURNING would be refused by USING).
--
--   2. LAST CONTACTED. contacts.last_contacted_at was read by the Contacts
--      table, the "Untouched 30+ days" view and the heat score, but nothing
--      ever wrote it. A trigger now stamps it whenever a call, email, meeting
--      or showing is logged against the contact (a note is not contact), and a
--      one-time backfill fills it from the activity already on file.
--
--   3. FIRM-WIDE INTEGRATIONS ARE ADMIN-ONLY. `integrations` and
--      `webhook_configs` were writable — and `integrations` readable — by every
--      signed-in user, which exposed the firm's Mailchimp API key. Mailchimp is
--      removed from the app; its stored config is deleted here. Webhooks stay
--      readable by every agent (the browser fires them on deal and contact
--      events) but only an admin may add, change or delete one.
--
--   4. PHONE SEARCH. Phones are stored as +1XXXXXXXXXX, so searching the way
--      people type a number ("515-555", "(515) 555") found nothing.
--      search_contacts now also compares digits only.
--
--   5. LEAD NOTIFICATIONS OPEN THE LEAD. agent_notifications gains contact_id,
--      so the bell's "New website lead" item opens that contact (deal
--      reminders already carry deal_id).
-- ===========================================================================

-- ── 1. Contact handoff ──────────────────────────────────────────────────────
drop policy if exists contacts_agent_scope on contacts;
create policy contacts_agent_scope on contacts for all to authenticated
  using (
    app_is_admin()
    or assigned_agent_id in (select app_visible_agent_ids('contacts'))
    or id in (select app_visible_contact_ids())
  )
  with check (
    app_is_admin()
    or assigned_agent_id in (select app_visible_agent_ids('contacts'))
    or id in (select app_visible_contact_ids())
    -- Handoff: the new owner is a real agent. Only reachable for a row the
    -- caller could already see (USING), or a row they are creating.
    or assigned_agent_id in (select id from agents)
  );

-- ── 2. Last contacted ───────────────────────────────────────────────────────
create or replace function activities_stamp_last_contacted()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.contact_id is not null and new.type in ('call', 'email', 'meeting', 'showing') then
    update contacts
       set last_contacted_at = greatest(coalesce(last_contacted_at, new.created_at), new.created_at)
     where id = new.contact_id;
  end if;
  return new;
end $$;

drop trigger if exists activities_stamp_last_contacted_trg on activities;
create trigger activities_stamp_last_contacted_trg
  after insert on activities
  for each row execute function activities_stamp_last_contacted();

update contacts c
   set last_contacted_at = a.last_at
  from (
    select contact_id, max(created_at) as last_at
      from activities
     where contact_id is not null and type in ('call', 'email', 'meeting', 'showing')
     group by contact_id
  ) a
 where a.contact_id = c.id
   and (c.last_contacted_at is null or c.last_contacted_at < a.last_at);

-- ── 3. Integrations are admin-only ──────────────────────────────────────────
delete from integrations where type = 'mailchimp';

drop policy if exists allow_all on integrations;
drop policy if exists integrations_admin_only on integrations;
create policy integrations_admin_only on integrations for all to authenticated
  using (app_is_admin()) with check (app_is_admin());

drop policy if exists allow_all on webhook_configs;
drop policy if exists webhook_configs_read on webhook_configs;
drop policy if exists webhook_configs_admin_write on webhook_configs;
create policy webhook_configs_read on webhook_configs for select to authenticated using (true);
create policy webhook_configs_admin_write on webhook_configs for all to authenticated
  using (app_is_admin()) with check (app_is_admin());

-- ── 4. Phone search by digits ───────────────────────────────────────────────
create or replace function search_contacts(search_term text, agent_ids uuid[], result_limit int default 50)
returns setof contacts
language sql stable
as $$
  select * from contacts
  where assigned_agent_id = any(agent_ids)
    and (
      to_tsvector('english', first_name || ' ' || last_name) @@ plainto_tsquery('english', search_term)
      or lower(email)   like '%' || lower(search_term) || '%'
      or lower(phone)   like '%' || lower(search_term) || '%'
      -- "515-555" or "(515) 555": compare digits only, once there are enough
      -- of them to mean a phone number rather than part of an address.
      or (length(regexp_replace(search_term, '\D', '', 'g')) >= 3
          and regexp_replace(coalesce(phone, ''), '\D', '', 'g') like '%' || regexp_replace(search_term, '\D', '', 'g') || '%')
      or lower(owner_city) like '%' || lower(search_term) || '%'
    )
  order by created_at desc
  limit result_limit;
$$;

-- ── 5. Lead notifications open the lead ─────────────────────────────────────
alter table agent_notifications
  add column if not exists contact_id uuid references contacts(id) on delete set null;
