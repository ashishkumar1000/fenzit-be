---
stepsCompleted: [1, 2, 3, 4]
inputDocuments:
  - _bmad-output/planning-artifacts/prds/prd-fenzit-be-2026-06-17/prd.md
  - _bmad-output/planning-artifacts/prds/prd-fenzit-be-2026-06-17/addendum.md
  - _bmad-output/planning-artifacts/architecture.md
---

# fenzit-be - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for fenzit-be (Jobzo Backend), decomposing the requirements from the PRD and Architecture into implementable stories.

## Requirements Inventory

### Functional Requirements

FR-1: Mock OTP initiation — `POST /api/v1/auth/otp/send`. Accepts E.164 phone number, creates a 5-minute OTP session, returns `{otp_session_id, expires_at}`. Rate-limited: max 5 sends per phone per 10 minutes (429). No actual message delivered in Phase 1.

FR-2: OTP verification and JWT issuance — `POST /api/v1/auth/otp/verify`. Accepts `otp_session_id` + `otp_code`. Mock mode: any 6-digit code succeeds. Returns signed JWT + user profile. Locks session after 5 failed attempts. JWT valid 7 days; no refresh endpoint.

FR-3: Tenant (company) onboarding — `POST /api/v1/auth/company`. Owner-only. Creates/updates Tenant record: `company_name`, `gstin` (optional, regex-validated), `state_code` (ISO 3166-2:IN, required), `service_categories`, `upi_vpa` (optional). Returns 201 on create, 200 on update. Idempotent.

FR-4: Technician invitation — `POST /api/v1/auth/invite`. Owner-only. Creates pending `invited` User record scoped to owner's Tenant with `name` and `skill_type`. First OTP login from invited phone auto-accepts invite. Returns `{invite_id}`. 409 if phone already active in Tenant.

FR-5: JWT authentication middleware — All routes except OTP send/verify require valid JWT. Middleware extracts `user_id`, `tenant_id`, `role` into request context. Returns 401 for missing/malformed/expired token. Returns 403 for role mismatch.

FR-6: Create job — `POST /api/v1/jobs`. Owner-only. Required: `customer_id` (or `new_customer` object), `service_location`, `service_type`, `scheduled_start`, `technician_id`. Optional: `scheduled_end`, `description`, `priority`, `require_completion_photo`, `notes_for_technician`. System assigns `JB-{YYYY}-{NNNN}` job number, sets status `scheduled`, appends `job_created` activity log entry.

FR-7: List jobs — `GET /api/v1/jobs`. Query params: `date` (default today IST), `status` (repeatable), `technician_id`. Owners see all Tenant jobs; Technicians see only their own. Cursor-based pagination, page size 50.

FR-8: Job detail — `GET /api/v1/jobs/:id`. Returns full job: all fields, Technician profile, Customer profile, Activity Log (oldest-first), Attachments list with pre-signed R2 read URLs (1-hour TTL, regenerated on each call), current Workflow Step. Technician can only retrieve their own assigned jobs (403 otherwise).

FR-9: Edit, reassign, or cancel job — `PATCH /api/v1/jobs/:id`. Owner-only. Mutable on `scheduled` job: `description`, `scheduled_start`, `scheduled_end`, `notes_for_technician`, `technician_id`, `priority`. Cancellation via `{status: "cancelled"}`. Returns 409 for invalid state transitions. Reassignment appends `job_reassigned` log; cancellation appends `job_cancelled` log.

FR-10: Technician workflow step advancement — `POST /api/v1/jobs/:id/workflow`. Technician-only. Steps in order: `on_my_way → arrived → in_progress → photos_uploaded → signature_captured → completed`. `on_my_way` transitions job to `in_progress`; `completed` transitions to `completed`. `photos_uploaded` skippable when `require_completion_photo = false`. Accepts `idempotency_key` (UUID v4). Each step appends activity log entry.

FR-11: Activity log (auto-recorded) — Append-only, immutable log managed entirely by backend. Events: `job_created`, `job_reassigned`, `job_cancelled`, `step_on_my_way`, `step_arrived`, `step_in_progress`, `step_photos_uploaded`, `step_signature_captured`, `step_completed`, `conflict_resolved`. Each entry: `event_type`, `actor`, `timestamp`, optional `metadata` JSON.

FR-12: Job attachment upload — `POST /api/v1/jobs/:id/attachments`. Technician-only. Upload photos (max 5, JPEG/PNG/HEIC up to 10 MB) or one customer signature. Files stored in Cloudflare R2 under `{tenant_id}/jobs/{job_id}/`. Returns presigned PUT URL for direct upload. First photo auto-advances `photos_uploaded` workflow step via webhook. Signature re-upload replaces existing.

FR-13: Create customer — `POST /api/v1/customers`. Owner-only. Required: `name`, `phone` (E.164). Optional: `address`, `city`. Auto-deduplication: if `new_customer.phone` matches existing, links rather than duplicates. Returns 409 on manual duplicate.

FR-14: List and search customers — `GET /api/v1/customers`. Owner-only. Supports `q` (partial match on name and phone, case-insensitive). Returns: `name`, `phone`, `city`, `job_count`, `last_job_date`. Cursor-based pagination, page size 50.

FR-15: Customer detail — `GET /api/v1/customers/:id`. Returns full Customer profile + paginated Job history (newest first): job number, `scheduled_start`, `status`, `service_type`. History pagination: cursor-based, page size 20.

FR-16: Delta sync endpoint — `POST /api/v1/sync`. Technician-only. Accepts `last_synced_at` (ISO 8601 or null for initial sync). Returns all Technician's jobs updated since `last_synced_at`: all fields, current workflow step, attachment metadata, customer name/address. Includes `server_time` (next sync cursor). Response time p95 < 500ms for ≤ 50 records.

FR-17: Idempotent action replay — Workflow step calls (FR-10) and attachment upload requests (FR-12) accept optional `idempotency_key` (UUID v4). Re-submitting same key within 24 hours returns original response without re-processing. Keys stored in `idempotency_log` Supabase table, expired via pg_cron after 24 hours.

