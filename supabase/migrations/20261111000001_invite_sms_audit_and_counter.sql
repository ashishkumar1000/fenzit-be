-- Story 21-1 (spec-invite-sms-download-link, CAP-1 and CAP-6): the invite SMS
-- audit trail and the counter that the 5-per-hour cap (story 21-2) reads.
--
-- Plain-English contract:
--   invite_sms_audit    one row per invite SMS attempt. Holds the MASKED phone
--                       (for example +91 ******3210), the outcome and the time.
--                       It never holds the full number or any hash.
--   invite_sms_counter  one row per cap slot in use. A slot is reserved before the
--                       send, and deleted again if the send fails. A timeout keeps
--                       its slot, because the SMS may have arrived. A row is
--                       therefore also present while a send is in flight. Holds a
--                       keyed hash of the full number (HMAC-SHA256, key from the
--                       INVITE_SMS_HASH_KEY secret). Masked numbers are never
--                       used for counting, because two numbers can share a mask.
--
-- Retention (decided in story 21-1 dev notes), by pg_cron like the other cleanups:
--   audit rows   deleted when older than 12 months (daily at 03:50 UTC)
--   counter rows deleted when older than 24 hours (hourly at :20)
--
-- RLS is on with NO policies, and anon and authenticated have no grants, so only
-- the backend's service role reads or writes these tables.

create table public.invite_sms_audit (
  id                 uuid primary key default gen_random_uuid(),
  membership_user_id uuid not null,
  tenant_id          uuid not null,
  phone_masked       text not null,
  outcome            text not null,
  created_at         timestamptz not null default now(),
  -- Composite key: the audit row must point at a real membership of that company.
  constraint invite_sms_audit_membership_fk
    foreign key (membership_user_id, tenant_id)
    references public.memberships (user_id, tenant_id) on delete restrict,
  constraint invite_sms_audit_outcome_check check (
    outcome in ('sent', 'failed', 'refused_cap', 'not_configured')
  ),
  -- Database-level guard: only the masked form fits, never a full number.
  constraint invite_sms_audit_phone_masked_check check (
    phone_masked ~ '^\+[0-9]{1,4} \*+[0-9]{4}$'
  )
);

comment on table public.invite_sms_audit is
  'Invite SMS attempts with the masked phone only (personal data). RLS on, no policies: service role only.';

create index invite_sms_audit_membership_idx
  on public.invite_sms_audit (membership_user_id, tenant_id, created_at);

create index invite_sms_audit_created_idx
  on public.invite_sms_audit (created_at);

create table public.invite_sms_counter (
  id         uuid primary key default gen_random_uuid(),
  phone_hash text not null,
  created_at timestamptz not null default now(),
  constraint invite_sms_counter_phone_hash_check check (
    phone_hash ~ '^[0-9a-f]{64}$'
  )
);

comment on table public.invite_sms_counter is
  'Keyed hash per invite SMS actually sent, for the per-phone cap (personal data). RLS on, no policies: service role only.';

create index invite_sms_counter_phone_created_idx
  on public.invite_sms_counter (phone_hash, created_at);

create index invite_sms_counter_created_idx
  on public.invite_sms_counter (created_at);

alter table public.invite_sms_audit enable row level security;
alter table public.invite_sms_counter enable row level security;

revoke all on public.invite_sms_audit from anon, authenticated;
revoke all on public.invite_sms_counter from anon, authenticated;

-- Retention jobs. Same convention as 20261107000002_device_tokens.sql: extension
-- guard, usage grant, and an idempotent re-run (unschedule, then schedule).

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

GRANT USAGE ON SCHEMA cron TO postgres;

SELECT cron.unschedule('invite-sms-audit-prune') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'invite-sms-audit-prune'
);
SELECT cron.schedule(
  'invite-sms-audit-prune',
  '50 3 * * *',
  $$DELETE FROM public.invite_sms_audit WHERE created_at < now() - interval '12 months'$$
);

SELECT cron.unschedule('invite-sms-counter-prune') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'invite-sms-counter-prune'
);
SELECT cron.schedule(
  'invite-sms-counter-prune',
  '20 * * * *',
  $$DELETE FROM public.invite_sms_counter WHERE created_at < now() - interval '24 hours'$$
);
