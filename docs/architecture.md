# Architecture — fenzit-be (Jobzo Backend)

## Executive Summary

`fenzit-be` is a **modular monolith** NestJS application. The codebase
organizes business capability around eight feature modules (`auth`, `skills`,
`customers`, `jobs`, `storage`, `webhooks`, `sync`, plus the `supabase` and
`health` infrastructure modules). All feature modules share a single
`SupabaseModule` that exposes a JWT-scoped Supabase client.

## Architecture Pattern

- **Pattern name:** Modular monolith with JWT-scoped per-request data access
- **Why monolith:** Single team, single deployment, single domain. The
  boundaries between owner vs technician functionality are role-based, not
  service-based.
- **Why per-request JWT client:** Tenancy is enforced by RLS, which depends on
  the JWT claim. Reusing a singleton client across requests would either (a)
  bypass RLS or (b) leak the previous tenant's data.

> **Implementation drift:** The original architecture plan (AR-2) called for
> an abstract repository pattern (`BaseRepository<T>` + `Supabase*Repository`
> implementations per domain). The actual code uses a **service-only** pattern
> (e.g. `jobs.service.ts`, `customers.service.ts`) without the abstract
> repository layer. This is a known deviation; see "Known Gaps / Drift" below.

## Module Dependency Graph

```
                  AppModule
                     │
   ┌─────────┬───────┼────────────────────────┐
   │         │       │                        │
AuthModule  JobsModule  CustomersModule  SyncModule  SkillsModule  WebhooksModule  HealthController
   │         │       │                        │
   └─────────┴───────┼────────────────────────┘
                     │
               SupabaseModule (shared — JWT-scoped client factory)
                     │
                  CacheModule (in-memory, OTP sessions)
```

Rules:

- Feature modules depend only on `SupabaseModule` and `CacheModule`.
- Feature modules do **not** import each other.
- `common/` provides decorators, guards, interceptors, filters — and is
  imported by every feature module.

## Core Cross-Cutting Concerns

### Authentication (`src/auth/`)

- **AR-8** — Phone OTP via in-memory `cache-manager` (NOT a DB table).
  Cache keys: `otp:session:{sessionId}` (5-min TTL), `otp:rate:{phone}` (10-min
  TTL). OTP stored as bcrypt hash. **Phase 1 single-instance constraint**
  — multi-instance needs Redis swap.
- **Phase 1 mock OTP** — `verifyOtp` accepts any 6-digit code; the
  `isValid = true` comparison is hardcoded. Real verification with
  `bcrypt.compare` is a **pre-launch blocker** (deferred-work.md W1).
- **AR-7** — JWT signed with `@nestjs/jwt` using `SUPABASE_JWT_SECRET`,
  expiry **7 days**, shape `{ sub, tenantId, role, iat, exp }`.
- **AR-19** — `OtpDeliveryProvider` abstract class. Phase 1 uses
  `MockOtpDeliveryProvider` (console log). Phase 2 swaps to a WhatsApp BSP.
- OTP session lifecycle: `pending` → `verified` → `consumed`; locked after
  5 failed attempts.
- Token refresh: re-mint on company setup (returns fresh JWT with `tenantId`).

### Authorization (`src/common/guards/`)

**AR-13** — Two **global** guards, applied in `app.module.ts` via `APP_GUARD`:

1. **`JwtAuthGuard`** — verifies the JWT on every request unless `@Public()` is
   set on the handler.
2. **`RolesGuard`** — checks `@Roles(Role.X)` metadata against JWT `role`
   claim. Returns `403` if mismatched.

### Data Access (`src/supabase/`)

**AR-3** — `SupabaseClientFactory`:

- DEFAULT-scoped singleton (the original plan said request-scoped; the
  implementation uses DEFAULT scope — see "Known Gaps / Drift").
- `factory.create(jwt)` returns a per-request client that sends the JWT in
  `Authorization` — this is what RLS reads.
- Repositories/services call `factory.create(jwt)` on every method; never
  store the client as a class property.

### Atomicity (`supabase/migrations/`)