FR-18: Conflict resolution rules — Server-side resolution for offline-replayed actions. Workflow steps: already-recorded step is a no-op; out-of-order step returns 422 with `current_step`. Attachments: last upload wins per slot. Every conflict appends `conflict_resolved` Activity Log entry.

### Non-Functional Requirements

NFR-1: Multi-Tenancy & Data Isolation — All data tables include `tenant_id`. Supabase RLS enforces every query is scoped to JWT `tenant_id` claim. Application layer must NOT substitute explicit `WHERE tenant_id = ?` for RLS. Cross-tenant data leaks are a hard launch blocker.

NFR-2: Authentication & Authorization — All routes except `/auth/otp/send` and `/auth/otp/verify` require a valid JWT. Owner routes return 403 for Technician callers; Technician-only routes return 403 for Owner callers. OTP brute-force limits: 5 failed verify attempts locks session; 5 sends per phone per 10 minutes triggers 429.

NFR-3: Performance — List endpoints (jobs, customers): p95 < 300ms under 100 concurrent tenants. Delta sync (≤ 50 records): p95 < 500ms.

NFR-4: Reliability — Zero in-memory application state for business data. All state in Supabase. Supabase Realtime for live job status push to web dashboard; frontend polls on Realtime disconnection.

NFR-5: Security — All file access via pre-signed URLs only; no public buckets. Pre-signed read URLs: 1-hour TTL, regenerated on each `GET /jobs/:id`. Trailing-slash Fastify middleware bypass vulnerability must be mitigated (global `onRequest` hook).

NFR-6: Observability — Structured JSON logs per request: `request_id`, `tenant_id`, `route`, `http_status`, `duration_ms`. Error responses include machine-readable `error_code` and human-readable `message`.

### Additional Requirements

- AR-1: Project scaffold using NestJS v11 + Fastify adapter + Bun v1.3.13. Specific init: `nest new fenzit-be --skip-install`, then `bun install`, add `@nestjs/platform-fastify`, `class-validator`, `class-transformer`, `reflect-metadata`. tsconfig requires `experimentalDecorators: true`, `emitDecoratorMetadata: true`.

- AR-2: Abstract repository pattern per domain (`BaseRepository<T>`). Supabase implementation behind the abstraction; service layer has zero Supabase imports. Module providers wire `{ provide: JobRepository, useClass: SupabaseJobRepository }`.

- AR-3: `SupabaseClientFactory` as DEFAULT-scoped singleton. Repositories call `factory.create(jwt)` on every method — never store client as class property. This threads the caller's JWT for RLS evaluation on every query.

- AR-4: Cloudflare R2 for all file assets (not Supabase Storage). Abstract `StorageRepository` with `CloudflareR2StorageRepository` implementation using `@aws-sdk/client-s3`. R2 key pattern: `{tenant_id}/jobs/{job_id}/{attachment_type}/{uuid}.{ext}`.

- AR-5: Direct mobile upload flow: backend issues presigned PUT URL → mobile uploads directly to R2 → R2 triggers Cloudflare Queue → Queue consumer Worker → `POST /internal/webhooks/storage` → backend records URL and advances workflow step.

- AR-6: Cloudflare Worker (separate deploy in `cloudflare-worker/`) as R2 event queue consumer. Must configure `wrangler.toml` with 3 retries and DLQ (`r2-upload-events-dlq`).

- AR-7: Custom JWT issued by NestJS backend signed with `SUPABASE_JWT_SECRET`. Shape: `{ sub: userId, tenantId, role, iat, exp }`. `@nestjs/jwt` library. JWT validity: 7 days.

- AR-8: OTP sessions in `@nestjs/cache-manager` in-memory store (NOT database). Cache keys: `otp:session:{sessionId}` (5-min TTL), `otp:rate:{phone}` (10-min TTL). OTP stored as bcrypt hash. Single-instance constraint — must be documented (Redis path for Phase 2).

- AR-9: Idempotency via Supabase `idempotency_log` table (UNIQUE on `key, tenant_id`). Rows cleaned by `pg_cron` after 24 hours. `IdempotencyGuard` reads `X-Idempotency-Key` header, short-circuits handler on cache hit.

- AR-10: Activity log writes must be atomic with the triggering state change via `supabase.rpc()`. Two RPC functions: `advance_workflow_step` and `create_job_with_log`. Never two sequential `supabase.from()` calls for what must be atomic.

- AR-11: Supabase CLI SQL migrations committed to version control (`supabase/migrations/`). 11 migration files: users, tenants, jobs, customers, activity_logs, idempotency_log, rls_policies, rpc_advance_workflow_step, rpc_create_job_with_log, indexes, job_sequences.

- AR-12: Job number generation via `job_sequences(tenant_id, year, last_seq)` counter table + `increment_job_counter` RPC. Year rollover resets counter inside the RPC — no cron needed.

- AR-13: Global Guards wired via `APP_GUARD`: `JwtAuthGuard` (JWT validation, populates `request.user`) and `RolesGuard` (enforces `@Roles()` decorator). `@Public()` decorator bypasses `JwtAuthGuard` for OTP endpoints.

- AR-14: Global `ExceptionFilter` enforcing single error shape: `{ statusCode, error_code, message }`. `ErrorCode` enum in `src/common/enums/error-code.enum.ts` — all error_code values defined there; never inline strings.

- AR-15: Global `LoggingInterceptor` via `APP_INTERCEPTOR`. Generates `request_id` (UUID v4) per request; logs structured JSON on response. `@nestjs/swagger` for OpenAPI spec at `/api/docs` (disabled in production).

- AR-16: IST day range utility (`src/common/utils/ist-day-range.util.ts`) — pure function returning `{ start: Date, end: Date }` for current IST calendar day. Used in jobs list query for `date=today` filter.

