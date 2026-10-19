-- Early access sign-ups from the fenzit.com home page (POST /api/v1/early-access).
--
-- Plain-English contract: one row per email address. Email is required and is
-- stored lower-cased. Phone is optional and, when given, is an Indian mobile
-- number in E.164 form (+91 then 10 digits, first digit 6-9).
--
-- This table holds personal data (email and phone). It has RLS enabled and
-- NO policies, so anon and authenticated clients can read or write nothing.
-- Only the backend's service role writes here.

create table public.early_access_signups (
  id         uuid primary key default gen_random_uuid(),
  email      text not null,
  phone      text,
  source     text not null default 'web_home',
  created_at timestamptz not null default now(),
  constraint early_access_signups_email_key unique (email),
  constraint early_access_signups_email_format check (
    char_length(email) between 3 and 254
    and email = lower(email)
    and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ),
  constraint early_access_signups_phone_e164 check (
    phone is null or phone ~ '^\+91[6-9][0-9]{9}$'
  ),
  constraint early_access_signups_source_length check (
    char_length(source) between 1 and 40
  )
);

comment on table public.early_access_signups is
  'Early access sign-ups (personal data). RLS on, no policies: service role only.';

alter table public.early_access_signups enable row level security;

revoke all on public.early_access_signups from anon, authenticated;
