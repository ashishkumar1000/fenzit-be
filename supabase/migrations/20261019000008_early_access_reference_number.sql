-- Early access sign-ups get a reference number the visitor can quote back.
--
-- Plain-English contract: each new sign-up gets the next number from an
-- identity column (1, 2, 3, ...). The app shows it as FZ-00001 etc. A repeat
-- email keeps its original number. The database generates the column, so the
-- application cannot set or change it.
--
-- Additive only: adds one column and one unique constraint. No existing policy,
-- grant or row changes. RLS stays on with no policies (service role only).

alter table public.early_access_signups
  add column reference_number bigint generated always as identity;

alter table public.early_access_signups
  add constraint early_access_signups_reference_number_key unique (reference_number);