- AR-17: `@nestjs/config` with Joi schema validation on startup. Required env vars: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_JWT_SECRET`, `CLOUDFLARE_R2_ACCOUNT_ID`, `CLOUDFLARE_R2_ACCESS_KEY`, `CLOUDFLARE_R2_SECRET_KEY`, `CLOUDFLARE_R2_BUCKET`, `WORKER_WEBHOOK_SECRET`, `PORT`, `NODE_ENV`.

- AR-18: Dockerfile for local dev parity (`FROM oven/bun:1.3.13-alpine`). GitHub Actions CI: lint + unit tests on PRs. DigitalOcean App Platform auto-deploy on merge to `main`.

- AR-19: `OtpDeliveryProvider` abstract class. Phase 1: `MockOtpDeliveryProvider` (console.log only). Swap to `WhatsAppOtpDeliveryProvider` in Phase 2 by changing `useClass` only.

- AR-20: Mandatory RLS cross-tenant isolation integration test in `test/integration/rls-isolation.integration.spec.ts`. Must use `@supabase/supabase-js` client (NOT Supabase SQL Editor which bypasses RLS). Must pass before any feature is marked production-ready.

- AR-21: `@fastify/multipart` (not `multer`) for file upload handling on Fastify adapter.

- AR-22: Trailing-slash Fastify middleware bypass vulnerability — register a global `onRequest` hook to normalize trailing slashes before route matching.

- AR-23: `OtpSessionStore` abstract class wrapping cache. `InMemoryOtpSessionStore` as Phase 1 implementation. Allows clean mock substitution in tests.

### UX Design Requirements

N/A — This is a backend REST API; no UX design document exists. Both client apps (React web dashboard and React Native mobile) are separate projects consuming this API.

### FR Coverage Map

| FR | Epic | Description |
|---|---|---|
| FR-1 | Epic 1 | Mock OTP send |
| FR-2 | Epic 1 | OTP verify + JWT issuance |
| FR-3 | Epic 1 | Tenant company onboarding |
| FR-4 | Epic 1 | Technician invitation |
| FR-5 | Epic 1 | JWT middleware + RBAC |
| FR-6 | Epic 3 | Create job |
| FR-7 | Epic 3 | List jobs |
| FR-8 | Epic 3 | Job detail |
| FR-9 | Epic 3 | Edit/reassign/cancel job |
| FR-10 | Epic 3 | Technician workflow step advancement |
| FR-11 | Epic 3 | Activity log (auto-recorded) |
| FR-12 | Epic 3 | Job attachment upload (R2 + Worker) |
| FR-13 | Epic 2 | Create customer |
| FR-14 | Epic 2 | List/search customers |
| FR-15 | Epic 2 | Customer detail |
| FR-16 | Epic 4 | Delta sync endpoint |
| FR-17 | Epic 4 | Idempotent action replay |
| FR-18 | Epic 4 | Conflict resolution |

## Epic List

### Epic 1: Project Foundation & Authentication
An owner or technician can authenticate via mock OTP and receive a valid JWT. An owner can complete company setup and invite technicians. All cross-cutting infrastructure (guards, filters, interceptors, config, Swagger, migrations for auth tables) is in place.
**FRs covered:** FR-1, FR-2, FR-3, FR-4, FR-5
**Architecture requirements covered:** AR-1 through AR-23 (all cross-cutting infrastructure)

### Epic 2: Customer Management
An owner can create customer records, search them by name or phone, and view a customer's full profile with job history. Customer data is available for job creation in Epic 3.
**FRs covered:** FR-13, FR-14, FR-15

### Epic 3: Job Lifecycle
An owner can create a job, assign it to a technician, edit or cancel it, and see full details. A technician can advance a job through all 6 workflow steps, upload photos, and capture a digital signature. The owner sees a complete, immutable activity log. Cloudflare R2 upload flow and webhook callback are fully operational.
**FRs covered:** FR-6, FR-7, FR-8, FR-9, FR-10, FR-11, FR-12

### Epic 4: Offline-First Mobile Sync
A technician with intermittent connectivity can complete all workflow steps offline and sync all actions correctly when connectivity returns — no duplicate writes, no lost data.
**FRs covered:** FR-16, FR-17, FR-18

---

## Epic 1: Project Foundation & Authentication

An owner or technician can authenticate via mock OTP and receive a valid JWT. An owner can complete company setup and invite technicians. All cross-cutting infrastructure (guards, filters, interceptors, config, Swagger, database migrations for auth tables) is in place and operational.

### Story 1.1: NestJS + Fastify + Bun Project Scaffold

As a developer,
I want the project bootstrapped with NestJS v11 + Fastify adapter + Bun runtime and all cross-cutting infrastructure wired (config, cache, Supabase factory, JWT guards, exception filter, logging interceptor, Swagger),
So that all feature modules have a consistent, working foundation and `GET /health` returns 200.

**Acceptance Criteria:**

**Given** the repo is cloned and `.env` is populated with all required vars
**When** `bun run start:dev` is executed
**Then** the server starts without errors and `GET /health` returns `{ "status": "ok" }` with HTTP 200

**Given** a request arrives without an `Authorization` header on any protected route
**When** the global `JwtAuthGuard` processes it
**Then** HTTP 401 is returned with `{ "statusCode": 401, "error_code": "UNAUTHORIZED", "message": "..." }`

**Given** a required env var (e.g., `SUPABASE_URL`) is missing at startup
**When** the app bootstraps
**Then** the process exits immediately with a descriptive Joi validation error (fail-fast, no silent runtime failure)

**Given** any unhandled exception is thrown anywhere in the app
**When** it passes through the `GlobalExceptionFilter`
**Then** the response always has shape `{ "statusCode", "error_code", "message" }` with no stack trace in production

**Given** any request completes (success or error)
**When** the `LoggingInterceptor` fires on response
**Then** a structured JSON log is emitted containing `request_id`, `tenant_id` (or null), `route`, `http_status`, `duration_ms`

**Given** `NODE_ENV != production`
**When** `GET /api/docs` is requested
**Then** the Swagger UI is served with all registered routes visible

**Implementation Notes:**
- Bootstrap order (AR-1): scaffold → ESLint/Prettier → `ConfigModule` (Joi) → `CacheModule` → `SupabaseClientFactory` → `ErrorCode` enum + `GlobalExceptionFilter` → `PaginatedResponse<T>` + cursor utility + `ist-day-range.util.ts` → JWT guards + decorators → `LoggingInterceptor` → Swagger
- `SupabaseClientFactory` is DEFAULT-scoped singleton — never request-scoped
- `reflect-metadata` must be the very first import in `main.ts`
- Register global Fastify `onRequest` hook to normalize trailing slashes before route matching (AR-22 security mitigation)
- `@Public()` decorator must be wired and bypass `JwtAuthGuard` before any auth route exists
- Required env vars: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_JWT_SECRET`, `CLOUDFLARE_R2_ACCOUNT_ID`, `CLOUDFLARE_R2_ACCESS_KEY`, `CLOUDFLARE_R2_SECRET_KEY`, `CLOUDFLARE_R2_BUCKET`, `WORKER_WEBHOOK_SECRET`, `PORT`, `NODE_ENV`
- No database migrations in this story

