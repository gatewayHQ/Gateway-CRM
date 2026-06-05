-- Goal 1: State-based document checklist
-- Adds doc_action, doc_status, if_applicable to transaction_steps
alter table transaction_steps
  add column if not exists doc_action    text    default 'manual',
  add column if not exists doc_status    text    default 'pending',
  add column if not exists if_applicable boolean default false;

comment on column transaction_steps.doc_action    is 'manual | upload | forms | sign | admin';
comment on column transaction_steps.doc_status    is 'pending | complete | approved | na';
comment on column transaction_steps.if_applicable is 'True when this document is conditional (if applicable)';

-- Goal 2: Per-agent sidebar visibility preferences
-- nav_hidden stores the list of nav item IDs the agent has chosen to hide
alter table agents
  add column if not exists nav_hidden text[] default '{}';

comment on column agents.nav_hidden is 'Array of nav item IDs hidden from this agent''s sidebar';
