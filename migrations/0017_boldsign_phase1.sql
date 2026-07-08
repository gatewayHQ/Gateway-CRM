-- ─────────────────────────────────────────────────────────────────────────────
-- 0017 — BoldSign Phase 1: sender identities + templates
--
-- Adds the two tables the template/prefill workflow stands on:
--   • boldsign_sender_identities — per-agent "send on behalf of" delegation, so
--     each agent's signature requests come from them. Approval is out-of-band
--     (agent clicks an emailed BoldSign link); we track Pending → Approved.
--   • boldsign_templates — reusable documents with fields placed in BoldSign;
--     field_tokens records the field id/label set so the CRM can prefill values.
--
-- Idempotent. Depends on the app_* deal-scope helpers already live in prod.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists boldsign_sender_identities (
  id          uuid primary key default uuid_generate_v4(),
  agent_id    uuid references agents(id) on delete cascade not null,
  email       text not null,
  name        text,
  status      text default 'pending' check (status in ('pending','approved','declined')),
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);
create unique index if not exists uq_boldsign_identity_agent on boldsign_sender_identities(agent_id);
create index if not exists idx_boldsign_identity_email on boldsign_sender_identities(email);

alter table boldsign_sender_identities enable row level security;
drop policy if exists boldsign_sender_identities_scope on boldsign_sender_identities;
create policy boldsign_sender_identities_scope on boldsign_sender_identities for all to authenticated
  using      (app_is_admin() or agent_id = app_current_agent_id())
  with check (app_is_admin());

create table if not exists boldsign_templates (
  id           uuid primary key default uuid_generate_v4(),
  template_id  text not null,
  name         text not null,
  doc_type     text,
  description  text,
  field_tokens jsonb default '[]',
  active       boolean default true,
  created_by   uuid references agents(id) on delete set null,
  created_at   timestamptz default now()
);
create unique index if not exists uq_boldsign_template_tid on boldsign_templates(template_id);
create index if not exists idx_boldsign_templates_active on boldsign_templates(active) where active;

alter table boldsign_templates enable row level security;
drop policy if exists boldsign_templates_scope on boldsign_templates;
create policy boldsign_templates_scope on boldsign_templates for all to authenticated
  using      (true)
  with check (app_is_admin());