---

### Story 1.2: Mock OTP Authentication & JWT Issuance

As a user (owner or technician),
I want to request a mock OTP for my phone number and verify it to receive a signed JWT,
So that I can authenticate with the system and make authenticated API calls.

**Acceptance Criteria:**

**Given** a valid E.164 phone number (`+91XXXXXXXXXX`)
**When** `POST /api/v1/auth/otp/send` is called
**Then** HTTP 200 with `{ otp_session_id, expires_at }` and a 5-minute session is created in the in-memory cache

**Given** a non-E.164 or non-numeric phone number
**When** `POST /api/v1/auth/otp/send` is called
**Then** HTTP 422 with `error_code: "VALIDATION_ERROR"`

**Given** the same phone number sends more than 5 OTPs within 10 minutes
**When** a 6th send is attempted
**Then** HTTP 429 with `error_code: "RATE_LIMIT_EXCEEDED"`

**Given** a valid `otp_session_id` and any 6-digit numeric code (mock mode)
**When** `POST /api/v1/auth/otp/verify` is called
**Then** HTTP 200 with `{ token, user: { userId, tenantId, role, name } }` where `tenantId` is null for a first-time user

**Given** a valid session but a wrong or non-6-digit code
**When** `POST /api/v1/auth/otp/verify` is called
**Then** HTTP 401 with `error_code: "INVALID_OTP"`

**Given** 5 consecutive failed verify attempts on the same session
**When** a 6th attempt is made
**Then** HTTP 401 with `error_code: "OTP_SESSION_LOCKED"` and all further attempts on that session are rejected

**Given** an expired or non-existent `otp_session_id`
**When** `POST /api/v1/auth/otp/verify` is called
**Then** HTTP 401 with `error_code: "OTP_EXPIRED"`

**Given** a valid JWT used as `Authorization: Bearer {token}` on any protected route
**When** the request is processed
**Then** `request.user` is populated with `{ userId, tenantId, role, rawJwt }` and the route executes normally

**Implementation Notes:**
- Creates `users` table migration: `id` UUID PK, `phone` TEXT UNIQUE, `name` TEXT nullable, `role` TEXT CHECK (`owner|technician`), `tenant_id` UUID nullable, `status` TEXT CHECK (`active|invited`), `created_at` TIMESTAMPTZ
- OTP stored as bcrypt hash in cache — never plaintext; cache keys: `otp:session:{sessionId}` TTL 5min, `otp:rate:{phone}` TTL 10min
- JWT shape: `{ sub: userId, tenantId, role, iat, exp }` — camelCase fields, signed with `SUPABASE_JWT_SECRET`, 7-day validity, `@nestjs/jwt` library
- `OtpDeliveryProvider` abstract class wired with `MockOtpDeliveryProvider` (console.log only)
- `OtpSessionStore` abstract class wired with `InMemoryOtpSessionStore` (wraps `@nestjs/cache-manager`)
- Both OTP endpoints marked `@Public()` — bypass `JwtAuthGuard`

---

### Story 1.3: Tenant Company Onboarding

As an owner,
I want to register my company profile after first login,
So that my business exists as a Tenant in the system and my `tenant_id` is associated with my account.

**Acceptance Criteria:**

**Given** an authenticated Owner with `tenantId: null` in their JWT, providing `company_name` and `state_code`
**When** `POST /api/v1/auth/company` is called
**Then** HTTP 201 with the created Tenant object and the user's `tenant_id` updated in the database

**Given** an Owner who already has a Tenant calling the endpoint again with updated fields
**When** `POST /api/v1/auth/company` is called
**Then** HTTP 200 with the updated Tenant (idempotent upsert)

**Given** a `gstin` value that does not match `\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d][Z][A-Z\d]`
**When** `POST /api/v1/auth/company` is called
**Then** HTTP 422 with `error_code: "VALIDATION_ERROR"`

**Given** `state_code` is missing from the request body
**When** `POST /api/v1/auth/company` is called
**Then** HTTP 422 with `error_code: "VALIDATION_ERROR"`

**Given** a Technician JWT
**When** `POST /api/v1/auth/company` is called
**Then** HTTP 403 with `error_code: "FORBIDDEN"`

**Implementation Notes:**
- Creates `tenants` table migration: `id` UUID PK, `company_name` TEXT NOT NULL, `gstin` TEXT nullable, `address` TEXT nullable, `state_code` TEXT NOT NULL, `service_categories` TEXT[], `upi_vpa` TEXT nullable, `created_at` TIMESTAMPTZ
- Adds FK constraint `users.tenant_id → tenants.id`
- RLS policies for `tenants` and `users` tables: `tenant_id = (auth.jwt() ->> 'tenantId')::uuid`
- JWT is NOT re-issued after company creation — `tenantId` reflects on the user's next OTP verify login (acceptable for Phase 1)

---

### Story 1.4: Technician Invitation & Auto-Accept

As an owner,
I want to invite a technician by phone number with their name and skill type,
So that they can log in with OTP and automatically join my tenant as an active technician.

**Acceptance Criteria:**

