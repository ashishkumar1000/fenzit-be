-- The fenzit.com early-access form was removed (fenzit-web, November 2026)
-- together with the POST /api/v1/early-access endpoint in this repo. The table
-- never collected a row (checked 2026-11-07: 0 rows in production and dev),
-- so dropping it loses nothing.
--
-- The table held personal data (email and phone) behind RLS with no policies;
-- with the table gone, the revoke and policies go with it.

drop table if exists public.early_access_signups;
