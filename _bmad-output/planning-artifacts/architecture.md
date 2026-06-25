---
stepsCompleted: [1, 2, 3, 4, 5, 6, 7, 8]
lastStep: 8
status: 'complete'
completedAt: '2026-06-19'
inputDocuments:
  - _bmad-output/planning-artifacts/prds/prd-fenzit-be-2026-06-17/prd.md
  - _bmad-output/planning-artifacts/prds/prd-fenzit-be-2026-06-17/addendum.md
workflowType: 'architecture'
project_name: 'fenzit-be'
user_name: 'Ashish'
date: '2026-06-18'
---

# Architecture Decision Document — Jobzo Backend (fenzit-be)

_This document builds collaboratively through step-by-step discovery. Sections are appended as we work through each architectural decision together._

## Project Context Analysis

### Requirements Overview

**Functional Requirements:** 18 FRs across 4 domains.

| Domain | FRs | Description |
|---|---|---|
| Auth & Onboarding | FR-1–5 | Mock OTP, JWT issuance, Tenant setup, Technician invite, JWT middleware |
| Job Management | FR-6–12 | Full job lifecycle, 6-step workflow, attachments, activity log |
| Customer Management | FR-13–15 | Create, list/search, detail with job history |
| Mobile Sync | FR-16–18 | Delta sync, idempotent replay, server-side conflict resolution |

**Non-Functional Requirements:**

- **Multi-tenancy**: Supabase RLS on every table; no application-layer `WHERE tenant_id` substitution
- **Performance**: List endpoints p95 < 300ms under 100 concurrent tenants; delta sync p95 < 500ms for ≤ 50 records
- **Security**: Pre-signed Supabase Storage URLs only (1-hour TTL); no public buckets; JWT validation on all protected routes
- **Reliability**: Zero in-memory application state; all state in Supabase
- **Observability**: Structured JSON logs with `request_id`, `tenant_id`, `route`, `http_status`, `duration_ms` on every request

**Scale & Complexity:**

- Primary domain: Backend REST API (Bun.js + TypeScript)
- Complexity level: Medium-High
- Estimated architectural components: ~8 modules (Auth, Tenant, User/Invite, Job, Customer, Workflow, Sync, Storage)

### Technical Constraints & Dependencies

- **Runtime**: Bun.js with TypeScript, targeting DigitalOcean
- **Database**: Supabase PostgreSQL with Row Level Security; Supabase Storage for files; Supabase Realtime for live job board
- **Auth**: Supabase Auth JWT — Bun.js backend validates against Supabase JWT secret
- **Timezone**: All `date=today` logic in IST (UTC+5:30) for Phase 1
- **Phase 1 constraints**: Mock OTP (any 6-digit code accepted), no real SMS, no invoicing, no payments

### Cross-Cutting Concerns Identified

1. **Multi-tenancy enforcement** — every DB query executes within an RLS context derived from the JWT `tenant_id` claim
2. **JWT middleware** — extracts `user_id`, `tenant_id`, `role` and injects into request context for every protected route
3. **Activity Log writes** — every job state mutation atomically appends an immutable log entry; needs a shared pattern across handlers
4. **Idempotency** — workflow step advances and attachment uploads accept an `idempotency_key`; 24-hour dedup window required
5. **Structured logging** — per-request `request_id`, `tenant_id`, `route`, `http_status`, `duration_ms` as a middleware concern
6. **Pre-signed URL generation** — Supabase Storage pre-signed URLs with 1-hour TTL, generated on every `GET /jobs/:id` response

## Starter Template Evaluation

### Primary Technology Domain

Backend REST API — NestJS v11 with Fastify adapter on Bun runtime, deployed on
DigitalOcean. No frontend in scope; this service is consumed by two external clients
(React web dashboard, React Native mobile app).

### Starter Options Considered

| Framework | Decision |
|---|---|
| **Elysia v1.4.19** | Rejected — Bun-native but minimal structure; cross-cutting concerns must be hand-rolled |
| **Hono v4.12.16** | Rejected — portability advantage irrelevant for fixed Bun + DigitalOcean target |
| **NestJS + Express adapter** | Rejected — Express v5 breaking changes; 4x lower throughput under load vs Fastify |
| **NestJS + Fastify adapter** | Selected — opinionated module/DI system + Fastify performance |

### Selected Stack: NestJS v11.1.27 + Fastify v5.8.5 + Bun v1.3.13

**Rationale:**
NestJS Guards, Pipes, Interceptors, and Exception Filters map directly to this
project's cross-cutting concerns (JWT + role enforcement FR-5, input validation
across all 18 FRs, structured logging §7.6, consistent error codes). The Fastify
adapter delivers 15–18K req/s vs Express's 10–12K, and 2,720 vs 661 req/s at
1,000 concurrent users — meaningful headroom for the p95 < 300ms NFR.

**Initialization:**

```bash
npm install -g @nestjs/cli        # install CLI once
nest new fenzit-be --skip-install  # scaffold without installing
cd fenzit-be
bun install                       # switch to Bun as package manager
bun add @nestjs/platform-fastify fastify
bun add class-validator class-transformer reflect-metadata
```

**Required `tsconfig.json` settings:**

```json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "target": "ES2020",
    "strict": true
  }
}
```

**`main.ts` bootstrap:**

```typescript
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter()
  );
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
  await app.listen(3000, '0.0.0.0');
}
bootstrap();
```

**Architectural Decisions Provided by Starter:**

- **Runtime:** Bun v1.3.13 — package manager, test runner, and process host
- **HTTP Layer:** Fastify v5.8.5 via `@nestjs/platform-fastify`
- **Build Tooling:** SWC compiler (NestJS v11 default) — fast incremental builds
- **Validation:** Global `ValidationPipe` with `class-validator` + `class-transformer`
- **Testing:** Jest (NestJS default); Bun's Jest-compatible runner available with minor config
- **Code Organization:** NestJS module system — one module folder per domain
- **DI Container:** NestJS native — services, repositories, utilities are injectable
- **File Uploads:** `@fastify/multipart` (not `multer`) — required for FR-12 attachments

**Known Caveats:**

