-- Early access sign-ups get a reference code the visitor can quote back.
--
-- Plain-English contract: each new sign-up gets a random code such as
-- FZ-3F9A0C21. The code does not count up, so it tells nobody how many people
-- have signed up or when someone signed up. A repeat email keeps its original
-- code. The database generates the code, so the application cannot set or
-- change it.
--
-- This replaces the identity column from 20261019000008. That column counted up,
-- so a public caller could read sign-up order and, with a repeat email, check
-- whether an address was already on the list. Pre-launch, so no data needs
-- keeping.
--
-- RLS stays on with no policies (service role only).

alter table public.early_access_signups
  drop constraint early_access_signups_reference_number_key;

alter table public.early_access_signups
  drop column reference_number;

alter table public.early_access_signups
  add column reference_code text not null
    default ('FZ-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)));

alter table public.early_access_signups
  add constraint early_access_signups_reference_code_key unique (reference_code);

alter table public.early_access_signups
  add constraint early_access_signups_reference_code_format check (
    reference_code ~ '^FZ-[0-9A-F]{8}$'
  );
