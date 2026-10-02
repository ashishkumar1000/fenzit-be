process.env['NODE_ENV'] = 'test';
process.env['PORT'] = '3001';
// Supabase vars only apply the stub when unset, so exporting real
// credentials runs the real-DB integration tests (review round 2, 2026-09-10).
process.env['SUPABASE_URL'] ??= 'https://test.supabase.co';
process.env['SUPABASE_ANON_KEY'] ??= 'test-anon-key';
process.env['SUPABASE_JWT_SECRET'] ??=
  'test-jwt-secret-for-e2e-tests-minimum-32-chars';
process.env['SUPABASE_SERVICE_ROLE_KEY'] ??=
  'test-service-role-key-for-e2e-tests';
process.env['CLOUDFLARE_R2_ACCOUNT_ID'] = 'test-account-id';
process.env['CLOUDFLARE_R2_ACCESS_KEY'] = 'test-access-key';
process.env['CLOUDFLARE_R2_SECRET_KEY'] = 'test-secret-key';
process.env['CLOUDFLARE_R2_BUCKET'] = 'test-bucket';
process.env['WORKER_WEBHOOK_SECRET'] = 'test-webhook-secret';
process.env['GOOGLE_PLACES_API_KEY'] = 'test-google-places-api-key';
// The HTTP OTP tests read the echoed code from the send response (the same
// contract the app's __DEV__ chip uses in dev). Never set this on a
// reachable deployment — see auth.service.ts otpDevEchoEnabled.
process.env['OTP_DEV_ECHO'] = 'true';
// The 15-7 pg pool fails fast on a missing URL at boot; tests never connect
// (the pool is overridden in the attendance specs), so a dummy string keeps
// AppModule happy. An empty-string export must fall back too — the pool's
// fail-fast checks truthiness, and ??= would treat '' as present.
if (!process.env['DATABASE_URL']) {
  process.env['DATABASE_URL'] = 'postgresql://test:test@localhost:5432/test';
}
