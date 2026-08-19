-- ─────────────────────────────────────────────────────────────────────────────
-- 0034 — Microsoft Graph (Outlook) integration
--
-- Per-agent "Connect Outlook" via OAuth 2.0 Authorization Code + PKCE against
-- an Azure App Registration with DELEGATED Graph permissions (User.Read,
-- Mail.Send, Mail.ReadWrite, Mail.ReadBasic, offline_access, Calendars.Read,
-- Calendars.ReadWrite, Contacts.Read — admin consent not required). Full scope
-- set is requested at connect time so calendar/contacts sync can be built later
-- without forcing every agent to reconnect.
--
-- Three tables:
--   • ms_graph_connections — one row per agent, holds the encrypted
--     access/refresh token pair. Locked to the SERVICE ROLE ONLY (no policy
--     for `authenticated`/`anon` at all) — even AES-256-GCM ciphertext should
--     never reach the browser. All reads/writes go through api/email-send.js
--     (?action=outlook-*), which uses the service key. Non-secret status is
--     exposed to the owning agent via the ms_graph_connection_status view below.
--   • ms_oauth_states — short-lived PKCE state, keyed by the `state` param.
--     Also service-role only: this is where the code_verifier lives between
--     the redirect to Microsoft and the callback, and it identifies WHICH
--     agent initiated the flow (a GET redirect from Microsoft carries no
--     Authorization header, so this row is the only way to resolve identity
--     in the callback). One-time use; the callback deletes it immediately.
--   • email_messages — the CRM's own record of every email sent through the
--     integration, linked to contacts/deals. RLS mirrors the existing
--     `activities_scope` policy (own + team-shared contact + visible deal;
--     admins see all) so the Outlook feature respects the same per-agent
--     visibility model as the rest of the CRM. A companion `activities` row
--     (type='email') is inserted by the send handler so sent emails show up
--     in the existing contact/deal timeline for free.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── ms_graph_connections ──────────────────────────────────────────────────────
create table if not exists ms_graph_connections (
  id                 uuid primary key default uuid_generate_v4(),
  agent_id           uuid not null unique references agents(id) on delete cascade,
  microsoft_user_id  text not null,
  email              text not null,
  display_name       text,
  -- AES-256-GCM ciphertext (iv || authTag || ciphertext, base64) — see
  -- api/_lib/msGraph.js. Never selected by a client role; service key only.
  access_token_enc   text not null,
  refresh_token_enc  text not null,
  token_expires_at   timestamptz not null,
  scopes             text[] not null default '{}',
  status             text not null default 'connected'
                       constraint ms_graph_connections_status_check
                       check (status in ('connected', 'disconnected', 'error')),
  last_error         text,
  connected_at       timestamptz not null default now(),
  last_synced_at     timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create unique index if not exists uq_ms_graph_connections_ms_user
  on ms_graph_connections(microsoft_user_id);
create index if not exists idx_ms_graph_connections_agent
  on ms_graph_connections(agent_id);

alter table ms_graph_connections enable row level security;
-- Deliberately NO policy for `authenticated`/`anon` — deny by default. Every
-- access is server-side via the service key (see api/email-send.js). Fresh
-- installs and re-runs alike land here with zero client-reachable policies.

drop trigger if exists ms_graph_connections_updated_at on ms_graph_connections;
create trigger ms_graph_connections_updated_at
  before update on ms_graph_connections
  for each row execute function set_updated_at();

-- Non-secret connection status, readable by the owning agent (or an office
-- admin) directly from the browser — so "Connection status UI" doesn't need a
-- round trip through an API route. Excludes every token column. NOT
-- security_invoker: like `agents_public`, the view runs with the owner's
-- (superuser) privileges, which bypass ms_graph_connections' policy-less RLS —
-- so the row filter below is load-bearing, not decorative.
create or replace view ms_graph_connection_status as
  select
    agent_id, microsoft_user_id, email, display_name, status,
    scopes, connected_at, last_synced_at, token_expires_at, last_error
  from ms_graph_connections
  where agent_id = app_current_agent_id() or app_is_admin();
grant select on ms_graph_connection_status to authenticated;

-- ── ms_oauth_states ───────────────────────────────────────────────────────────
create table if not exists ms_oauth_states (
  state          text primary key,
  agent_id       uuid not null references agents(id) on delete cascade,
  code_verifier  text not null,
  redirect_uri   text not null,        -- the Azure-registered callback URL used for this attempt
  return_path    text,                 -- where to send the browser back to in the SPA when done
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null default (now() + interval '10 minutes')
);
create index if not exists idx_ms_oauth_states_expires on ms_oauth_states(expires_at);

alter table ms_oauth_states enable row level security;
-- Service-role only — a PKCE verifier must never be readable by any client.

-- ── email_messages ────────────────────────────────────────────────────────────
create table if not exists email_messages (
  id                 uuid primary key default uuid_generate_v4(),
  agent_id           uuid references agents(id) on delete set null,
  contact_id         uuid references contacts(id) on delete set null,
  deal_id            uuid references deals(id) on delete set null,
  -- The companion timeline row this send also created (src/pages/Contacts/ActivityTab.jsx,
  -- DealPage.jsx already render `activities`) — null for a row that predates
  -- that link or whose activity insert failed after the email itself sent.
  activity_id        uuid references activities(id) on delete set null,
  direction          text not null default 'outbound'
                       constraint email_messages_direction_check
                       check (direction in ('outbound', 'inbound')),
  subject            text,
  body_preview       text,             -- plain-text snippet for list views
  body_html          text,
  to_recipients      jsonb not null default '[]',   -- [{name,email}]
  cc_recipients      jsonb not null default '[]',
  status             text not null default 'sent'
                       constraint email_messages_status_check
                       check (status in ('sent', 'failed', 'draft')),
  error_message      text,
  graph_message_id   text,             -- Graph message id, when captured (future: delta sync)
  conversation_id    text,             -- Graph conversationId — future: thread view
  sent_at            timestamptz default now(),
  created_at         timestamptz default now()
);
create index if not exists idx_email_messages_agent   on email_messages(agent_id, sent_at desc);
create index if not exists idx_email_messages_contact on email_messages(contact_id, sent_at desc);
create index if not exists idx_email_messages_deal    on email_messages(deal_id, sent_at desc);
create unique index if not exists uq_email_messages_graph_id
  on email_messages(graph_message_id) where graph_message_id is not null;

alter table email_messages enable row level security;

-- EMAIL MESSAGES — same visibility shape as ACTIVITIES (own + team-shared
-- contact + visible deal; admins see all), since every send also lands a
-- companion activities row and the two should never diverge on who can see them.
drop policy if exists email_messages_scope on email_messages;
create policy email_messages_scope on email_messages for all to authenticated
  using (
    app_is_admin()
    or agent_id = app_current_agent_id()
    or exists (
      select 1 from contacts c
      where c.id = email_messages.contact_id
        and c.assigned_agent_id in (select app_visible_agent_ids('contacts'))
    )
    or email_messages.deal_id in (select app_visible_deal_ids())
  )
  with check (
    app_is_admin()
    or agent_id = app_current_agent_id()
    or exists (
      select 1 from contacts c
      where c.id = email_messages.contact_id
        and c.assigned_agent_id in (select app_visible_agent_ids('contacts'))
    )
    or email_messages.deal_id in (select app_visible_deal_ids())
  );
