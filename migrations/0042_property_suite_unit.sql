-- ─────────────────────────────────────────────────────────────────────────────
-- 0042 — properties.unit (suite / unit number)
--
-- A space for lease inside a strip mall, an office building or a flex park is
-- not the whole building. Until now `properties.address` was the only street
-- field, so agents folded the suite into it by hand ("2212 Okoboji Ave Ste
-- 120") or left it out entirely. Either way the suite was invisible: global
-- search couldn't match it, the geocoder was fed a string it can't resolve,
-- and every document token, landing page and announcement printed the building
-- rather than the space.
--
-- `unit` holds it on its own — 'Suite 120', '#4', 'Bldg C'. It is a free-text
-- label, not a number, because that is what signage and leases actually read;
-- the app normalizes a bare "120" to "Suite 120" on save (src/lib/address.js).
--
-- Everything that renders an address composes it as `address, unit` through
-- src/lib/address.js. Geocoding deliberately does NOT include the suite —
-- geocoders resolve buildings, not the spaces inside them.
--
-- Additive and idempotent: existing rows keep a null unit and read exactly as
-- they did before. Nothing is back-filled — a suite already typed into
-- `address` stays there and keeps working; agents can split it out by editing
-- the listing.
-- ─────────────────────────────────────────────────────────────────────────────
alter table properties add column if not exists unit text;

comment on column properties.unit is
  'Suite / unit / space identifier within the building at `address`, as written on the lease or signage (''Suite 120'', ''#4'', ''Bldg C''). Composed for display as "address, unit"; deliberately excluded from geocoding queries. See src/lib/address.js.';

-- Global search: the suite is part of how an agent looks a listing up ("okoboji
-- 120"), so search_properties has to see it. Same signature and ordering as
-- before — only the WHERE clause grows.
create or replace function search_properties(search_term text, agent_ids uuid[], result_limit int default 50)
returns setof properties
language sql stable
as $$
  select * from properties
  where assigned_agent_id = any(agent_ids)
    and (
      lower(address) like '%' || lower(search_term) || '%'
      or lower(coalesce(unit, '')) like '%' || lower(search_term) || '%'
      or lower(coalesce(address, '') || ' ' || coalesce(unit, '')) like '%' || lower(search_term) || '%'
      or lower(city)  like '%' || lower(search_term) || '%'
      or lower(mls_number) like '%' || lower(search_term) || '%'
    )
  order by created_at desc
  limit result_limit;
$$;