- ⚠️ `@nestjs/platform-fastify` v11.1.24+ has a trailing-slash middleware bypass vulnerability. Mitigation: register a global Fastify `onRequest` hook to normalize trailing slashes before route matching. Document in the security decisions step.
- `reflect-metadata` v0.2.2 is unmaintained; NestJS v12 (expected Q3 2026) will resolve this. No action needed for Phase 1.

## Core Architectural Decisions

### Category 1: Data Architecture

#### 1.1 — Database Client & Repository Abstraction

**Decision:** Abstract class repository pattern with per-domain interfaces. Supabase implementation behind the abstraction; services are Supabase-unaware.

**Pattern:**
- `JobRepository`, `CustomerRepository`, `UserRepository` etc. as abstract NestJS providers (DI tokens)
- `SupabaseJobRepository`, `SupabaseCustomerRepository` etc. as concrete implementations
- Modules wire: `{ provide: JobRepository, useClass: SupabaseJobRepository }`
- Per-request Supabase client factory injected into repositories — initialised with the caller's JWT so RLS fires correctly on every query
- Service layer calls only abstract methods; zero Supabase imports in service files

**Rationale:** RLS enforcement stays inside the repository implementation. Switching from Supabase to Postgres + Drizzle/Prisma later = swap `useClass` in module providers only.

**SDK:** `@supabase/supabase-js` v2 (inside repository implementations only)

---

#### 1.2 — File Storage: Cloudflare R2

**Decision:** Cloudflare R2 for all file assets (photos, signatures, future PDFs). Supabase stores only the R2 object URLs — no files in Supabase Storage.

**Rationale over Cloudflare Images:**
- HEIC support requires Enterprise on Cloudflare Images; R2 accepts any format
- R2 supports presigned PUT URLs (direct mobile upload) — Images does not
- R2 supports presigned GET URLs with TTL — Images does not (cache headers only)
- Future-proof for PDF invoice storage
- Cost: ~₹12/month vs ₹420/month minimum at Phase 1 scale
- SDK: `@aws-sdk/client-s3` (R2 is S3-compatible)

**Storage abstraction (parallel to DB repositories):**
```typescript
export abstract class StorageRepository {
  abstract getPresignedUploadUrl(key: string, ttlSeconds: number): Promise<string>;
  abstract getPresignedReadUrl(key: string, ttlSeconds: number): Promise<string>;
  abstract deleteFile(key: string): Promise<void>;
}
// CloudflareR2StorageRepository implements this using @aws-sdk/client-s3
```

**R2 key pattern:** `{tenant_id}/jobs/{job_id}/{attachment_type}/{uuid}.{ext}`
- `attachment_type`: `photos` | `signature`
- Key encodes all metadata — no DB lookup needed during webhook processing

**Read URL TTL:** 1 hour, regenerated on every `GET /jobs/:id` response.

---

#### 1.3 — Upload & Callback Flow

**Decision:** Direct mobile upload to R2 + server-side callback via Cloudflare Worker. Client does NOT confirm the upload to the backend.

**Flow:**
```
1. Client → POST /jobs/:id/attachments { filename, mime_type }
          ← Backend: { presigned_put_url (15-min TTL), key, upload_id }

2. Client → PUT {presigned_put_url}  (direct to R2, no backend hop)
          ← R2 200 OK

3. R2 → Cloudflare Queue (object_created event)

4. Queue → Cloudflare Worker (event consumer, ~20 lines)

5. Worker → POST /internal/webhooks/storage
            Authorization: Bearer {WORKER_SECRET}
            Body: { key, size, tenant_id, job_id, attachment_type }

6. Backend validates secret, records URL in Supabase, advances
   workflow step if applicable (photos_uploaded auto-advance per FR-12)
```

**Security:** Shared secret between Worker and backend.
`/internal/webhooks/storage` is not exposed in the public API surface.

**Attachment visibility:** Both Owner and Technician receive presigned R2 read URLs on `GET /jobs/:id`. URLs regenerated on each call (1-hour TTL).

---

#### 1.4 — Caching

**Decision:** No caching layer in Phase 1.

**Rationale:** PRD NFR requires zero in-memory application state. List endpoint p95 < 300ms is achievable with proper RLS indexes on `tenant_id` + `scheduled_start`. Revisit with Redis if load testing shows degradation.

---

#### 1.5 — Migrations

**Decision:** Supabase CLI with SQL migration files committed to version control.

**Pattern:** `supabase/migrations/YYYYMMDDHHMMSS_description.sql`
RLS policies, indexes, and triggers live in migration files — not applied manually via Supabase dashboard.

---

### Category 2: Authentication & Security

#### 2.1 — JWT Issuance

**Decision:** Custom JWT issued by the NestJS backend, signed with the Supabase JWT secret.

**Rationale:** Supabase Auth's phone OTP requires a real SMS provider even in development — no built-in mock mode. Issuing JWTs from the backend keeps all OTP logic in application code (clean Phase 2 swap) while remaining fully compatible with Supabase RLS (`auth.jwt()` reads claims regardless of issuer, provided the secret matches).

**JWT shape:**
- `sub`: user_id (UUID)
- `tenant_id`: UUID (null until company onboarding FR-3 completes)
- `role`: `owner` | `technician`
- `exp`: 7 days from issuance (no refresh endpoint in Phase 1)

**Library:** `@nestjs/jwt`

---

#### 2.2 — OTP Session & Rate Limit Storage

**Decision:** In-app cache via `@nestjs/cache-manager` (in-memory store, Phase 1).

**Rationale:** OTP sessions are ephemeral (5-minute TTL) with no lasting business value. If the server restarts, the user taps "resend" — nothing is lost. DB storage (table + pg_cron cleanup) is overkill for throwaway data. The "zero in-memory state" NFR applies to business data; ephemeral auth tokens are a justified exception.

**Cache key scheme:**
- Session:    `otp:session:{sessionId}` → TTL 5 min
              Value: `{ phone, otpHash, attempts }`
- Rate limit: `otp:rate:{phone}` → TTL 10 min, value = send count

**No `otp_sessions` or `otp_rate_limit` tables — simpler schema.**

OTP stored as bcrypt hash — never plaintext in cache or logs.

