-- Hardening (2026-09-09): enable RLS on the two public tables that had it off.
--
-- users: 3 policies already existed but were inert while table-level RLS was off
-- (read own row or same tenant, update own, no client inserts). The backend reads
-- users exclusively through the service-role client (createAdmin), which bypasses
-- RLS, so activating these policies changes nothing for the API.
--
-- country_codes: static reference data (dial codes). No policy existed, so add a
-- public SELECT policy first — reads stay open (login screen needs dial codes),
-- all writes become service-role only.

create policy "country_codes_public_read"
  on public.country_codes
  for select
  to public
  using (true);

alter table public.users enable row level security;
alter table public.country_codes enable row level security;