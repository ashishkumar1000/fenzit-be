process.env['NODE_ENV'] = 'test';
process.env['PORT'] = '3001';
process.env['SUPABASE_URL'] = 'https://test.supabase.co';
process.env['SUPABASE_ANON_KEY'] = 'test-anon-key';
process.env['SUPABASE_JWT_SECRET'] =
  'test-jwt-secret-for-e2e-tests-minimum-32-chars';
process.env['SUPABASE_SERVICE_ROLE_KEY'] =
  'test-service-role-key-for-e2e-tests';
process.env['CLOUDFLARE_R2_ACCOUNT_ID'] = 'test-account-id';
process.env['CLOUDFLARE_R2_ACCESS_KEY'] = 'test-access-key';
process.env['CLOUDFLARE_R2_SECRET_KEY'] = 'test-secret-key';
process.env['CLOUDFLARE_R2_BUCKET'] = 'test-bucket';
process.env['WORKER_WEBHOOK_SECRET'] = 'test-webhook-secret';