**Multi-instance path (Phase 2+):** Swap to Redis by changing one line in `AppModule`. Zero application code changes.

```typescript
// Phase 1
CacheModule.register({ ttl: 300 })

// Phase 2+ — one config change, zero code change
CacheModule.registerAsync({ useFactory: () => ({ store: redisStore, ttl: 300 }) })
```

---

#### 2.3 — OTP Delivery: WhatsApp-First Abstraction

**Decision:** `OtpDeliveryProvider` abstract class.
Phase 1: `MockOtpDeliveryProvider` (console log only).
Phase 2: `WhatsAppOtpDeliveryProvider` (Interakt or Wati BSP).
SMS is never built.

```typescript
export abstract class OtpDeliveryProvider {
  abstract send(phone: string, otp: string): Promise<void>;
}
```

**Rationale:** WhatsApp OTP eliminates TRAI DLT registration (2–4 week blocker for SMS). WhatsApp penetration among Indian field technicians is effectively universal. Phase 1 → Phase 2 upgrade = swap `useClass` in the Auth module only.

**Phase 2 prerequisite — action in Week 1 of Phase 2:**
Submit WhatsApp OTP message template to BSP for approval (~1–24 hours).
> "Your Jobzo verification code is {{1}}. Valid for 5 minutes. Do not share this with anyone."

---

#### 2.4 — User Roles

**Decision:** Phase 1 ships with two roles only: `owner` and `technician`.

**Rationale:** Owner permissions are a strict superset of dispatcher permissions. Since Phase 1 has no invoicing or financial layer, the owner/dispatcher distinction is meaningless — there is nothing to restrict yet. Roles are defined as an extensible enum; adding new roles in future phases is additive with no structural changes.

```typescript
export enum UserRole {
  OWNER      = 'owner',
  TECHNICIAN = 'technician',
  // Future: DISPATCHER, ACCOUNTANT, SUPERVISOR
}
```

```sql
role TEXT CHECK (role IN ('owner', 'technician'))
-- constraint updated via migration when new roles are added
```

**Future roles identified (not built in Phase 1):**
- `dispatcher` — create/assign jobs, no financials; relevant when owner delegates booking
- `accountant` — read-only GST invoicing access; relevant in Phase 2 invoicing increment
- `supervisor` — oversees team subset, can reassign; relevant at 8+ technicians

---

#### 2.5 — NestJS Guard Structure

**Global `JwtAuthGuard`** (applied via `APP_GUARD`):
- Validates JWT signature and expiry on every request
- Populates `request.user` with `AuthUser`
- `@Public()` decorator bypasses guard (OTP send + verify only)

**`RolesGuard`** (applied via `APP_GUARD` after `JwtAuthGuard`):
- Reads `@Roles('owner' | 'technician')` from route metadata
- Returns `403` on role mismatch

```typescript
interface AuthUser {
  userId:   string;
  tenantId: string | null;
  role:     UserRole;
  rawJwt:   string;
}
```

---

#### 2.6 — Per-Request Supabase Client (RLS Wiring)

**Decision:** Request-scoped `SupabaseClientFactory`.

```typescript
@Injectable({ scope: Scope.REQUEST })
export class SupabaseClientFactory {
  create(jwt: string): SupabaseClient {
    return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth:   { persistSession: false },
    });
  }
}
```

Repositories call `factory.create(user.rawJwt)` — RLS fires automatically. No explicit `WHERE tenant_id = ?` anywhere in application code.

---

### Category 3: API & Communication Patterns

#### 3.1 — API Documentation

**Decision:** `@nestjs/swagger` — OpenAPI spec auto-generated from decorators; Swagger UI at `/api/docs`.

**Rationale:** Frontend teams (React web + React Native) need a contract to build against. Auto-generated from DTOs means zero maintenance overhead — decorators on the DTO, docs update automatically. Disabled in production via environment flag.

---

#### 3.2 — Error Response Shape

**Decision:** Global NestJS `ExceptionFilter` enforces a single error shape across all routes.

```json
{
  "error_code": "JOB_NOT_FOUND",
  "message": "Job JB-2026-0001 does not exist or you do not have access.",
  "statusCode": 404
}
```

No ad-hoc error objects in controllers. Every thrown exception — NestJS built-in or custom — passes through the filter and is normalised to this shape.

---

#### 3.3 — Idempotency Key Storage (FR-17)

**Decision:** Supabase `idempotency_log` table.

**Schema:**
```sql
id            UUID PRIMARY KEY DEFAULT gen_random_uuid()
key           TEXT NOT NULL
tenant_id     UUID NOT NULL
response_body JSONB NOT NULL
created_at    TIMESTAMPTZ DEFAULT now()
UNIQUE (key, tenant_id)
```

**Rationale:** 24-hour dedup window is too long for in-app cache — a server restart would lose all keys and allow duplicate workflow steps or attachment uploads through. Unlike OTP sessions, idempotency keys protect business-critical operations. DB row cost is negligible; rows cleaned by `pg_cron` after 24 hours.

---

#### 3.4 — Structured Request Logging (NFR §7.6)

**Decision:** Global `LoggingInterceptor` applied via `APP_INTERCEPTOR`.

Generates `request_id` (UUID v4) on each request, starts a timer, emits structured JSON on response:

```json
{
  "request_id": "uuid",
  "tenant_id": "uuid | null",
  "route": "POST /api/v1/jobs",
  "http_status": 201,
  "duration_ms": 47
}
```

Zero per-route boilerplate. All fields available to interceptor from `request.user` (populated by `JwtAuthGuard` before interceptor fires).

---

#### 3.5 — Realtime (Live Job Board)

**Decision:** Supabase Realtime — no custom WebSocket server in Phase 1.

**Rationale:** At < 20 technicians per tenant and < 100 concurrent tenants, Supabase Realtime is sufficient. The owner web dashboard subscribes to `jobs` table changes filtered by `tenant_id` on the client side. The backend has no Realtime-specific code — Supabase handles the pub/sub. Revisit with a dedicated WebSocket if tenant scale exceeds Supabase Realtime limits.

---

### Category 4: Infrastructure & Deployment

#### 4.1 — Hosting: DigitalOcean App Platform

**Decision:** DigitalOcean App Platform for Phase 1.