**Given** a valid `phone`, `name`, and `skill_type`
**When** `POST /api/v1/auth/invite` is called by an Owner
**Then** HTTP 201 with `{ invite_id }` and a `status: "invited"` User record is created scoped to the Owner's Tenant

**Given** the phone number is already an active member of the same Tenant
**When** `POST /api/v1/auth/invite` is called
**Then** HTTP 409 with `error_code: "DUPLICATE_RESOURCE"`

**Given** an invited phone number performing their first OTP login
**When** `POST /api/v1/auth/otp/verify` is called
**Then** User's `status` transitions `invited → active`, `tenant_id` and `role: "technician"` are set, and the returned JWT contains the correct `tenantId` and `role`

**Given** a Technician JWT
**When** `POST /api/v1/auth/invite` is called
**Then** HTTP 403 with `error_code: "FORBIDDEN"`

**Given** an invalid `skill_type` value not in the enum
**When** `POST /api/v1/auth/invite` is called
**Then** HTTP 422 with `error_code: "VALIDATION_ERROR"`

**Implementation Notes:**
- `skill_type` enum: `ac_technician | pest_control | plumbing | electrical | general`
- No separate invites table — `users` table with `status = 'invited'` is sufficient
- Invite acceptance logic in `AuthService.verifyOtp()`: check for `status = 'invited'` before issuing JWT
- A phone can hold a pending invite from only one Tenant at a time
- No invite expiry in Phase 1

---

## Epic 2: Customer Management

An owner can create customer records, search them by name or phone, and view a customer's full profile with job history. Customer data is ready for use in job creation (Epic 3).

### Story 2.1: Create Customer

As an owner,
I want to create a customer record with their name and phone number,
So that I can reference them when creating jobs.

**Acceptance Criteria:**

**Given** valid `name` and E.164 `phone`
**When** `POST /api/v1/customers` is called
**Then** HTTP 201 with the created Customer object including `id`, `name`, `phone`, `createdAt`

**Given** a phone number that already exists in the Tenant
**When** `POST /api/v1/customers` is called
**Then** HTTP 409 with `error_code: "DUPLICATE_RESOURCE"`

**Given** missing `name` or invalid phone format
**When** `POST /api/v1/customers` is called
**Then** HTTP 422 with `error_code: "VALIDATION_ERROR"`

**Given** a Technician JWT
**When** `POST /api/v1/customers` is called
**Then** HTTP 403 with `error_code: "FORBIDDEN"`

**Implementation Notes:**
- Creates `customers` table migration: `id` UUID PK, `tenant_id` UUID NOT NULL FK, `name` TEXT NOT NULL, `phone` TEXT NOT NULL, `address` TEXT nullable, `city` TEXT nullable, `created_via` TEXT CHECK (`manual|job_creation`) default `manual`, `created_at` TIMESTAMPTZ
- UNIQUE constraint on `(tenant_id, phone)`
- RLS on `customers`: `tenant_id = (auth.jwt() ->> 'tenantId')::uuid`

---

### Story 2.2: List & Search Customers

As an owner,
I want to list all my customers and filter them by name or phone,
So that I can quickly find a customer when creating or reviewing jobs.

**Acceptance Criteria:**

**Given** an Owner with existing customers
**When** `GET /api/v1/customers` is called without filters
**Then** HTTP 200 with cursor-paginated list (page size 50), each entry containing `name`, `phone`, `city`, `jobCount`, `lastJobDate`

**Given** `?q=priya` query param
**When** `GET /api/v1/customers` is called
**Then** Only customers with `name` or `phone` containing "priya" (case-insensitive) are returned

**Given** `?q=9833` partial phone search
**When** `GET /api/v1/customers` is called
**Then** Customers whose phone contains "9833" are returned

**Given** a Tenant with no customers
**When** `GET /api/v1/customers` is called
**Then** HTTP 200 with empty array (not 404)

**Given** a `cursor` from a previous paginated response
**When** `GET /api/v1/customers?cursor={nextCursor}` is called
**Then** The next page of results is returned in correct order

**Given** a Technician JWT
**When** `GET /api/v1/customers` is called
**Then** HTTP 403 with `error_code: "FORBIDDEN"`

**Implementation Notes:**
- `jobCount` and `lastJobDate` are computed from the `jobs` table (Epic 3); until jobs exist they return `jobCount: 0` and `lastJobDate: null` — response shape is established now
- Cursor encoding: `base64(JSON.stringify({ id, createdAt }))`, sort: `created_at DESC, id DESC`

---

### Story 2.3: Customer Detail with Job History

As an owner,
I want to view a customer's full profile and their complete job history,
So that I can review their service history before creating a new job.

**Acceptance Criteria:**

**Given** an existing Customer in the Owner's Tenant
**When** `GET /api/v1/customers/:id` is called
**Then** HTTP 200 with full Customer profile and paginated Job history (newest first), each job entry showing `jobNumber`, `scheduledStart`, `status`, `serviceType`

**Given** a `customerId` belonging to a different Tenant
**When** `GET /api/v1/customers/:id` is called
**Then** HTTP 404 (RLS returns empty — not a 403)

**Given** a Customer with no jobs
**When** `GET /api/v1/customers/:id` is called
**Then** HTTP 200 with `jobHistory: []` (not an error)

**Given** a Customer with more than 20 jobs
**When** `GET /api/v1/customers/:id` is called
**Then** First 20 jobs are returned with a `nextCursor` for pagination

**Implementation Notes:**
- Job history pagination: cursor-based, page size 20, sort: `scheduled_start DESC`
- Job history query requires `jobs` table (Epic 3); until Epic 3, `jobHistory` returns empty array — response shape is established in this story

---

## Epic 3: Job Lifecycle

An owner can create a job, assign it to a technician, edit or cancel it, and see full job details. A technician can advance a job through all 6 workflow steps, upload photos and a digital signature. A complete, immutable activity log is maintained. The Cloudflare R2 upload flow and webhook callback are fully operational.

### Story 3.1: Create Job

As an owner,
I want to create a job for a customer and assign it to a technician,
So that the technician knows what to do, where, and when.

