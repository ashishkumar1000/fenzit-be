-- Create idempotency_log table (Story 3.5)
-- Backs the IdempotencyInterceptor: a successfully-processed request whose
-- X-Idempotency-Key has been seen before (within 24h, same tenant, same scope)
-- is replayed from response_body instead of re-executing the handler (FR-17, AR-9).
--
-- UNIQUE (key, tenant_id, scope): the key is scoped to the tenant AND the concrete
-- request (scope = "METHOD:/path/with/concrete/:id"), per the IETF Idempotency-Key
-- draft and Stripe's model — the same key reused on a different resource or endpoint
-- must NOT replay the wrong cached body. Cross-tenant keys never collide; the unique
-- index doubles as the lookup index for the guard's (key, tenant_id, scope) probe.
-- (A request-payload fingerprint, to reject same-key/same-scope/different-body reuse,
-- is an optional future hardening — see deferred-work.md.)
--
-- NOTE: the 24-hour expiry is NOT enforced here. The pg_cron cleanup job
-- (DELETE WHERE created_at < now() - interval '24 hours') is added in Story 4.2.
-- Until then the interceptor's lookup filters created_at > now() - 24h so an
-- un-pruned key never replays past its window.

CREATE TABLE idempotency_log (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  key           TEXT        NOT NULL,
  tenant_id     UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope         TEXT        NOT NULL,
  response_body JSONB       NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (key, tenant_id, scope)
);

-- Tenant isolation is enforced at the app layer (the interceptor uses createAdmin,
-- which bypasses RLS, and scopes by tenant_id). This policy is defense-in-depth,
-- mirroring jobs_tenant_isolation / activity_logs_tenant_isolation.
ALTER TABLE idempotency_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "idempotency_log_tenant_isolation"
  ON idempotency_log
  FOR ALL
  USING (tenant_id = (auth.jwt() ->> 'tenantId')::uuid)
  WITH CHECK (tenant_id = (auth.jwt() ->> 'tenantId')::uuid);