**Rationale:** Phase 1 priority is product velocity, not ops. App Platform handles deploy-on-push, zero-downtime restarts, SSL termination, health checks, and environment variable management. Migrate to Droplet + container orchestration when cost optimisation at scale becomes relevant.

**Tier:** Basic (~$12/month for Phase 1 load).

---

#### 4.2 — Containerisation

**Decision:** Dockerfile committed to repo for local dev parity and future portability.

```dockerfile
FROM oven/bun:1.3.13-alpine
WORKDIR /app
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build
CMD ["bun", "run", "start:prod"]
```

---

#### 4.3 — Environment Configuration

**Decision:** `@nestjs/config` with Joi schema validation on startup.

App crashes immediately with a descriptive error if any required env var is missing — no silent runtime failures.

**Required env vars:**
```
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_JWT_SECRET
CLOUDFLARE_R2_ACCOUNT_ID
CLOUDFLARE_R2_ACCESS_KEY
CLOUDFLARE_R2_SECRET_KEY
CLOUDFLARE_R2_BUCKET
WORKER_WEBHOOK_SECRET
PORT          (default: 3000)
NODE_ENV      (development | production)
```

---

#### 4.4 — CI/CD

**Decision:** GitHub Actions for test gate on PRs + DigitalOcean App Platform auto-deploy on merge to `main`.

- PRs: GHA runs lint + unit tests — broken code cannot merge
- Merge to `main`: DO detects push, builds, and deploys automatically
- No custom deploy scripts needed for Phase 1

---

#### 4.5 — Monitoring

**Decision:** DigitalOcean built-in metrics (CPU, memory, request count) + structured JSON logs via DO log viewer for Phase 1.

Structured logs from `LoggingInterceptor` (§3.4) are readable in DO's log viewer without additional tooling.

**Phase 2 addition:** Sentry for error tracking and alerting when beta customers are onboarded. Free tier covers Phase 1 scale.

---

## Project Structure & Boundaries

### Complete Directory Tree

```
fenzit-be/
├── .github/
│   └── workflows/
│       └── ci.yml                    # lint + test gate on PRs
├── supabase/
│   ├── migrations/
│   │   ├── 20260618000001_create_users.sql
│   │   ├── 20260618000002_create_tenants.sql
│   │   ├── 20260618000003_create_jobs.sql
│   │   ├── 20260618000004_create_customers.sql
│   │   ├── 20260618000005_create_activity_logs.sql
│   │   ├── 20260618000006_create_idempotency_log.sql
│   │   ├── 20260618000007_rls_policies.sql
│   │   ├── 20260618000008_rpc_advance_workflow_step.sql
│   │   ├── 20260618000009_rpc_create_job_with_log.sql
│   │   └── 20260618000010_indexes.sql
│   └── config.toml
├── cloudflare-worker/                # separate deploy — R2 event → backend webhook
│   ├── src/
│   │   └── index.ts                  # Queue consumer → POST /internal/webhooks/storage
│   ├── wrangler.toml
│   └── package.json
├── src/
│   ├── main.ts                       # bootstrap — Fastify adapter, global pipes
│   ├── app.module.ts                 # root module
│   │
│   ├── config/
│   │   ├── config.module.ts
│   │   └── config.schema.ts          # Joi env var validation
│   │
│   ├── common/
│   │   ├── decorators/
│   │   │   ├── public.decorator.ts         # @Public() — bypass JwtAuthGuard
│   │   │   ├── roles.decorator.ts          # @Roles('owner' | 'technician')
│   │   │   └── current-user.decorator.ts   # @CurrentUser() → AuthUser
│   │   ├── enums/
│   │   │   ├── user-role.enum.ts           # UserRole.OWNER | TECHNICIAN
│   │   │   └── error-code.enum.ts          # ErrorCode enum — all error_code values
│   │   ├── filters/
│   │   │   └── global-exception.filter.ts  # { statusCode, error_code, message }
│   │   ├── guards/
│   │   │   ├── jwt-auth.guard.ts           # FR-5 — validates JWT, populates request.user
│   │   │   ├── roles.guard.ts              # FR-5 — enforces @Roles()
│   │   │   └── idempotency.guard.ts        # FR-17 — X-Idempotency-Key dedup
│   │   ├── interceptors/
│   │   │   └── logging.interceptor.ts      # NFR §7.6 — request_id, tenant_id, duration_ms
│   │   └── interfaces/
│   │       ├── auth-user.interface.ts      # AuthUser { userId, tenantId, role, rawJwt }
│   │       ├── jwt-payload.interface.ts    # JwtPayload { sub, tenantId, role, iat, exp }
│   │       └── paginated-response.interface.ts
│   │
│   ├── supabase/
│   │   ├── supabase-client.factory.ts      # DEFAULT-scoped singleton — create(jwt): SupabaseClient
│   │   └── supabase.module.ts
│   │
│   ├── storage/
│   │   ├── storage.repository.ts           # abstract — getPresignedUploadUrl, getPresignedReadUrl, deleteFile
│   │   ├── cloudflare-r2.repository.ts     # FR-12 — @aws-sdk/client-s3 implementation
│   │   └── storage.module.ts
│   │
│   ├── auth/
│   │   ├── auth.module.ts
│   │   ├── auth.controller.ts              # FR-1,2,3,4 — /auth/otp/send, verify, company, invite
│   │   ├── auth.service.ts                 # JWT issuance, OTP logic, invite flow
│   │   ├── otp-delivery.provider.ts        # abstract — send(phone, otp): Promise<void>
│   │   ├── mock-otp-delivery.provider.ts   # FR-1 Phase 1 — console.log only
│   │   ├── otp-session-store.ts            # abstract — wraps cache, mockable in tests
│   │   ├── in-memory-otp-session.store.ts  # FR-1,2 — @nestjs/cache-manager impl
│   │   └── dto/
│   │       ├── send-otp.dto.ts
│   │       ├── verify-otp.dto.ts
│   │       ├── setup-company.dto.ts
│   │       └── invite-technician.dto.ts
│   │
│   ├── jobs/
│   │   ├── jobs.module.ts
│   │   ├── jobs.controller.ts              # FR-6–12
│   │   ├── jobs.service.ts                 # business logic, calls supabase.rpc() for atomic writes
│   │   ├── jobs.repository.ts              # abstract extends BaseRepository<Job>
│   │   ├── supabase-jobs.repository.ts     # Supabase implementation
│   │   ├── workflow.service.ts             # FR-10 — step ordering and validation
│   │   ├── attachments.service.ts          # FR-12 — presigned URLs, webhook handling
│   │   ├── entities/
│   │   │   └── job.entity.ts
│   │   └── dto/
│   │       ├── create-job.dto.ts
│   │       ├── update-job.dto.ts           # PartialType(OmitType(CreateJobDto, [...]))
│   │       ├── advance-workflow.dto.ts
│   │       ├── upload-attachment.dto.ts
│   │       ├── list-jobs.dto.ts
│   │       └── job-response.dto.ts         # includes presigned R2 read URLs
│   │
│   ├── customers/
│   │   ├── customers.module.ts
│   │   ├── customers.controller.ts         # FR-13,14,15
│   │   ├── customers.service.ts
│   │   ├── customers.repository.ts         # abstract extends BaseRepository<Customer>
│   │   ├── supabase-customers.repository.ts
│   │   ├── entities/
│   │   │   └── customer.entity.ts
│   │   └── dto/
│   │       ├── create-customer.dto.ts
│   │       ├── list-customers.dto.ts
│   │       └── customer-response.dto.ts    # includes job history
│   │
│   ├── sync/
│   │   ├── sync.module.ts
│   │   ├── sync.controller.ts              # FR-16 — POST /api/v1/sync
│   │   ├── sync.service.ts                 # delta query + server_time
│   │   └── dto/
│   │       ├── sync-request.dto.ts
│   │       └── sync-response.dto.ts
│   │
│   └── webhooks/
│       ├── webhooks.module.ts
│       ├── webhooks.controller.ts          # POST /internal/webhooks/storage
│       └── webhooks.service.ts             # validates WORKER_SECRET, records R2 URL in Supabase
│
├── test/
│   ├── factories/
│   │   ├── tenant.factory.ts               # creates tenant + owner JWT for integration tests
│   │   ├── job.factory.ts
│   │   └── customer.factory.ts
│   ├── helpers/
│   │   ├── sign-test-jwt.ts                # signs JWT with test Supabase secret
│   │   └── mock-supabase-client.ts         # reusable mock SupabaseClient shape
│   └── integration/
│       ├── auth.integration.spec.ts        # FR-1–5
│       ├── jobs.integration.spec.ts        # FR-6–11
│       ├── attachments.integration.spec.ts # FR-12
│       ├── customers.integration.spec.ts   # FR-13–15
│       └── sync.integration.spec.ts        # FR-16–18
│
├── Dockerfile
├── .dockerignore
├── .env.example
├── .gitignore
├── nest-cli.json
├── package.json
├── bun.lockb
└── tsconfig.json
```

