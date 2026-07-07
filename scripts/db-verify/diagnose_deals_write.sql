-- Diagnose why deal creation is failing. READ-ONLY — safe to run in the
-- Supabase SQL Editor. Run each numbered query and share the output.
--
-- Interpreting the results:
--   1. deals policies — you want a row with cmd = ALL (or INSERT) whose
--      with_check is non-empty. If the only rows are SELECT (with_check NULL),
--      the insert path was dropped → EVERY agent fails. (migration 0016 fixes)
--   2. app_is_admin body — must read `is_admin or role ilike '%admin%'`. If it
--      only checks role, flagged admins with a non-admin role are denied.
--   3. agent linkage — `linked = false` for an agent means their login is not
--      tied to their agent row (app_current_agent_id() is null for them), so
--      even a self-owned insert fails. That is a DATA fix, not a policy one.

-- 1. Policies currently on deals
select polname as policy,
       case polcmd when 'r' then 'SELECT' when 'a' then 'INSERT'
                   when 'w' then 'UPDATE' when 'd' then 'DELETE'
                   when '*' then 'ALL' end as cmd,
       polpermissive as permissive,
       pg_get_expr(polqual, polrelid)      as using_expr,
       pg_get_expr(polwithcheck, polrelid) as with_check
from pg_policy where polrelid = 'deals'::regclass
order by polname;

-- 2. Definitions of the RLS helper functions
select proname as function, pg_get_functiondef(oid) as definition
from pg_proc
where proname in ('app_is_admin','app_current_agent_id',
                  'app_visible_agent_ids','app_visible_deal_ids')
order by proname;

-- 3. Is each agent's login linked, and are they seen as admin?
select a.name, a.email, a.role, a.is_admin,
       (a.auth_id is not null) as linked,
       (a.is_admin or a.role ilike '%admin%') as should_be_admin
from agents a
order by a.name;

-- 4. Is RLS actually enabled on deals? (rls_enabled should be true)
select relname as table, relrowsecurity as rls_enabled, relforcerowsecurity as rls_forced
from pg_class where relname = 'deals';