**Acceptance Criteria:**

**Given** valid required fields: `customerId`, `serviceLocation`, `serviceType`, `scheduledStart`, `technicianId`
**When** `POST /api/v1/jobs` is called
**Then** HTTP 201 with full job object including system-assigned `jobNumber` (`JB-2026-NNNN`), `status: "scheduled"`, and a `job_created` activity log entry

**Given** a `new_customer` object with a phone matching an existing Customer in the Tenant
**When** `POST /api/v1/jobs` is called
**Then** The existing Customer is linked — no duplicate created; job is created normally

**Given** a `new_customer` object with a phone not matching any existing Customer
**When** `POST /api/v1/jobs` is called
**Then** A new Customer is auto-created with `created_via: "job_creation"`, then the job is created

**Given** a `technicianId` that does not belong to the caller's Tenant
**When** `POST /api/v1/jobs` is called
**Then** HTTP 404 with `error_code: "RESOURCE_NOT_FOUND"`

**Given** a missing required field (e.g., `scheduledStart`)
**When** `POST /api/v1/jobs` is called
**Then** HTTP 422 with `error_code: "VALIDATION_ERROR"`

**Given** a Technician JWT
**When** `POST /api/v1/jobs` is called
**Then** HTTP 403 with `error_code: "FORBIDDEN"`

**Given** two jobs created by the same Tenant in the same calendar year
**When** their job numbers are assigned
**Then** Job numbers are strictly sequential: `JB-2026-0001`, `JB-2026-0002` with no gaps or duplicates

**Implementation Notes:**
- Creates migrations: `jobs` table, `activity_logs` table, `job_sequences` counter table
- `jobs`: `id` UUID PK, `tenant_id`, `job_number` TEXT, `customer_id` FK, `technician_id` FK, `service_location` TEXT, `service_type` TEXT CHECK enum, `scheduled_start` TIMESTAMPTZ, `scheduled_end` TIMESTAMPTZ nullable, `status` TEXT CHECK (`scheduled|in_progress|completed|cancelled`), `current_step` TEXT nullable, `priority` TEXT CHECK (`normal|urgent`) default `normal`, `require_completion_photo` BOOLEAN default false, `description` TEXT nullable, `notes_for_technician` TEXT nullable, `created_at` TIMESTAMPTZ, `updated_at` TIMESTAMPTZ
- `activity_logs`: `id` UUID PK, `job_id` FK, `tenant_id`, `event_type` TEXT, `actor_id` UUID, `metadata` JSONB nullable, `created_at` TIMESTAMPTZ (immutable — no update/delete)
- `job_sequences`: `tenant_id` UUID, `year` INT, `last_seq` INT — `increment_job_counter(p_tenant_id, p_year)` RPC atomically increments; year rollover resets `last_seq` to 0 inside the RPC
- Job creation uses `create_job_with_log` RPC for atomic write (job INSERT + activity_log INSERT in single transaction)
- RLS on `jobs` and `activity_logs`; index: `idx_jobs_tenant_id_scheduled_start`
- `serviceType` enum: `ac_service | ac_installation | pest_control | plumbing | electrical | other`

---

### Story 3.2: List Jobs

As an owner or technician,
I want to list jobs filtered by date, status, and technician,
So that I can see all relevant jobs for a given day at a glance.

**Acceptance Criteria:**

**Given** an authenticated Owner with no filters
**When** `GET /api/v1/jobs` is called
**Then** HTTP 200 with all Tenant jobs where `scheduled_start` falls within today in IST (UTC+5:30), cursor-paginated, page size 50

**Given** `?status=scheduled&status=in_progress` query params
**When** `GET /api/v1/jobs` is called
**Then** Only jobs with status `scheduled` or `in_progress` are returned

**Given** `?date=2026-06-20`
**When** `GET /api/v1/jobs` is called
**Then** Only jobs where `scheduled_start` falls within June 20 2026 in IST are returned

**Given** `?technicianId=uuid` with an Owner JWT
**When** `GET /api/v1/jobs` is called
**Then** Only jobs assigned to that technician are returned

**Given** an authenticated Technician calling with `?technicianId={otherTechId}`
**When** `GET /api/v1/jobs` is called
**Then** Only the authenticated technician's own jobs are returned (filter silently ignored)

**Given** no jobs match the applied filters
**When** `GET /api/v1/jobs` is called
**Then** HTTP 200 with empty array (not 404)

**Implementation Notes:**
- `ist-day-range.util.ts` used for `date=today` boundary calculation
- Technician role: service layer applies `WHERE technician_id = user.userId` regardless of query params

---

### Story 3.3: Job Detail

As an owner or technician,
I want to view the complete details of a single job including its activity log and attachments,
So that I have full context on the job's current state and history.

**Acceptance Criteria:**

**Given** a job belonging to the authenticated user's Tenant
**When** `GET /api/v1/jobs/:id` is called
**Then** HTTP 200 with full job: all fields, Technician profile (`name`, `phone`, `skillType`), Customer profile (`name`, `phone`, `address`), Activity Log ordered oldest-first, Attachments list with pre-signed R2 read URLs (1-hour TTL regenerated on each call), `currentStep`

**Given** a job belonging to a different Tenant
**When** `GET /api/v1/jobs/:id` is called
**Then** HTTP 404 (RLS returns empty — not a 403)

**Given** a Technician JWT and a job not assigned to them
**When** `GET /api/v1/jobs/:id` is called
**Then** HTTP 403 with `error_code: "FORBIDDEN"`

**Given** a job with 3 photo attachments
**When** `GET /api/v1/jobs/:id` is called
**Then** Each attachment URL is a freshly generated R2 pre-signed read URL with 1-hour TTL

**Implementation Notes:**
- Pre-signed read URL generation via `StorageRepository.getPresignedReadUrl(key, 3600)` on every call — URLs are never cached or stored as permanent values in responses
- Response assembles: job entity + technician User record + customer Customer record + activity_logs ordered `created_at ASC` + attachments with fresh presigned URLs

---

### Story 3.4: Edit, Reassign & Cancel Job

