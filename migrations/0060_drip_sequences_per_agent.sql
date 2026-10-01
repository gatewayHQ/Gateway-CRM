-- ─────────────────────────────────────────────────────────────────────────────
-- 0060 — Drip sequences become each agent's own, and send from their Outlook.
--
-- WHAT WAS WRONG
--   • `sequences`, `sequence_steps` and `contact_sequences` carried the blanket
--     `allow_all ... using (true)` policy from 0003. Every agent saw, edited and
--     could delete every other agent's drip, and every enrollment in it.
--   • A sequence had no owner at all, so "whose drip is this" was unanswerable.
--   • The runner (api/cron.js ?task=sequence) sent through Resend from one
--     shared brokerage address, not from the agent the lead belongs to.
--   • The runner wrote `contact_sequences.last_sent_at`, a column no migration
--     ever created. PostgREST rejects the whole UPDATE on an unknown column, so
--     on a database built from these files `current_step` never advanced after
--     a send — the same step was due again on the next run.
--   • Auto-enroll for website leads was ONE sequence per lane for the whole
--     office. It is now one per lane PER AGENT: a round-robin lead starts the
--     drip of the agent it was assigned to.
--
-- WHAT THIS ADDS
--   sequences.agent_id                 the owner; RLS keys off it
--   sequence_steps.step_type           'email' | 'call' (a call step creates a task)
--   contact_sequences.last_sent_at     the column the runner already wrote
--   contact_sequences.last_error       why the last attempt did not send
--   contact_sequences.stopped_reason   why an enrollment ended early
--   contact_sequences.lead_id          the website lead that started it
--   contacts.search_*                  home-search criteria for personalization
--   leads.search_criteria              what the website posted, as received
--
-- Idempotent. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Ownership ────────────────────────────────────────────────────────────────
alter table sequences add column if not exists agent_id uuid references agents(id) on delete cascade;
alter table sequences add column if not exists updated_at timestamptz default now();
create index if not exists idx_sequences_agent on sequences(agent_id);

-- Backfill an owner for sequences that already exist: the agent who enrolled
-- the most contacts into it. A sequence nobody ever enrolled anyone into keeps
-- a null owner — it is then visible to office admins only, who can claim or
-- delete it from the Drip Sequences page.
update sequences s
   set agent_id = x.agent_id
  from (
    select distinct on (sequence_id) sequence_id, agent_id
      from contact_sequences
     where agent_id is not null
     group by sequence_id, agent_id
     order by sequence_id, count(*) desc, agent_id
  ) x
 where s.id = x.sequence_id
   and s.agent_id is null;

-- ── Auto-enroll: one sequence per lane PER AGENT ─────────────────────────────
drop index if exists idx_sequences_auto_enroll_lane;
create unique index if not exists idx_sequences_agent_auto_enroll
  on sequences(agent_id, auto_enroll_lane) where auto_enroll_lane is not null;

-- ── Steps: email or phone call ───────────────────────────────────────────────
alter table sequence_steps add column if not exists step_type text not null default 'email';
alter table sequence_steps drop constraint if exists sequence_steps_step_type_check;
alter table sequence_steps add  constraint sequence_steps_step_type_check
  check (step_type in ('email', 'call'));

-- ── Enrollments ──────────────────────────────────────────────────────────────
alter table contact_sequences add column if not exists last_sent_at   timestamptz;
alter table contact_sequences add column if not exists last_error     text;
alter table contact_sequences add column if not exists stopped_reason text;
alter table contact_sequences add column if not exists lead_id        uuid references leads(id) on delete set null;

-- 'replied'  — the contact wrote back; the agent takes it from here
-- 'stopped'  — opted out, bounced, no email address, or ended by hand
update contact_sequences
   set status = 'paused'
 where status is null
    or status not in ('active', 'paused', 'completed', 'replied', 'stopped');