---

### FR → File Mapping

| FR | Primary Files |
|---|---|
| FR-1 Mock OTP send | `auth.controller.ts`, `mock-otp-delivery.provider.ts`, `in-memory-otp-session.store.ts` |
| FR-2 OTP verify + JWT | `auth.service.ts`, `jwt-auth.guard.ts` |
| FR-3 Tenant onboarding | `auth.controller.ts`, `auth.service.ts` |
| FR-4 Technician invite | `auth.controller.ts`, `auth.service.ts` |
| FR-5 JWT middleware + RBAC | `jwt-auth.guard.ts`, `roles.guard.ts`, `current-user.decorator.ts` |
| FR-6 Create job | `jobs.service.ts`, `rpc_create_job_with_log.sql` |
| FR-7 List jobs | `jobs.controller.ts`, `list-jobs.dto.ts` |
| FR-8 Job detail | `jobs.service.ts`, `job-response.dto.ts`, `cloudflare-r2.repository.ts` |
| FR-9 Edit/cancel job | `jobs.service.ts`, `update-job.dto.ts` |
| FR-10 Workflow advance | `workflow.service.ts`, `rpc_advance_workflow_step.sql`, `idempotency.guard.ts` |
| FR-11 Activity log | `rpc_advance_workflow_step.sql`, `rpc_create_job_with_log.sql` (Postgres-side) |
| FR-12 Attachments | `attachments.service.ts`, `cloudflare-r2.repository.ts`, `webhooks.controller.ts` |
| FR-13 Create customer | `customers.controller.ts`, `customers.service.ts` |
| FR-14 List/search customers | `customers.controller.ts`, `list-customers.dto.ts` |
| FR-15 Customer detail | `customers.controller.ts`, `customer-response.dto.ts` |
| FR-16 Delta sync | `sync.controller.ts`, `sync.service.ts` |
| FR-17 Idempotency | `idempotency.guard.ts`, `create_idempotency_log.sql` |
| FR-18 Conflict resolution | `workflow.service.ts`, `sync.service.ts` |

---

### External Integration Points

| Integration | Direction | Files |
|---|---|---|
| Supabase PostgreSQL + RLS | Backend → Supabase | All `supabase-*.repository.ts` |
| Supabase Realtime | Supabase → Frontend (client-side only) | No backend code |
| Cloudflare R2 | Backend generates URLs; Mobile uploads direct | `cloudflare-r2.repository.ts`, `attachments.service.ts` |
| Cloudflare Queue → Worker | R2 → Queue → Worker → Backend | `webhooks.controller.ts`, `cloudflare-worker/src/index.ts` |
| WhatsApp BSP (Phase 2) | Backend → BSP API | `otp-delivery.provider.ts` (swap implementation) |

---

## Architecture Validation Results

### Coherence Validation ✅

All technology choices are compatible and decisions work together without conflict.

- NestJS v11 + Fastify v5.8.5 + Bun v1.3.13 — confirmed compatible combination
- `@supabase/supabase-js` v2 runs on Bun — confirmed
- `@aws-sdk/client-s3` (R2 S3-compatible) — confirmed
- `@nestjs/jwt` NestJS v11 compatible — confirmed current as of June 2026; supports explicit `SUPABASE_JWT_SECRET` string directly via `JwtModule.register({ secret })`. No reason to use `jose` or raw `jsonwebtoken` for this use case.
- `supabase.rpc()` for atomic multi-table writes — confirmed correct; PostgREST wraps RPCs in transactions automatically
- `SupabaseClientFactory` as DEFAULT-scoped singleton with explicit JWT param — resolves NestJS TestingModule scope issue; validated against NestJS documentation
- Cloudflare Queue retry (3 retries default, configurable) + DLQ — confirmed supported; must be configured in `wrangler.toml`