As an owner,
I want to modify details, reassign, or cancel a scheduled job,
So that I can keep job information accurate or remove jobs that are no longer needed.

**Acceptance Criteria:**

**Given** a job in `scheduled` status with updated `description`, `scheduledStart`, `technicianId` in the body
**When** `PATCH /api/v1/jobs/:id` is called
**Then** HTTP 200 with updated job; reassignment appends `job_reassigned` activity log entry recording previous and new `technicianId`

**Given** a job in `scheduled` status and body `{ "status": "cancelled" }`
**When** `PATCH /api/v1/jobs/:id` is called
**Then** HTTP 200; job `status` becomes `cancelled`; `job_cancelled` activity log entry appended

**Given** a job in `in_progress` or `completed` status with any mutable field in the body
**When** `PATCH /api/v1/jobs/:id` is called
**Then** HTTP 409 with `error_code: "JOB_NOT_MODIFIABLE"`

**Given** a job in `in_progress` status and body `{ "status": "cancelled" }`
**When** `PATCH /api/v1/jobs/:id` is called
**Then** HTTP 409 with `error_code: "JOB_NOT_MODIFIABLE"`

**Given** a Technician JWT
**When** `PATCH /api/v1/jobs/:id` is called
**Then** HTTP 403 with `error_code: "FORBIDDEN"`

**Implementation Notes:**
- Reassign and cancel use `supabase.rpc()` for atomic job state update + activity_log insert
- `UpdateJobDto` extends `PartialType(OmitType(CreateJobDto, ['tenantId', 'createdBy'] as const))`

---

### Story 3.5: Technician Workflow Step Advancement

As a technician,
I want to advance a job through its 6 ordered workflow steps,
So that the owner sees my real-time progress and the job lifecycle is fully recorded.

**Acceptance Criteria:**

**Given** a job in `scheduled` status and step `on_my_way`
**When** `POST /api/v1/jobs/:id/workflow` is called
**Then** HTTP 200; job `status` transitions to `in_progress`; `step_on_my_way` activity log entry appended

**Given** step `completed` submitted after `signature_captured`
**When** `POST /api/v1/jobs/:id/workflow` is called
**Then** HTTP 200; job `status` transitions to `completed`; `step_completed` activity log entry appended

**Given** step `signature_captured` submitted directly after `in_progress` when `require_completion_photo = false`
**When** `POST /api/v1/jobs/:id/workflow` is called
**Then** HTTP 200; `photos_uploaded` step is validly skipped; activity log updated accordingly

**Given** a step submitted out of order (e.g., `completed` when current step is `on_my_way`)
**When** `POST /api/v1/jobs/:id/workflow` is called
**Then** HTTP 422 with `error_code: "INVALID_WORKFLOW_STEP"` and `{ "currentStep": "on_my_way" }` in response body

**Given** an `X-Idempotency-Key: {uuid}` header on a workflow step call already successfully processed
**When** the same key is re-submitted within 24 hours
**Then** HTTP 200 with the original response body; step is NOT re-applied

**Given** an Owner JWT
**When** `POST /api/v1/jobs/:id/workflow` is called
**Then** HTTP 403 with `error_code: "FORBIDDEN"`

**Implementation Notes:**
- Creates `idempotency_log` migration: `id` UUID PK, `key` TEXT, `tenant_id` UUID, `response_body` JSONB, `created_at` TIMESTAMPTZ, UNIQUE(`key, tenant_id`)
- Step advance uses `advance_workflow_step(p_job_id, p_step, p_actor_id)` RPC — atomic job `current_step` update + `activity_logs` INSERT in single transaction
- `IdempotencyGuard` applied via `@UseGuards(IdempotencyGuard)`; reads `X-Idempotency-Key` header, checks `idempotency_log`, short-circuits handler on hit
- `WorkflowService.validateStep()` enforces step ordering and the `photos_uploaded` skip rule based on `require_completion_photo` flag

---

### Story 3.6: Job Attachment Upload via Cloudflare R2

As a technician,
I want to upload photos and a customer signature for a job via a presigned URL,
So that there is proof of work captured before I mark the job complete.

**Acceptance Criteria:**

**Given** a valid `filename` and `mimeType` (image/jpeg, image/png, or image/heic)
**When** `POST /api/v1/jobs/:id/attachments` is called
**Then** HTTP 200 with `{ presignedPutUrl, key, uploadId }` — a 15-minute R2 presigned PUT URL for direct client upload

**Given** a `mimeType` not in the allowed list
**When** `POST /api/v1/jobs/:id/attachments` is called
**Then** HTTP 422 with `error_code: "VALIDATION_ERROR"`

**Given** a job already has 5 photos and a 6th photo is requested
**When** `POST /api/v1/jobs/:id/attachments` is called
**Then** HTTP 409 with `error_code: "DUPLICATE_RESOURCE"`

**Given** the Cloudflare Worker POSTs to `POST /internal/webhooks/storage` with valid `WORKER_SECRET` after a successful R2 upload
**When** the webhook body contains `{ key, size, tenantId, jobId, attachmentType }`
**Then** The attachment record is saved in the database; if `attachmentType = "photo"` and it is the first photo, the `photos_uploaded` workflow step is auto-advanced

**Given** a signature re-upload when a signature already exists for the job
**When** the webhook is processed
**Then** The existing signature record is replaced (last write wins)

**Given** the webhook arrives with an invalid or missing `WORKER_SECRET`
**When** `POST /internal/webhooks/storage` is processed
**Then** HTTP 401 and no database write occurs

**Given** an Owner JWT
**When** `POST /api/v1/jobs/:id/attachments` is called
**Then** HTTP 403 with `error_code: "FORBIDDEN"`

