-- App roadblocks (SPEC-app-roadblocks): subscription validity per COMPANY and
-- the per-platform force-update config keys.
--
-- 1. tenants.validity_until: the instant a company's subscription ends. The
--    backend compares it by instant (now() >= validity_until means expired).
--    NULL is allowed by the column only for safety; the application sets a
--    value on every new company (see src/auth/tenant-validity.ts), so no new
--    company is ever NULL.
-- 2. Existing companies get migration time + 90 days, so nobody is locked
--    out on migration day (CAP-4).
-- 3. app_config gets the per-platform keys. The legacy keys
--    min_supported_version and force_update_message stay: old app binaries
--    still read them, and the backend keeps them equal to the Android values.
--
-- ON CONFLICT DO NOTHING keeps any value an owner already set by hand.

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS validity_until timestamptz NULL;

COMMENT ON COLUMN public.tenants.validity_until IS
  'Subscription end instant (UTC). Expired when now() >= this value. Set by the application on every new company (90 days); extended by a super admin.';

UPDATE public.tenants
   SET validity_until = now() + interval '90 days'
 WHERE validity_until IS NULL;

INSERT INTO public.app_config (key, value, description) VALUES
  ('min_supported_version_android', '"1.0.0"'::jsonb,
   'Android: minimum app version allowed. Lower Android installs see the forced-update screen'),
  ('min_supported_version_ios', '"1.0.0"'::jsonb,
   'iOS: minimum app version allowed. Lower iOS installs see the forced-update screen'),
  ('force_update_message_android', '"Please update the Fenzit app to continue."'::jsonb,
   'Android: copy shown on the forced-update screen'),
  ('force_update_message_ios', '"Please update the Fenzit app to continue."'::jsonb,
   'iOS: copy shown on the forced-update screen'),
  ('store_url_android', '"https://play.google.com/store/apps/details?id=com.fenzit"'::jsonb,
   'Android: Play Store link the forced-update screen opens'),
  ('store_url_ios', '"https://apps.apple.com/app/id0000000000"'::jsonb,
   'iOS: App Store link the forced-update screen opens. DUMMY placeholder until the owner supplies the real listing'),
  ('support_email', '"hello@fenzit.com"'::jsonb,
   'Support email shown on the roadblock screens (plain text)'),
  ('support_phone', '"+91 92792 30451"'::jsonb,
   'Support phone shown on the roadblock screens (plain text)')
ON CONFLICT (key) DO NOTHING;
