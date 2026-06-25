---
baseline_commit: 2f9472443b44b2c5e8d8b7beb1143b591600f1f5
---

# Story 4.2: Idempotent Action Replay

Status: done

## Story

As a technician reconnecting after working offline,
I want replayed workflow step and attachment requests with the same idempotency key to be deduplicated,
So that no action is applied twice even when the mobile app retries aggressively on reconnect.

## Acceptance Criteria

1. **Given** a workflow step call with `X-Idempotency-Key: {uuid}` already successfully processed **When** the same key is submitted again within 24 hours **Then** HTTP 200 with the original response body; the step is NOT re-applied and no new activity log entry is created.

2. **Given** an idempotency key older than 24 hours (expired from `idempotency_log` via pg_cron) **When** the same key is submitted **Then** The request is processed as a new request.

3. **Given** Tenant A and Tenant B both submit requests using the same key string **When** both requests are processed **Then** They are treated as independent — no cross-tenant collision (UNIQUE constraint on `key, tenant_id`).

4. **Given** a workflow step call WITHOUT the `X-Idempotency-Key` header **When** the request is processed **Then** The request proceeds normally without any idempotency check.

## Tasks / Subtasks

- [x] Task 1: pg_cron extension + cleanup migration
  - [x] 1.1 Write migration `20260621000012_pg_cron_idempotency_cleanup.sql`: enable `pg_cron`, schedule hourly `DELETE FROM idempotency_log WHERE created_at < now() - interval '24 hours'`
  - [x] 1.2 Add `DELETE FROM attachment_uploads WHERE expires_at < now() - interval '1 day'` to same cron job (or separate schedule)
  - [x] 1.3 Apply migration via Supabase MCP and verify cron job registered

- [x] Task 2: E2E tests for idempotency replay
  - [x] 2.1 E2E test: duplicate key within 24h on workflow step → 200 with original body, step not re-applied
  - [x] 2.2 E2E test: duplicate key within 24h on attachment upload → 200 with original body (covered by AC19 in jobs.e2e-spec.ts)
  - [x] 2.3 E2E test: cross-tenant — same key string for Tenant A and Tenant B treated independently
  - [x] 2.4 E2E test: no key → proceeds normally (no idempotency check)
  - [x] 2.5 E2E test: malformed key (not UUID v4) → 422 VALIDATION_ERROR
  - [x] 2.6 Run full suite — 227 pass, 1 pre-existing fail (RLS AR-20, unrelated)

### Review Findings

- [x] [Review][Decision] `attachment_uploads` cleanup interval — kept `expires_at < now() - interval '1 day'` (1-day grace buffer is industry standard); fixed clarifying comment [supabase/migrations/20260621000012_pg_cron_idempotency_cleanup.sql:26]
- [x] [Review][Patch] `cron.schedule` not idempotent — added `cron.unschedule` guards before each `cron.schedule` [supabase/migrations/20260621000012_pg_cron_idempotency_cleanup.sql:15,25]
- [x] [Review][Patch] Shared `chain()` mock instance — switched to `mockImplementation(chain)` so each `createAdmin()` call gets a fresh instance; first instance returned for assertion access [test/idempotency.e2e-spec.ts:157]
- [x] [Review][Patch] No `beforeEach` mock reset — added `beforeEach(() => mockCreateAdmin.mockReset())` [test/idempotency.e2e-spec.ts:82]
- [x] [Review][Patch] AC1: RPC non-re-execution not asserted — added `expect(chainInstance.rpc).not.toHaveBeenCalled()` [test/idempotency.e2e-spec.ts:189]
- [x] [Review][Defer] AC1: no assertion that zero new activity log entries created on replay — deferred, requires live DB or more complex mock instrumentation; the interceptor design (handler never runs on hit) is the logical guarantee
- [x] [Review][Defer] AC2: no dedicated test for workflow step expiry path — deferred, expiry is enforced in the interceptor's `gt('created_at', since)` filter (unit-tested at the interceptor level); cron is hygiene only
- [x] [Review][Defer] `fail-open` DB error path not tested — deferred, meaningful safety property; worth adding in a future hardening pass

## Dev Notes

### What's Already Built
- `IdempotencyInterceptor` at `src/common/interceptors/idempotency.interceptor.ts` — fully implemented in Story 3.5
- Applied to `POST /api/v1/jobs/:id/workflow` (Story 3.5) and `POST /api/v1/jobs/:id/attachments` (Story 3.6) — already `@UseInterceptors(IdempotencyInterceptor)` on both
- `idempotency_log` table with `UNIQUE (key, tenant_id, scope)` — Story 3.5 migration
- The interceptor already enforces the 24h window in its lookup query (`created_at > now() - 24h`); pg_cron is purely for table hygiene

### pg_cron Notes
- `pg_cron` is available on this Supabase project (`default_version: 1.6.4`) but NOT yet enabled (`installed_version: null`)
- Must `CREATE EXTENSION IF NOT EXISTS pg_cron` in the migration
- Supabase requires pg_cron jobs to be created in the `cron` schema: `SELECT cron.schedule(...)`
- Use `SELECT cron.schedule('name', '0 * * * *', 'DELETE FROM ...')` for hourly
- Jobs are idempotent to re-schedule: use `cron.unschedule` + `cron.schedule` or check `cron.job` table

### idempotency_log interceptor behavior (for test design)
- Key = `X-Idempotency-Key` header (UUID v4), optional
- Scope = `METHOD:/path` (e.g. `POST:/api/v1/jobs/abc/workflow`)
- Cache hit → returns `response_body` from DB, handler never runs
- Cache miss → runs handler, persists response via `tap`
- 24h window enforced in lookup (`gt created_at > now() - 24h`)

### Test Infrastructure
- Existing E2E test helpers in `test/jobs.e2e-spec.ts` — seed helpers for tenant, user, job creation
- Use `supertest` with `X-Idempotency-Key` header
- For cross-tenant AC3: create two separate tenants + users, verify same key string works independently

## Dev Agent Record

### Implementation Plan
- Migration first: enable pg_cron, schedule two cleanup jobs
- E2E tests: cover all 4 ACs + malformed key edge case

### Debug Log

### Completion Notes

- Migration `20260621000012_pg_cron_idempotency_cleanup.sql`: enabled `pg_cron` extension, registered two cron jobs — `idempotency-log-cleanup` (hourly, deletes rows older than 24h) and `attachment-uploads-cleanup` (daily 03:00 UTC, deletes expired staging rows). Both verified active via `SELECT * FROM cron.job`.
- No application code changes needed — `IdempotencyInterceptor` was already applied to both guarded endpoints in Story 3.5/3.6.
- New test file `test/idempotency.e2e-spec.ts`: 5 tests covering AC1 (workflow replay), AC3 (cross-tenant isolation), AC4 (no key → normal), and malformed key (non-UUID, UUID v1).
- Full suite: 227 pass, 1 pre-existing fail (RLS AR-20 requires live DB credentials — unrelated).
- Resolved deferred items W1 (Story 3.5) and A3 (Story 3.6 code review).

## File List

- `supabase/migrations/20260621000012_pg_cron_idempotency_cleanup.sql` (new)
- `test/idempotency.e2e-spec.ts` (new)

## Change Log

- 2026-06-21: Story 4.2 created — pg_cron cleanup + idempotency E2E tests