alter table contact_sequences drop constraint if exists contact_sequences_status_check;
alter table contact_sequences add  constraint contact_sequences_status_check
  check (status in ('active', 'paused', 'completed', 'replied', 'stopped'));

-- One live enrollment per contact per sequence. Enrolling someone twice emails
-- them every step twice. Existing duplicates are stopped (the oldest survives),
-- never deleted.
update contact_sequences cs
   set status = 'stopped', stopped_reason = 'Duplicate enrollment'
  from (
    select id, row_number() over (partition by contact_id, sequence_id order by started_at, id) as rn
      from contact_sequences
     where status in ('active', 'paused')
  ) d
 where cs.id = d.id and d.rn > 1;
create unique index if not exists idx_contact_seq_one_live
  on contact_sequences(contact_id, sequence_id) where status in ('active', 'paused');
create index if not exists idx_contact_seq_sequence on contact_sequences(sequence_id);

-- ── Home-search criteria (personalizes the drip) ─────────────────────────────
-- The area a buyer is searching reuses contacts.submarket.
alter table contacts add column if not exists search_beds_min  integer;
alter table contacts add column if not exists search_baths_min numeric;
alter table contacts add column if not exists search_price_min numeric;
alter table contacts add column if not exists search_price_max numeric;

alter table leads add column if not exists search_criteria jsonb not null default '{}'::jsonb;

-- ── RLS: a sequence is its owner's alone ─────────────────────────────────────
-- Every existing policy on these tables is dropped by NAME LOOKUP, not by a
-- guessed name: the in-app "run this SQL" panel created `auth_all_sequences` /
-- `auth_all_seq_steps` / `auth_all_cs`, 0003 created `allow_all`, and a
-- permissive leftover of either would OR itself onto the new rule and keep
-- everything visible.
do $$
declare p record;
begin
  for p in
    select policyname, tablename from pg_policies
     where schemaname = 'public'
       and tablename in ('sequences', 'sequence_steps', 'contact_sequences', 'email_log')
  loop
    execute format('drop policy if exists %I on %I', p.policyname, p.tablename);
  end loop;
end $$;

alter table sequences         enable row level security;
alter table sequence_steps    enable row level security;
alter table contact_sequences enable row level security;
alter table email_log         enable row level security;

-- Read: the owner. An ownerless (pre-0060) sequence: office admins, to claim it.
-- Write: the owner only — including an admin claiming one, which sets agent_id
-- to themselves and so passes `with check`.
create policy sequences_owner on sequences for all to authenticated
  using (
    agent_id in (select app_my_agent_ids())
    or (agent_id is null and app_is_admin())
  )
  with check (agent_id in (select app_my_agent_ids()));

create policy sequence_steps_owner on sequence_steps for all to authenticated
  using (exists (
    select 1 from sequences s
     where s.id = sequence_steps.sequence_id
       and (s.agent_id in (select app_my_agent_ids()) or (s.agent_id is null and app_is_admin()))
  ))
  with check (exists (
    select 1 from sequences s
     where s.id = sequence_steps.sequence_id
       and s.agent_id in (select app_my_agent_ids())
  ));

-- Enrolling needs the sequence to be yours AND the contact to be one you can
-- see (the contacts subquery runs under contacts' own RLS).
create policy contact_sequences_owner on contact_sequences for all to authenticated
  using (exists (
    select 1 from sequences s
     where s.id = contact_sequences.sequence_id
       and (s.agent_id in (select app_my_agent_ids()) or (s.agent_id is null and app_is_admin()))
  ))
  with check (
    exists (
      select 1 from sequences s
       where s.id = contact_sequences.sequence_id
         and s.agent_id in (select app_my_agent_ids())
    )
    and exists (select 1 from contacts c where c.id = contact_sequences.contact_id)
  );

-- The drip send log: the sending agent's, or an admin's. Written only by the
-- server (service role), so there is no insert path for a client here.
create policy email_log_owner on email_log for select to authenticated
  using (agent_id in (select app_my_agent_ids()) or app_is_admin());
