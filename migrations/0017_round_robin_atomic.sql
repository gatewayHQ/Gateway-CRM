-- ─────────────────────────────────────────────────────────────────────────────
-- 0017 — Atomic round-robin agent picker
--
-- The old picker (read "latest lead_captures" → pick next) had a race: two
-- inbound leads arriving in the same window could both observe the same
-- "last" row and pin to the same agent. Throughput is low today but the
-- failure mode shows up as duplicate-assigned leads, which is exactly the
-- thing the rotation is supposed to prevent.
--
-- This migration adds a SECURITY DEFINER function that:
--   1. Takes a transaction-scoped advisory lock (only one picker runs at once)
--   2. Picks the next non-admin agent by specialty
--   3. Falls back to the other specialty, then any non-admin
--   4. Returns the chosen agent id
-- The endpoint (api/property-public.js) calls this via PostgREST RPC instead
-- of doing the dance in JS.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function pick_round_robin_agent(p_property_type text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_specialty    text;
  v_alt          text;
  v_agent_id     uuid;
begin
  -- Serialize picks across concurrent invocations. The integer is arbitrary
  -- but constant — it scopes the lock to "the round-robin picker."
  perform pg_advisory_xact_lock(742317);

  v_specialty := case when p_property_type = 'commercial' then 'commercial' else 'residential' end;
  v_alt       := case when v_specialty = 'residential' then 'commercial' else 'residential' end;

  -- Try the matching specialty first, then the other, then any non-admin.
  v_agent_id := next_agent_in_pool(v_specialty);
  if v_agent_id is null then v_agent_id := next_agent_in_pool(v_alt); end if;
  if v_agent_id is null then v_agent_id := next_agent_in_pool(null);  end if;

  return v_agent_id;
end;
$$;

create or replace function next_agent_in_pool(p_specialty text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agents       uuid[];
  v_last_agent   uuid;
  v_idx          int;
begin
  -- Build the pool: non-admin agents matching the specialty filter (or all
  -- non-admins when p_specialty is null), ordered by name for a stable cycle.
  select array_agg(id order by name)
    into v_agents
    from agents
   where coalesce(is_admin, false) = false
     and (p_specialty is null or specialty = p_specialty);

  if v_agents is null or cardinality(v_agents) = 0 then
    return null;
  end if;
  if cardinality(v_agents) = 1 then
    return v_agents[1];
  end if;

  -- Find the most recently assigned agent in this pool.
  select agent_id
    into v_last_agent
    from lead_captures
   where agent_id = any(v_agents)
   order by created_at desc
   limit 1;

  if v_last_agent is null then
    return v_agents[1];
  end if;

  v_idx := array_position(v_agents, v_last_agent);
  if v_idx is null then
    return v_agents[1];
  end if;

  return v_agents[(v_idx % cardinality(v_agents)) + 1];
end;
$$;

-- Allow the anon and authenticated roles to invoke. SECURITY DEFINER means
-- the function body still runs with the owner's permissions, so RLS on
-- agents / lead_captures is bypassed inside — which is what we want, since
-- the public lead endpoint is called before any auth is in scope.
grant execute on function pick_round_robin_agent(text) to anon, authenticated, service_role;
grant execute on function next_agent_in_pool(text)     to anon, authenticated, service_role;