**Implementation Notes:**
- Creates `attachments` table migration: `id` UUID PK, `job_id` FK, `tenant_id`, `r2_key` TEXT, `r2_url` TEXT, `attachment_type` TEXT CHECK (`photo|signature`), `photo_index` INT nullable (1–5), `size_bytes` INT, `created_at` TIMESTAMPTZ
- Cloudflare Worker in `cloudflare-worker/` — `wrangler.toml` must configure: queue `r2-upload-events`, `max_retries = 3`, `dead_letter_queue = "r2-upload-events-dlq"`
- R2 key pattern: `{tenant_id}/jobs/{job_id}/{attachment_type}/{uuid}.{ext}`
- `POST /internal/webhooks/storage` is NOT in public Swagger docs, guarded by `WORKER_WEBHOOK_SECRET`
- Request body is JSON `{ filename, mimeType }` — `@fastify/multipart` is NOT used; bytes go direct to R2
- `IdempotencyGuard` applied to this endpoint (guard and table built in Story 3.5)

---

## Epic 4: Offline-First Mobile Sync

A technician with intermittent connectivity can complete all workflow steps offline, and all actions sync correctly when connectivity returns — no duplicate writes, no lost data, every conflict traceable in the activity log.

### Story 4.1: Delta Sync Endpoint

As a technician,
I want to sync my job data by sending my last sync timestamp,
So that I receive only the records that changed since my last sync and can work offline with up-to-date data.

**Acceptance Criteria:**

**Given** `last_synced_at: null` (initial sync)
**When** `POST /api/v1/sync` is called
**Then** HTTP 200 with all jobs assigned to the authenticated Technician: all fields, `currentStep`, attachment metadata, customer `name` and `address`, plus `serverTime` (UTC timestamp at query execution)

**Given** a valid ISO 8601 `last_synced_at` timestamp
**When** `POST /api/v1/sync` is called
**Then** Only jobs with `updated_at > last_synced_at` are returned, plus `serverTime`

**Given** no jobs have been updated since `last_synced_at`
**When** `POST /api/v1/sync` is called
**Then** HTTP 200 with `{ jobs: [], serverTime: "..." }` (not an error)

**Given** 50 changed job records
**When** `POST /api/v1/sync` is called
**Then** Response time is p95 < 500ms

**Given** an Owner JWT
**When** `POST /api/v1/sync` is called
**Then** HTTP 403 with `error_code: "FORBIDDEN"`

**Given** `last_synced_at` in an invalid format (not ISO 8601)
**When** `POST /api/v1/sync` is called
**Then** HTTP 422 with `error_code: "VALIDATION_ERROR"`

**Implementation Notes:**
- `serverTime` is the server's UTC timestamp at query execution — client stores it as the next `last_synced_at`
- Response strictly scoped to authenticated Technician's own jobs (RLS + service-layer filter)
- Add index: `idx_jobs_technician_id_updated_at` for efficient delta query
- `jobs.updated_at` must be auto-updated on any mutation (Postgres trigger or ORM hook)

---

### Story 4.2: Idempotent Action Replay

As a technician reconnecting after working offline,
I want replayed workflow step and attachment requests with the same idempotency key to be deduplicated,
So that no action is applied twice even when the mobile app retries aggressively on reconnect.

**Acceptance Criteria:**

**Given** a workflow step call with `X-Idempotency-Key: {uuid}` already successfully processed
**When** the same key is submitted again within 24 hours
**Then** HTTP 200 with the original response body; the step is NOT re-applied and no new activity log entry is created

**Given** an idempotency key older than 24 hours (expired from `idempotency_log` via pg_cron)
**When** the same key is submitted
**Then** The request is processed as a new request

**Given** Tenant A and Tenant B both submit requests using the same key string
**When** both requests are processed
**Then** They are treated as independent — no cross-tenant collision (UNIQUE constraint on `key, tenant_id`)

**Given** a workflow step call WITHOUT the `X-Idempotency-Key` header
**When** the request is processed
**Then** The request proceeds normally without any idempotency check

**Implementation Notes:**
- `idempotency_log` table and `IdempotencyGuard` infrastructure was built in Story 3.5
- This story adds the `pg_cron` scheduled job: `DELETE FROM idempotency_log WHERE created_at < now() - interval '24 hours'` (runs every hour)
- This story also applies `@UseGuards(IdempotencyGuard)` to `POST /api/v1/jobs/:id/attachments` (Story 3.6 endpoint) — guard now active on both workflow step advancement and attachment upload

---

### Story 4.3: Server-Side Conflict Resolution

As a backend system,
I want to resolve conflicts when a technician replays offline actions that are now out of sync with server state,
So that no data is silently dropped and every conflict is traceable in the activity log.

**Acceptance Criteria:**

**Given** a workflow step that is already recorded server-side (e.g., `arrived` already exists in the log)
**When** the same step is replayed without an idempotency key
**Then** HTTP 200 with current job state; no duplicate activity log entry is created

**Given** a workflow step submitted out of order during offline replay (e.g., `completed` when server has `on_my_way`)
**When** `POST /api/v1/jobs/:id/workflow` is called
**Then** HTTP 422 with `error_code: "INVALID_WORKFLOW_STEP"` and `{ "currentStep": "on_my_way" }` so the client can reconcile

**Given** a photo re-upload for slot index 2 where a photo already exists at that slot
**When** the R2 webhook is processed
**Then** The existing photo record for slot 2 is replaced with the new R2 URL (last write wins) and a `conflict_resolved` activity log entry is appended

**Given** a signature re-upload when a signature already exists for the job
**When** the R2 webhook is processed
**Then** The existing signature record is replaced and a `conflict_resolved` activity log entry is appended

**Given** any conflict resolution event occurs
**When** `GET /api/v1/jobs/:id` is called
**Then** A `conflict_resolved` entry appears in the Activity Log — no silent data drops

**Implementation Notes:**
- Out-of-order step logic already in `WorkflowService` (Story 3.5) — this story adds integration tests in `test/integration/sync.integration.spec.ts` for full offline replay scenarios end-to-end
- Last-write-wins for attachments handled in `WebhooksService.handleStorageEvent()`
- Mandatory RLS cross-tenant isolation test completed in `test/integration/rls-isolation.integration.spec.ts` (AR-20): use `@supabase/supabase-js` client with Tenant B JWT reading Tenant A jobs — assert empty array returned, not an error