**AR-10** — All multi-step mutations go through `supabase.rpc()` calls.
**Never** chain sequential `supabase.from()` calls for what must be atomic.
See [data-models.md](./data-models.md#atomic-rpcs) for the full RPC catalog.

> **Pre-existing drift:** `auth.service.ts → findOrCreateUser` has two
> sequential `.from()` calls (violates AR-10). Documented as a known
> deviation in deferred-work.md. Also flagged: `inviteTechnician()` does 3
> sequential DB round-trips without a transaction.

### Idempotency (`src/common/interceptors/`)

**AR-9** — `idempotency_log` Postgres table (`UNIQUE(key, tenant_id)`);
`IdempotencyInterceptor` reads `X-Idempotency-Key`, short-circuits on hit.
`pg_cron` cleanup runs hourly (migration 12, added in Story 4.2).

### Error Handling (`src/common/filters/`)

**AR-14** — `GlobalExceptionFilter` (registered via `APP_FILTER`) enforces
a single error shape:

```json
{ "statusCode": 422, "error_code": "VALIDATION_ERROR", "message": "..." }
```

Validation errors return `422` (via `ValidationPipe.errorHttpStatusCode`).
`ErrorCode` enum lives in `src/common/enums/error-code.enum.ts`.

> **Drift:** the filter emits `message` verbatim, but `ValidationPipe`
> produces `message: string[]`. Validation bodies therefore carry an array
> rather than a single string — needs error-contract pass.

### Logging & Observability

**AR-15** — `LoggingInterceptor` (`APP_INTERCEPTOR`) generates a
`request_id` per request, logs structured JSON on response with
`tenant_id`, `route`, `http_status`, `duration_ms`. Phase 1 logs go to the
runtime stdout (DO log viewer once deployed); **no Sentry yet**.

## Domain Model

```
Tenant (1) ── (N) User (owners + technicians)
Tenant (1) ── (N) Customer
Tenant (1) ── (N) Job ── (1) Customer
                  Job  ── (1) Technician
                  Job  ── (N) ActivityLog (append-only)
                  Job  ── (N) Attachment
                  Job  ── (N) AttachmentUpload (pre-confirm)

Tenant (1) ── (N) TenantSkill
Technician (N) ── (N) TenantSkill  (via user_skills)
```

## Workflow State Machine

Jobs move through an ordered set of workflow steps (stored as
`jobs.sequence_index`). Out-of-order transitions return `422`.

```
scheduled ─▶ [in_progress] ─▶ [completed]
     │             │
     └─▶ cancelled └─▶ cancelled (in_progress can also cancel)
```

The exact step enum lives in `src/jobs/enums/`. Each `workflow_advanced`
mutation is atomic via `advance_workflow_step` RPC.

## Sync Architecture (Epic 4)

- **Outbound:** Technician app polls `POST /api/v1/sync` with its last
  `server_time`. Server returns jobs assigned to this technician changed
  since that timestamp + IDs of jobs that were deleted (rare).
- **Inbound action replay:** Owner → technician actions are posted to endpoints
  guarded by `IdempotencyInterceptor` + `idempotency_log` table for 24h replay
  protection.
- **Conflict resolution:** Attachment confirm uses `rpc_confirm_attachment`
  (migration 13/14) — server-side, not client-driven.

## File Upload Architecture

Two-phase presigned PUT to Cloudflare R2:

```
1. POST /api/v1/jobs/:id/attachments → backend mints R2 presigned URL,
   inserts attachment_uploads row, returns {uploadId, uploadUrl}

2. Mobile app PUTs the file directly to R2 using the presigned URL.

3. POST /api/v1/jobs/:id/attachments/:uploadId/confirm → backend calls
   rpc_confirm_attachment (atomic). Returns 200 or 410 (expired).

4. (Optional) Cloudflare Worker sends a storage event to
   POST /internal/webhooks/storage → backend reconciles.
```

We never accept uploads through the backend itself (`@fastify/multipart` is
NOT used). This keeps the API horizontally scalable without sticky sessions.

## Configuration

- `.env` validated at boot by `Joi` schema in `app.module.ts`.
- Missing/invalid values **fail fast** — the process exits with a clear
  validation error.
- `NODE_ENV=production` disables Swagger.

## Process Model

- Single Node.js process (Bun runtime).
- No background workers in the API process. Scheduled work (e.g. `pg_cron`
  purge of `idempotency_log`) runs in Postgres.
- All long-running operations are issued as RPCs against Postgres.

## Decision Records (Architectural Choices — AR-1 through AR-23)

Per `_bmad-output/planning-artifacts/epics.md` lines 71-115. The high-impact
rules:

| AR | Title | Status |
|---:|---|---|
| AR-1 | NestJS v11 + Fastify + Bun v1.3.13 scaffold | ✅ |
| AR-2 | **Abstract repository pattern per domain** | ⚠️ **Drifted** — code uses services directly |
| AR-3 | `SupabaseClientFactory` DEFAULT-scoped singleton | ✅ |
| AR-4 | Cloudflare R2 (not Supabase Storage) via abstract `StorageRepository` | ⚠️ **Drifted** — code has `StorageService`, not the abstract repo |
| AR-5 | Direct mobile upload → R2 → Queue → Worker → webhook | ⚠️ **Drifted** — Worker Queue binding commented out; uses both webhook AND client confirm |
| AR-6 | Cloudflare Worker with `wrangler.toml` retries + DLQ | ⚠️ **Partial** — Queue binding commented (Free plan); config deferred |
| AR-7 | Custom JWT signed with `SUPABASE_JWT_SECRET`, 7-day expiry | ✅ |
| AR-8 | OTP sessions in `cache-manager`, bcrypt-hashed | ✅ |
| AR-9 | Idempotency via `idempotency_log` table, `pg_cron` cleanup | ✅ |
| AR-10 | Atomic activity log writes via `supabase.rpc()` | ⚠️ **Violated** in `findOrCreateUser` + `inviteTechnician()` |
| AR-11 | SQL migrations in `supabase/migrations/`, applied via MCP | ✅ |
| AR-12 | Job number via `job_sequences` counter + `increment_job_counter` RPC | ✅ |
| AR-13 | Global `JwtAuthGuard` + `RolesGuard` via `APP_GUARD`; `@Public()` | ✅ |
| AR-14 | `GlobalExceptionFilter` + `ErrorCode` enum, single error shape | ⚠️ **Partial** — `message` array vs string inconsistency |
| AR-15 | `LoggingInterceptor` via `APP_INTERCEPTOR`, request_id JSON logs | ✅ |
| AR-16 | IST day range utility (`src/common/utils/ist-day-range.util.ts`) | ✅ |
| AR-17 | `@nestjs/config` + Joi schema validation | ✅ |
| AR-18 | Dockerfile + GitHub Actions CI + DigitalOcean App Platform | ❌ **Not in repo** — planned for pre-launch |
| AR-19 | `OtpDeliveryProvider` abstract, `MockOtpDeliveryProvider` Phase 1 | ✅ |
| AR-20 | RLS cross-tenant isolation test (mandatory, blocks launch) | ⚠️ **Test exists, always skipped in CI** — needs DB infra |
| AR-21 | `@fastify/multipart` for file upload handling | ❌ **Not used** — code uses presigned PUT only |
| AR-22 | Trailing-slash Fastify vulnerability mitigation | ✅ (`ignoreTrailingSlash: true` on adapter) |
| AR-23 | `OtpSessionStore` abstract + `InMemoryOtpSessionStore` | ✅ |

> Source: `_bmad-output/planning-artifacts/epics.md` lines 71-115.

## Epic Coverage Map

Per `_bmad-output/planning-artifacts/epics.md`, all four planned epics are
delivered:

| Epic | Title                              | Module(s)            | FRs | Status |
|-----:|------------------------------------|----------------------|-----|--------|
| 1 | Project Foundation & Authentication | `auth/`, `skills/`, `tenants/`, `common/`, `supabase/` | FR-1..5 | ✅ delivered |
| 2 | Customer Management                 | `customers/`         | FR-13..15 | ✅ delivered |
| 3 | Job Lifecycle                      | `jobs/`, `storage/`, `webhooks/` | FR-6..12 | ✅ delivered |
| 4 | Offline-First Mobile Sync           | `sync/`, plus `idempotency_log` + `pg_cron` cleanup | FR-16..18 | ✅ delivered |

No further epics are planned in the current planning artifacts. Retrospectives
exist for Epic 1 (`epic-1-retro-2026-06-20.md`) and Epic 2
(`epic-2-retro-2026-06-21.md`); no Epic 3/4 retro yet.

## FR Coverage (all 18 FRs)

| FR | Epic | Implementation file(s) |
|---|---|---|
| FR-1 Mock OTP send | 1 | `auth/auth.controller.ts`, `mock-otp-delivery.provider.ts`, `in-memory-otp-session.store.ts` |
| FR-2 OTP verify + JWT | 1 | `auth/auth.service.ts`, `jwt-auth.guard.ts` |
| FR-3 Tenant onboarding | 1 | `auth/auth.controller.ts` (POST /company), `rpc setup_tenant_for_owner` |
| FR-4 Technician invite | 1 | `auth/auth.controller.ts` (POST /invite), `auth.service.ts` |
| FR-5 JWT + RBAC | 1 | `jwt-auth.guard.ts`, `roles.guard.ts`, `current-user.decorator.ts` |
| FR-6 Create job | 3 | `jobs.service.ts`, `rpc create_job_with_log` |
| FR-7 List jobs | 3 | `jobs.controller.ts`, `jobs.service.ts` (cursor + IST day) |
| FR-8 Job detail | 3 | `jobs.service.ts`, `attachments.service.ts` (presigned GET URLs) |
| FR-9 Edit/cancel | 3 | `jobs.service.ts`, `rpc update_job_with_log` |
| FR-10 Workflow advance | 3 | `workflow.service.ts`, `rpc advance_workflow_step`, `IdempotencyInterceptor` |
| FR-11 Activity log | 3 | All RPCs (Postgres-side, append-only) |
| FR-12 Attachments | 3 | `attachments.service.ts`, `storage/storage.service.ts`, `webhooks.controller.ts` |
| FR-13 Create customer | 2 | `customers.controller.ts`, `customers.service.ts` |
| FR-14 List/search customers | 2 | `customers.controller.ts`, `customers.service.ts` |
| FR-15 Customer detail | 2 | `customers.controller.ts` (GET /:id) |
| FR-16 Delta sync | 4 | `sync/sync.controller.ts`, `sync.service.ts`, `idx_jobs_tenant_updated_at` |
| FR-17 Idempotent replay | 4 | `IdempotencyInterceptor`, `idempotency_log`, `pg_cron` (migration 12) |
| FR-18 Conflict resolution | 4 | `rpc_confirm_attachment` (migration 13), `rpc_confirm_attachment_conflict_fix` (migration 14) |

## Known Gaps / Drift (pre-launch blockers)

These are tracked in `_bmad-output/implementation-artifacts/deferred-work.md`
and `_bmad-output/implementation-artifacts/epic-2-retro-2026-06-21.md`.

### Pre-launch blockers (must fix before production)

- **Mock OTP (W1)** — `verifyOtp` has `isValid = true` hardcoded. OTP code is
  never actually verified. Replace with `bcrypt.compare` before any real
  deployment.
- **`createAdmin()` bypasses RLS (C1)** — `CustomersService.createCustomer()`
  uses the service-role client, which bypasses RLS. Tenant isolation rests on
  app-layer `tenant_id` assignment. Same pattern in skills/auth. Revisit
  when RLS is enforced before launch.
- **AR-20 RLS isolation test skipped in CI** — infrastructure gap; CI has
  no DB. Test exists in `test/integration/rls-isolation.integration.spec.ts`
  but is always skipped.
- **AR-10 violations** — `findOrCreateUser` does 2 sequential `.from()`
  calls; `inviteTechnician()` does 3 sequential round-trips. Pre-existing.
- **AR-18 missing in repo** — no Dockerfile, no GitHub Actions workflow,
  no DO App Platform config. Plan calls for these but they aren't committed
  yet.
- **`sizeBytes` client-trusted (A2)** — attachment size is client-supplied;
  should be derived server-side via `HeadObjectCommand` on R2.
- **Idempotency replay can return stale presigned URL (CR3.6-1)** — 24h
  replay window > 15-min presigned URL TTL → 200 with dead URL.

### Phase 2 deferred (not launch-blocking)

- AR-21 (`@fastify/multipart`) — never shipped; presigned PUT only.
- AR-6 worker Queue binding — commented in `wrangler.toml` (Free plan).
- AR-4 abstract `StorageRepository` — code uses `StorageService` directly.
- AR-2 abstract repository pattern — code uses services directly.
- Unbounded TEXT columns (C2) — `customers.name/address/city`,
  `tenants.company_name/address/upi_vpa`, `jobs.description/notes_for_technician`.
- GSTIN regex doesn't validate state-code prefix (1.3 review).
- `users.tenant_id` not re-linked on idempotent re-call (1.3 review).
- No cleanup job for expired `attachment_uploads` rows (A3).
- No R2 object cleanup on abandoned uploads (A4).
- `ErrorCode` filter casts `message` as string but `ValidationPipe` produces
  `string[]` (CR3 from Epic 3.5).

## Anti-Patterns to Avoid

- ❌ Using `jose` or `jsonwebtoken` directly — use `@nestjs/jwt`
- ❌ Adding `@fastify/multipart` — uploads are presigned only
- ❌ Bypassing RLS in tests with service role — use real JWTs
- ❌ Sequential `supabase.from()` calls for related writes — use RPC
- ❌ Writing migrations as ad-hoc SQL — apply via Supabase MCP only
- ❌ Adding cross-feature-module imports — use `common/` for shared concerns