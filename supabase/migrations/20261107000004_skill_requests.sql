-- Owner requests for a skill that is missing from the global catalog.
--
-- Plain-English contract: when a company's owner or admin cannot find their
-- trade in the skills list, they can ask Fenzit to add it. One row per distinct
-- request per company. The request is only a note for the Fenzit team to review;
-- it does not add the skill and does not change any technician.
--
-- The name is stored as typed (trimmed) and must be 2 to 60 characters.
-- A second request for the same name in the same company (ignoring case) is
-- refused by the unique index; the API treats that as "already requested".
--
-- RLS is on with NO policies, and anon and authenticated roles have no grants.
-- Only the backend's service role reads or writes here, after checking the caller.

create table public.skill_requests (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants (id) on delete restrict,
  requested_by uuid not null references public.users (id) on delete restrict,
  name         text not null,
  created_at   timestamptz not null default now(),
  constraint skill_requests_name_length check (
    char_length(name) between 2 and 60
    and name = btrim(name)
  )
);

create unique index skill_requests_tenant_name_unique
  on public.skill_requests (tenant_id, lower(name));

comment on table public.skill_requests is
  'Owner requests for a missing skill, one per company and name. RLS on, no policies: service role only.';

alter table public.skill_requests enable row level security;

revoke all on public.skill_requests from anon, authenticated;