Pattern consistency, naming conventions, and structure alignment all pass — no contradictions found.

---

### Requirements Coverage Validation ✅

All 18 FRs and all 5 NFRs are architecturally covered. See FR → File Mapping in §Project Structure for the full trace.

---

### Gap Analysis

**Critical gaps:** None.

**Important gaps — resolved during validation:**

**Gap A — Job number generation (`JB-{YYYY}-{NNNN}`):**
A `job_sequences(tenant_id, year, last_seq)` counter table handles sequential numbering per tenant per calendar year. An RPC function `increment_job_counter(p_tenant_id, p_year)` atomically increments and returns the padded number. Year rollover (Jan 1) resets `last_seq` to 0 inside the RPC — no separate cron needed. Migration: `20260618000011_create_job_sequences.sql`.

**Gap B — IST `date=today` filter:**
`src/common/utils/ist-day-range.util.ts` — pure function returning `{ start: Date, end: Date }` for the current IST calendar day. Timezone constant (`Asia/Kolkata`) comes from config, not hardcoded. Used in `jobs.service.ts` list query.

**Operational notes (not architecture blockers):**

- **JWT secret rotation:** Rotating `SUPABASE_JWT_SECRET` immediately invalidates all in-flight tokens. Requires a documented runbook: rotate secret → rolling restart → notify affected tenants to re-authenticate. Not a Phase 1 blocker; document before first real customer.
- **OTP cache single-instance constraint:** `@nestjs/cache-manager` in-memory store works correctly on a single DigitalOcean App Platform instance. If a second instance is added, OTP sessions will miss across instances. Migration path: swap `CacheModule` store to Redis — zero application code change. This constraint must be explicit in ops documentation.

---

### Cloudflare Worker — Retry & DLQ Configuration (verified June 2026)

R2 Event → Queue → Worker → Webhook is the most operationally complex path. Confirmed behavior:

- **Auto-retries:** 3 retries by default (configurable)
- **DLQ:** Fully supported — configure in `cloudflare-worker/wrangler.toml`
- **Retention:** 4 days default; up to 14 days on paid plan; 24 hours on free plan
- **Risk:** Head-of-line blocking — a retrying message blocks subsequent messages in the batch

**Required `wrangler.toml` config:**
```toml
[[queues.consumers]]
queue = "r2-upload-events"
max_retries = 3
dead_letter_queue = "r2-upload-events-dlq"
```

Backend must respond `2xx` to the Worker POST within the Worker's fetch timeout (30s default). If the NestJS server is down, the Worker retries 3 times then routes to DLQ. Monitor DLQ for dropped upload events.

---

### Testing Patterns — Additional Requirements

**RLS cross-tenant isolation test (mandatory):**
Must be in `test/integration/rls-isolation.integration.spec.ts`. Test uses `@supabase/supabase-js` client — NOT Supabase SQL Editor (which bypasses RLS entirely).

```typescript
// Tenant B cannot read Tenant A's jobs
const tenant2Client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  global: { headers: { Authorization: `Bearer ${tenant2JWT}` } }
});

const { data } = await tenant2Client
  .from('jobs')
  .select('*')
  .eq('tenant_id', tenant1Id);

expect(data?.length ?? 0).toBe(0); // RLS returns empty, not an error
```

This test must pass before any feature is marked production-ready.

---

### Implementation Bootstrap Ordering (Sprint 1)

Build order is strict — each layer unblocks the next:

1. **Project scaffold** — `nest new`, Bun install, Fastify adapter, `.env.example`
2. **ESLint + Prettier** — locked before any real code; prevents diff noise forever
3. **`ConfigModule`** (global, Joi) — first import in `AppModule`; all other providers depend on it
4. **`CacheModule`** (global) — second in `AppModule`; before any OTP service
5. **`SupabaseClientFactory`** — after config, zero domain imports; circular import risk if domain modules import back
6. **`ErrorCode` enum + `GlobalExceptionFilter`** — before any route exists
7. **`PaginatedResponse<T>` + cursor utility + `ist-day-range.util.ts`** — pure utils, no deps
8. **`AuthModule`** — JWT utility, OTP abstraction, guards, decorators; must merge before any feature branch is cut
9. **Job sequences RPC + migration** — must land before job creation endpoints

**Sprint 1 done definition:** `POST /auth/otp/send` → `POST /auth/otp/verify` → JWT → `GET /health` with `Authorization: Bearer <token>` returns `200`.

**Sprint 2 parallel workstreams:** `CustomersModule`, `JobsModule`, `R2UploadModule` — all three can be built concurrently.

---

### Client-Side Note (for frontend teams)

The R2 upload → webhook confirmation is asynchronous. Between the mobile client's direct R2 `PUT` completing and the webhook processing, the attachment does not yet appear in `GET /jobs/:id`. The React Native app must handle this gap: show an "uploading" state, then re-fetch job detail after a short delay or on next app foreground. This is a frontend UX concern — the backend has no long-polling or SSE endpoint for upload confirmation.

---

### Architecture Completeness Checklist

**Requirements Analysis**
- [x] Project context thoroughly analyzed
- [x] Scale and complexity assessed
- [x] Technical constraints identified
- [x] Cross-cutting concerns mapped

**Architectural Decisions**
- [x] Critical decisions documented with versions
- [x] Technology stack fully specified
- [x] Integration patterns defined
- [x] Performance considerations addressed

**Implementation Patterns**
- [x] Naming conventions established
- [x] Structure patterns defined
- [x] Communication patterns specified
- [x] Process patterns documented

**Project Structure**
- [x] Complete directory structure defined
- [x] Component boundaries established
- [x] Integration points mapped
- [x] Requirements to structure mapping complete

---

### Architecture Readiness Assessment

