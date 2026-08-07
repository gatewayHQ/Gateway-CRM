-- ─────────────────────────────────────────────────────────────────────────────
-- 0029 — Make every foreign key that points AT a deal clear itself on delete
--
-- PROBLEM
-- Deleting a deal from the pipeline failed with:
--
--     update or delete on table "deals" violates foreign key constraint
--     "tasks_deal_id_fkey" on table "tasks"
--
-- `tasks.deal_id` is declared `on delete set null` in src/lib/schema.sql, but the
-- live database predates that file and its constraint was created with the
-- default NO ACTION — so a deal with any task attached simply could not be
-- deleted. The app worked around it by nulling `tasks.deal_id` first, and that
-- workaround is why the failure looked random: tasks are STRICTLY PERSONAL under
-- RLS (`tasks_agent_scope`, using/with check `agent_id = app_current_agent_id()`),
-- so the update reached only the caller's own tasks. Delete a solo deal and it
-- worked; delete one a co-agent had a task on and their invisible row blocked it,
-- with a raw Postgres string for an error message.
--
-- FIX
-- Give each referencing constraint the `on delete` action schema.sql already
-- specifies, so the DATABASE clears the links — foreign key actions run as the
-- system and are not filtered by RLS, which is exactly the property the
-- application-side workaround could never have.
--
-- WHY THE WHOLE LIST, NOT JUST tasks
-- Every table below has the same shape of drift risk, and each one of them would
-- present as the identical un-deletable-deal bug. Fixing them one report at a
-- time is how this took three months to surface once.
--
-- SAFETY
--   • A constraint that is ALREADY correct is left completely untouched (the DO
--     block compares confdeltype first), so re-running this file is a no-op.
--   • Nothing is deleted or nulled by this migration itself — it only changes
--     what happens the NEXT time a deal is deleted.
--   • `set null` vs `cascade` mirrors src/lib/schema.sql exactly: a task or an
--     activity outlives its deal (it is the agent's own record and still means
--     something without one); a commission, a document or a transaction step
--     does not (it is meaningless once its deal is gone).
--
-- Apply: Supabase Dashboard → SQL Editor. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
declare
  con  record;
  -- table, column, intended on-delete action. Mirrors src/lib/schema.sql.
  specs constant text[][] := array[
    ['tasks',               'deal_id', 'set null'],
    ['activities',          'deal_id', 'set null'],
    ['agent_notifications', 'deal_id', 'set null'],
    ['deal_contacts',       'deal_id', 'cascade'],
    ['documents',           'deal_id', 'cascade'],
    ['commissions',         'deal_id', 'cascade'],
    ['boldsign_documents',  'deal_id', 'cascade'],
    ['deal_field_layouts',  'deal_id', 'cascade'],
    ['transaction_steps',   'deal_id', 'cascade'],
    ['audit_log',           'deal_id', 'cascade'],
    ['document_versions',   'deal_id', 'cascade'],
    ['closing_packets',     'deal_id', 'cascade'],
    ['agent_nudges',        'deal_id', 'cascade'],
    ['deadline_reminders',  'deal_id', 'cascade']
  ];
  want char;
begin
  for i in 1 .. array_length(specs, 1) loop
    -- Skip tables this database doesn't have (feature not deployed here yet).
    if to_regclass(format('public.%I', specs[i][1])) is null then
      raise notice 'skip %: table not present', specs[i][1];
      continue;
    end if;

    want := case specs[i][3] when 'cascade' then 'c' else 'n' end;

    for con in
      select c.conname, c.confdeltype
      from   pg_constraint c
      join   pg_attribute  a
             on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
      where  c.contype  = 'f'
        and  c.conrelid = to_regclass(format('public.%I', specs[i][1]))
        and  c.confrelid = to_regclass('public.deals')
        and  a.attname  = specs[i][2]
        and  array_length(c.conkey, 1) = 1
    loop
      if con.confdeltype = want then
        continue;                                   -- already correct
      end if;

      execute format('alter table public.%I drop constraint %I', specs[i][1], con.conname);
      execute format(
        'alter table public.%I add constraint %I foreign key (%I) references public.deals(id) on delete %s',
        specs[i][1], con.conname, specs[i][2], specs[i][3]
      );
      raise notice 'fixed %.% (% → on delete %)', specs[i][1], specs[i][2], con.confdeltype, specs[i][3];
    end loop;
  end loop;
end $$;

-- ── Verify (run after; every row should read 'ok') ───────────────────────────
-- select rel.relname                          as referencing_table,
--        att.attname                          as column,
--        con.confdeltype                      as on_delete,
--        case when con.confdeltype in ('c','n') then 'ok' else 'STILL NO ACTION' end as state
-- from   pg_constraint con
-- join   pg_class      rel on rel.oid = con.conrelid
-- join   pg_attribute  att on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
-- where  con.contype = 'f'
--   and  con.confrelid = 'public.deals'::regclass
-- order  by 1;
