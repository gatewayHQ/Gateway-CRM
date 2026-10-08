-- ─────────────────────────────────────────────────────────────────────────────
-- 0064 — NDA before the Deal Room
--
-- An agent can attach a Confidentiality Agreement (NDA) to a QR landing page.
-- When one is attached, registering still captures the lead and alerts the
-- agent, but the OM, the full photo set, the underwriting numbers and every
-- Deal Room document stay locked until the visitor has signed it on the page.
--
-- The signature is a click-through e-signature (typed name + "I agree"). What
-- makes it evidence is recorded here: who, when, from which IP and browser,
-- and the SHA-256 of the exact NDA file they agreed to — plus a signed copy
-- (the NDA with a signature certificate page appended) in the private
-- `campaign-oms` bucket.
--
-- Additive and idempotent. A campaign with no NDA attached behaves exactly as
-- before. A campaign WITH an NDA needs this migration: without these columns
-- nobody can sign, so the room stays locked (fails closed).
-- ─────────────────────────────────────────────────────────────────────────────

alter table mailing_om_requests add column if not exists nda_signed_at        timestamptz;
alter table mailing_om_requests add column if not exists nda_signer_name      text;
alter table mailing_om_requests add column if not exists nda_signer_company   text;
alter table mailing_om_requests add column if not exists nda_ip               text;
alter table mailing_om_requests add column if not exists nda_user_agent       text;
alter table mailing_om_requests add column if not exists nda_path             text;  -- the NDA object they signed
alter table mailing_om_requests add column if not exists nda_sha256           text;  -- hash of that file's bytes
alter table mailing_om_requests add column if not exists nda_signed_copy_path text;  -- NDA + certificate, in campaign-oms

comment on column mailing_om_requests.nda_signed_at is
  'When this visitor e-signed the campaign''s NDA on the landing page. Null = not signed; while landing_config.nda is set, the Deal Room stays locked for them.';

-- 'nda_signed' joins the Deal Room activity trail.
do $$ begin
  alter table deal_room_events drop constraint if exists deal_room_events_kind_check;
  alter table deal_room_events add constraint deal_room_events_kind_check
    check (kind in ('enter','return','document','update_email','nda_signed'));
exception when others then null; end $$;
