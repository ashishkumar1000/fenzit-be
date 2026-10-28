-- Call-back and demo requests from the fenzit.com site (POST /api/v1/contact-requests).
--
-- Plain-English contract: one row per request. A request is a call-back or a
-- demo. It must carry a way to reach the person: an email, a phone, or both.
-- Phone, when given, is international E.164 (a plus sign, then 7 to 15 digits).
-- Email, when given, is stored lower-cased.
--
-- This table holds personal data (name, company, email, phone, note). RLS is on
-- with NO policies, and anon and authenticated roles have no grants, so the public
-- site cannot read or write it. Only the backend's service role writes here.
-- Every request is kept; nothing here updates or deletes a row.

create table public.contact_requests (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null,
  name       text,
  company    text,
  email      text,
  phone      text,
  note       text,
  source     text not null default 'web_site',
  created_at timestamptz not null default now(),
  constraint contact_requests_kind_check check (
    kind in ('call_back', 'demo')
  ),
  constraint contact_requests_contact_present check (
    email is not null or phone is not null
  ),
  constraint contact_requests_email_format check (
    email is null or (
      char_length(email) between 3 and 254
      and email = lower(email)
      and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    )
  ),
  constraint contact_requests_phone_e164 check (
    phone is null or phone ~ '^\+[1-9][0-9]{6,14}$'
  ),
  constraint contact_requests_text_length check (
    char_length(coalesce(name, '')) <= 120
    and char_length(coalesce(company, '')) <= 120
    and char_length(coalesce(note, '')) <= 500
  ),
  constraint contact_requests_source_length check (
    char_length(source) between 1 and 40
  )
);

comment on table public.contact_requests is
  'Call-back and demo requests from the public site (personal data). RLS on, no policies: service role only.';

alter table public.contact_requests enable row level security;

revoke all on public.contact_requests from anon, authenticated;