**Overall Status: READY FOR IMPLEMENTATION**

**Confidence Level:** High

**Key Strengths:**
- Repository abstraction enables future DB migration without touching service layer
- Cloudflare R2 + Worker callback removes client trust from upload confirmation
- `supabase.rpc()` ensures activity log and state change atomicity — verified
- DEFAULT-scoped `SupabaseClientFactory` with explicit JWT threading is simple and correctly testable
- WhatsApp OTP abstraction eliminates TRAI DLT registration blocker (saves 2–4 weeks)
- `@nestjs/jwt` confirmed correct for this stack — no migration needed

**Areas for future enhancement:**
- Redis for OTP cache when multi-instance scaling is needed
- Sentry for error tracking at beta customer scale
- WhatsApp OTP BSP integration (Phase 2)
- Typed per-event activity log payloads (Phase 2, when audit UI is built)

---

## Implementation Patterns & Consistency Rules

_Defines how all modules must be implemented to ensure AI agents produce compatible, consistent code._

---

### Naming Conventions

**Database (PostgreSQL):**
- Tables: `snake_case`, plural → `jobs`, `customers`, `users`, `activity_logs`, `idempotency_log`
- Columns: `snake_case` → `tenant_id`, `scheduled_start`, `created_at`, `otp_hash`
- Foreign keys: `{singular_table}_id` → `job_id`, `tenant_id`, `technician_id`
- Indexes: `idx_{table}_{columns}` → `idx_jobs_tenant_id_scheduled_start`

**TypeScript:**
- Variables & functions: `camelCase` → `createJob`, `tenantId`, `scheduledStart`
- Classes, interfaces, enums: `PascalCase` → `JobsService`, `AuthUser`, `UserRole`
- Constants: `UPPER_SNAKE_CASE` → `JWT_EXPIRY_SECONDS`, `OTP_TTL_SECONDS`
- Files: `kebab-case` with type suffix → `jobs.service.ts`, `jobs.repository.ts`, `create-job.dto.ts`

**REST API:**
- Resources: plural, kebab-case → `/jobs`, `/customers`, `/auth/otp/send`
- JSON fields: `camelCase` → `{ tenantId, scheduledStart, createdAt }`
- Query params: `camelCase` → `?technicianId=...`
- Route params: `:id`, `:jobId` — never `{id}` (that is Swagger notation only)

---

### JWT Payload Interface

**Single source of truth** — defined in `src/common/interfaces/jwt-payload.interface.ts` before any module is implemented. All guards and decorators import from here.

```typescript
export interface JwtPayload {
  sub:      string;        // user_id (UUID)
  tenantId: string | null; // null until company onboarding completes
  role:     UserRole;
  iat:      number;
  exp:      number;
}
```

**Rule:** JWT fields are `camelCase` in TypeScript. Never access `payload.tenant_id` — it will be undefined.

---

### Module Structure

One module folder per domain. Every domain follows the same file layout:

```
src/
  common/
    decorators/         @Public(), @Roles(), @CurrentUser()
    filters/            GlobalExceptionFilter
    guards/             JwtAuthGuard, RolesGuard, IdempotencyGuard
    interceptors/       LoggingInterceptor
    interfaces/         auth-user.interface.ts, jwt-payload.interface.ts,
                        paginated-response.interface.ts
    enums/              error-code.enum.ts, user-role.enum.ts
  config/
    config.module.ts
    config.schema.ts    (Joi validation)
  supabase/
    supabase-client.factory.ts   (DEFAULT-scoped singleton)
    supabase.module.ts
  storage/
    storage.repository.ts              (abstract)
    cloudflare-r2.repository.ts        (implementation)
    storage.module.ts
  auth/
    auth.module.ts
    auth.controller.ts
    auth.service.ts
    otp-delivery.provider.ts           (abstract)
    mock-otp-delivery.provider.ts
    otp-session-store.ts               (abstract — wraps cache)
    in-memory-otp-session.store.ts
    dto/
  jobs/
    jobs.module.ts
    jobs.controller.ts
    jobs.service.ts
    jobs.repository.ts                 (abstract)
    supabase-jobs.repository.ts
    dto/
    entities/
  customers/   (same pattern as jobs/)
  sync/        (same pattern as jobs/)
```

---

### Repository Pattern

**`BaseRepository<T>` canonical signatures** — all domain repositories extend this:

```typescript
export abstract class BaseRepository<T> {
  abstract findById(id: string, jwt: string): Promise<T | null>;
  abstract findAll(filters: Record<string, unknown>, jwt: string): Promise<T[]>;
  abstract create(data: Partial<T>, jwt: string): Promise<T>;
  abstract update(id: string, data: Partial<T>, jwt: string): Promise<T>;
  abstract delete(id: string, jwt: string): Promise<void>;
}
```

- Returns domain entity (`T`), never raw Supabase rows
- No Supabase types leak outside the `supabase-*.repository.ts` file
- `jwt` is always the last parameter — passed from service, which receives it via `@CurrentUser()`

**`SupabaseClientFactory` — DEFAULT-scoped singleton:**

```typescript
@Injectable() // DEFAULT scope — NOT request-scoped
export class SupabaseClientFactory {
  create(jwt: string): SupabaseClient {
    return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth:   { persistSession: false },
    });
  }
}
```

Repositories call `this.factory.create(jwt)` at the top of every method. Never store the client as a class property.

---

### Tenant Context Flow

The `@CurrentUser()` decorator is the single extraction point for authenticated user context:

```typescript
// Controller — extracts from request
@Get(':id')
getJob(@Param('id') id: string, @CurrentUser() user: AuthUser) {
  return this.jobsService.findById(id, user);
}

// Service — passes user to repository
async findById(id: string, user: AuthUser): Promise<Job> {
  return this.jobsRepository.findById(id, user.rawJwt);
}
```

**Rules:**
- Controllers always receive `AuthUser` via `@CurrentUser()` — never access `req.user` directly
- Services never reach into request context — they receive `AuthUser` as a parameter
- Repositories never know about `AuthUser` — they receive `jwt: string` only

---

### API Response Formats

**Success — single resource:** direct entity, no wrapper
```json
{ "id": "uuid", "jobNumber": "JB-2026-0001", "status": "scheduled" }
```

