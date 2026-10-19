-- Early access phone numbers: accept any country, not only India.
--
-- Plain-English contract: phone is optional. When given, it is stored in
-- international E.164 form: a plus sign, then the country code and the number,
-- 7 to 15 digits in all, first digit not zero. Example: +919876543210.
--
-- Replaces the India-only CHECK from 20261019000007. Additive in effect: no rows
-- are rewritten, and every row that passed the old rule also passes this one.

alter table public.early_access_signups
  drop constraint early_access_signups_phone_e164;

alter table public.early_access_signups
  add constraint early_access_signups_phone_e164 check (
    phone is null or phone ~ '^\+[1-9][0-9]{6,14}$'
  );