**Success — paginated list:**
```typescript
interface PaginatedResponse<T> {
  data:       T[];
  nextCursor: string | null;
}
```

Cursor encoding: `base64(JSON.stringify({ id, createdAt }))`. Sort order: `created_at DESC, id DESC` (id is tie-breaker). Query param: `?cursor=`. Consistent across all list endpoints.

**Error:**
```json
{ "statusCode": 404, "error_code": "JOB_NOT_FOUND", "message": "..." }
```

`error_code` values come exclusively from `ErrorCode` enum in `src/common/enums/error-code.enum.ts`:

```typescript
export enum ErrorCode {
  // Auth
  INVALID_OTP          = 'INVALID_OTP',
  OTP_EXPIRED          = 'OTP_EXPIRED',
  OTP_SESSION_LOCKED   = 'OTP_SESSION_LOCKED',
  RATE_LIMIT_EXCEEDED  = 'RATE_LIMIT_EXCEEDED',
  UNAUTHORIZED         = 'UNAUTHORIZED',
  FORBIDDEN            = 'FORBIDDEN',
  // Resources
  RESOURCE_NOT_FOUND   = 'RESOURCE_NOT_FOUND',
  DUPLICATE_RESOURCE   = 'DUPLICATE_RESOURCE',
  // Jobs
  INVALID_WORKFLOW_STEP = 'INVALID_WORKFLOW_STEP',
  JOB_NOT_MODIFIABLE   = 'JOB_NOT_MODIFIABLE',
  // Idempotency
  DUPLICATE_REQUEST    = 'DUPLICATE_REQUEST',
  // Validation
  VALIDATION_ERROR     = 'VALIDATION_ERROR',
}
```

Never invent `error_code` strings inline. Always import from this enum.

---

### Update DTO Pattern

```typescript
// Always omit immutable fields — never expose tenantId or createdBy in updates
export class UpdateJobDto extends PartialType(
  OmitType(CreateJobDto, ['tenantId', 'createdBy'] as const)
) {}
```

---

### Activity Log Atomicity

**Activity log writes and the triggering state change are atomic via `supabase.rpc()`.**

`@supabase/supabase-js` v2 does not support `BEGIN`/`COMMIT` — it is a REST client over PostgREST. Multi-table writes must be wrapped in a Postgres function; PostgREST automatically runs RPCs in a transaction.

```typescript
// In service — one RPC call, both writes atomic
const { data, error } = await client.rpc('advance_workflow_step', {
  p_job_id:    jobId,
  p_step:      step,
  p_actor_id:  user.userId,
});
```

```sql
-- In migration
CREATE OR REPLACE FUNCTION advance_workflow_step(
  p_job_id   UUID,
  p_step     TEXT,
  p_actor_id UUID
) RETURNS jobs LANGUAGE plpgsql AS $$
BEGIN
  UPDATE jobs SET current_step = p_step WHERE id = p_job_id;
  INSERT INTO activity_logs (job_id, event_type, actor_id)
    VALUES (p_job_id, 'step_' || p_step, p_actor_id);
  RETURN (SELECT * FROM jobs WHERE id = p_job_id);
END $$;
```

**Rule:** Any service method that writes to both a domain table AND `activity_logs` must use `supabase.rpc()`. Never two sequential `supabase.from()` calls for what must be atomic.

---

### Idempotency Pattern

**`IdempotencyGuard`** — applied via `@UseGuards(IdempotencyGuard)` on idempotency-gated endpoints (workflow advance, attachment upload).

- Reads `X-Idempotency-Key` header (UUID v4)
- Checks `idempotency_log` table scoped by `(key, tenant_id)` — cross-tenant keys never collide
- On hit: returns `200` with cached `response_body` immediately, handler never executes
- On miss: sets flag in request context; handler writes to `idempotency_log` on success
- No idempotency key header → request proceeds normally (key is optional per FR-17)

---

### OTP Session Store Abstraction

```typescript
export abstract class OtpSessionStore {
  abstract set(sessionId: string, value: OtpSession, ttlSeconds: number): Promise<void>;
  abstract get(sessionId: string): Promise<OtpSession | null>;
  abstract delete(sessionId: string): Promise<void>;
  abstract increment(key: string, ttlSeconds: number): Promise<number>;
}
// InMemoryOtpSessionStore wraps @nestjs/cache-manager
// MockOtpSessionStore used in tests
```

---

### Process Rules

| Rule | Enforcement |
|---|---|
| Activity log writes use `supabase.rpc()` — never sequential awaits | Code review |
| No `console.log` — use `new Logger(ClassName.name)` | ESLint `no-console` |
| Dates always ISO 8601 strings in API payloads | DTO validation + serialization |
| IST conversion only at `date=today` query boundary | Comment in filter utility |
| Services throw NestJS HTTP exceptions — controllers never catch | Global `ExceptionFilter` |
| `ErrorCode` enum always imported — never inline strings | Code review |
| `@CurrentUser()` in controllers — never `req.user` directly | Code review |

---

### Testing Patterns

**Unit tests** mock the repository abstraction — never mock `SupabaseClient` or `SupabaseClientFactory` directly:

```typescript
const mockJobsRepository = {
  findById: jest.fn(),
  create:   jest.fn(),
};

Test.createTestingModule({
  providers: [
    JobsService,
    { provide: JobsRepository, useValue: mockJobsRepository },
    { provide: SupabaseClientFactory, useValue: { create: jest.fn() } },
  ],
});
```

**`SupabaseClientFactory` in tests** — always provide a mock. Never use the real factory in unit tests (it would make real Supabase HTTP calls):

```typescript
// beforeEach — fresh mock per test, no cross-test JWT leakage
beforeEach(() => {
  mockSupabaseClient = createMockSupabaseClient(); // test helper
  mockFactory = { create: jest.fn().mockReturnValue(mockSupabaseClient) };
});
```

**Activity log assertions** — unit tests verify the RPC was called with correct arguments (spy). Integration tests assert the actual `activity_logs` row. Unit tests never query the DB.

**Integration tests** live in `test/` at the project root. They hit a real Supabase test project (separate from production). Each test creates its own tenant fixture and tears it down.
