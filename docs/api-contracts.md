# API Contracts — fenzit-be

All endpoints are mounted under `/api/v1` except those explicitly excluded
(see `src/main.ts`). All endpoints require a JWT **except** where marked
`[Public]`. JWTs are issued by `POST /api/v1/auth/otp/verify` and last **7 days**.

## Conventions

- **Base URL:** `/api/v1` (production: same; `setGlobalPrefix('api/v1', { exclude: ['health', 'internal/webhooks/storage'] })`)
- **Auth header:** `Authorization: Bearer <jwt>` unless `[Public]`
- **Validation:** `ValidationPipe` (whitelist=true, transform=true, `errorHttpStatusCode: 422`)
- **Errors:** Global `GlobalExceptionFilter` shapes error responses consistently.
  Note: `message` field may be a string or `string[]` (for `ValidationPipe`)
  — clients should handle both.
- **Idempotency:** `X-Idempotency-Key` (UUID v4) on selected POST endpoints
  — 24h replay window (`idempotency_log` table + `pg_cron` cleanup).
- **Pagination:** Cursor-based, page size 50 (customers, jobs). Cursor format
  is `{ id: UUID, createdAt: ISO8601 }` base64-encoded — validators enforce
  UUID + ISO charset to prevent PostgREST `.or()` injection.
- **Time:** All timestamps are UTC `TIMESTAMPTZ`; date filtering for jobs uses **IST day**
  (`src/common/utils/ist-day-range.util.ts`, timezone `Asia/Kolkata`).
- **Rate limiting:** Applied to OTP send endpoint (returns 429).

### Phase 1 mock OTP

`POST /api/v1/auth/otp/verify` accepts **any 6-digit code** — `isValid` is
hardcoded to `true`. Real verification with `bcrypt.compare` is a
**pre-launch blocker** (deferred-work.md W1).

## Auth Roles

| Role         | Can read                  | Can write                |
|--------------|---------------------------|--------------------------|
| `owner`      | All resources in tenant   | Customers, jobs, skills, invitations, company profile |
| `technician` | Jobs assigned to self, sync | Workflow advance, attachment uploads |

## Endpoints

### Health

#### `GET /health` `[Public]`

Liveness probe. No JWT required. Not under `/api/v1` prefix.

**Response 200:**
```json
{ "status": "ok" }
```

---

### Auth

#### `POST /api/v1/auth/otp/send` `[Public]`

Request an OTP for a phone number. Returns an `otp_session_id` used to verify.
OTP itself is sent via the configured SMS provider (out of scope of this API).

**Body:** `{ phone: string (E.164), countryCode: string (2 letters) }`

**Responses:**
- `200` — `{ otp_session_id: UUID, expires_at: ISO8601 }`
- `422` — Invalid phone format
- `429` — Rate limit exceeded

#### `POST /api/v1/auth/otp/verify` `[Public]`

Verify an OTP and mint a JWT. Idempotent at the OTP level (consumed OTPs are
invalid; locked sessions return 401).

**Body:** `{ otp_session_id: UUID, code: string, countryCode: string }`

**Responses:**
- `200` — `{ token: JWT, user: { userId, tenantId | null, role, name | null } }`
- `401` — Invalid/expired/locked OTP session
- `422` — Invalid OTP code format

#### `POST /api/v1/auth/invite` `[Bearer JWT, Role: owner]`

Invite a technician by phone number. Creates a `users` row with `status: invited`.

**Body:** `{ phone: string, countryCode: string, skillType: string }`

**Responses:**
- `201` — `{ invite_id: UUID }`
- `403` — Technician JWT
- `409` — Phone already an active member of this tenant
- `422` — Invalid `skillType` or phone format

#### `POST /api/v1/auth/company` `[Bearer JWT, Role: owner]`

Create or update the tenant company profile. **Idempotent upsert** — first call
returns `201`, subsequent calls return `200`. Returns a fresh JWT containing
the now-set `tenantId` claim.

**Body:** `{ company_name, gstin?, address?, state_code (^[A-Z]{2}$), service_categories: string[], upi_vpa? }`

**Responses:**
- `201` — Company created; `{ token, tenant }`
- `200` — Company updated (idempotent); `{ token, tenant }`
- `403` — Technician JWT
- `422` — Invalid GSTIN / missing `stateCode`

---

### Skills (per-tenant catalog)

#### `POST /api/v1/skills` `[Bearer JWT, Role: owner]`

Create a skill for the owner's tenant. Cascades to technicians on delete.

**Body:** `{ name: string, description?: string }`

**Responses:**
- `201` — Skill created
- `400` — Company not set up
- `403` — Technician JWT
- `409` — Duplicate skill name
- `422` — Validation error

#### `GET /api/v1/skills` `[Bearer JWT, Role: owner]`

List all skills for the owner's tenant.

**Response 200:** `{ skills: Skill[] }`

#### `DELETE /api/v1/skills/:id` `[Bearer JWT, Role: owner]`

Delete a skill. Cascades to technicians assigned this skill.

**Responses:**
- `200` — Skill deleted
- `403` — Technician JWT
- `404` — Skill not found

---

### Customers (owner only)

#### `POST /api/v1/customers` `[Bearer JWT, Role: owner]`

Create a customer for the owner's tenant. Uniqueness: `(tenant_id, phone, country_code)`.

**Body:** `{ name, phone, countryCode, address?, notes? }`

**Responses:**
- `201` — Customer created
- `400` — Company not set up
- `403` — Technician JWT
- `409` — Duplicate `(tenant_id, phone, countryCode)`
- `422` — Validation error

#### `GET /api/v1/customers` `[Bearer JWT, Role: owner]`

Cursor-paginated list & search. Page size **50**.

**Query:** `cursor?`, `limit=50`, `search?`, `countryCode?`

**Responses:**
- `200` — `{ items: Customer[], nextCursor: string | null }`
- `400` — Company not set up / malformed cursor
- `403` — Technician JWT

#### `GET /api/v1/customers/:id` `[Bearer JWT, Role: owner]`

Customer profile + paginated job history.

**Responses:**
- `200` — `{ customer: Customer, jobs: JobSummary[], nextCursor: string | null }`
- `400` — Company not set up / malformed id
- `403` — Technician JWT
- `404` — Customer not found (or in another tenant)

---

### Jobs

#### `POST /api/v1/jobs` `[Bearer JWT, Role: owner]`

Create a job for a customer and assign to a technician (who must belong to the
owner's tenant and have a skill matching the customer's category).

**Body:** `{ customer_id: UUID, technician_id: UUID, scheduled_at: ISO8601, notes? }`

**Responses:**
- `201` — Job created (`status: scheduled`)
- `400` — Company not set up
- `404` — Customer or technician not found
- `409` — Skill mismatch
- `422` — Validation error

#### `GET /api/v1/jobs` `[Bearer JWT, Role: owner | technician]`

List jobs filtered by **IST day**, status, and technician. Cursor-paginated.

- Owners see all jobs in their tenant
- Technicians see only their assigned jobs

**Query:** `date? (YYYY-MM-DD, IST day)`, `status?`, `technicianId?`, `cursor?`

**Responses:**
- `200` — `{ items: Job[], nextCursor: string | null }`
- `400` — Company not set up / malformed cursor
- `422` — Validation error

#### `GET /api/v1/jobs/:id` `[Bearer JWT, Role: owner | technician]`

Full job detail: technician & customer profiles, activity log, attachments.

**Responses:**
- `200` — Full job detail payload
- `403` — Technician viewing a job not assigned to them
- `404` — Job not found (or another tenant)

#### `PATCH /api/v1/jobs/:id` `[Bearer JWT, Role: owner]`

Edit, reassign, or cancel a scheduled job.

**Body:** `{ scheduled_at?, technician_id?, notes?, status? }`

**Responses:**
- `200` — Updated job
- `403` — Technician JWT
- `404` — Job or technician not found
- `409` — Job is not modifiable in its current status (e.g. in_progress / completed)
- `422` — Validation error

#### `POST /api/v1/jobs/:id/workflow` `[Bearer JWT, Role: technician, Idempotent]`

Advance a job through its ordered workflow steps. **Technician must be the
assigned technician.** Steps are validated for ordering (422 on out-of-order).

**Headers:** `X-Idempotency-Key: <UUID v4>` (optional; 24h replay dedup)

**Body:** `{ step: WorkflowStep, notes?: string }`

**Responses:**
- `200` — Updated job
- `403` — Owner JWT, or technician not assigned to the job
- `409` — Job is not advanceable in current status
- `422` — Invalid step value or out-of-order transition

#### `POST /api/v1/jobs/:id/attachments` `[Bearer JWT, Role: technician, Idempotent]`

**Phase 1 of two-phase upload.** Request a presigned R2 upload URL.

**Headers:** `X-Idempotency-Key: <UUID v4>` (optional)

**Body:** `{ contentType: string, sizeBytes: number, purpose: 'before' | 'after' }`

**Responses:**
- `200` — `{ uploadId: UUID, uploadUrl: string (presigned R2 PUT), expiresAt: ISO8601 }`
- `409` — Photo limit reached (5 max per job)
- `422` — Validation error

#### `POST /api/v1/jobs/:id/attachments/:uploadId/confirm` `[Bearer JWT, Role: technician]`

**Phase 2 of two-phase upload.** Confirm a completed R2 upload; the backend
calls `rpc_confirm_attachment` (Postgres RPC) which performs server-side
conflict resolution (see `migration 13/14`).

**Body:** `{ checksum: string, sizeBytes: number }`

**Responses:**
- `200` — Attachment confirmed
- `404` — Job or upload not found
- `410` — Upload session expired
- `422` — Validation error

---

### Sync (technician only)

#### `POST /api/v1/sync` `[Bearer JWT, Role: technician]`

Delta sync — returns jobs (assigned to this technician) changed since
`last_synced_at`. Uses the `idx_jobs_tenant_updated_at` covering index
(migration 11) for fast lookup.

**Body:** `{ last_synced_at: ISO8601 | null }`

**Responses:**
- `200` — `SyncResponseDto` `{ server_time, jobs: Job[], deleted_job_ids: UUID[] }`
- `403` — Owner JWT not allowed
- `422` — Invalid `last_synced_at` format

---

### Internal Webhooks `[Public, HMAC-verified]`

These endpoints are mounted at `/internal/webhooks/storage` and are **excluded**
from the `/api/v1` prefix. They are HMAC-signed by a Cloudflare Worker using
`WORKER_WEBHOOK_SECRET`.

#### `POST /internal/webhooks/storage` `[Public]`

Receives a Cloudflare R2 storage event. Verifies HMAC, processes the event
(e.g. marks attachments as `available`), and reconciles state.

**Headers:** `Authorization: Bearer <HMAC of body using WORKER_WEBHOOK_SECRET>`

**Body:** `StorageEventDto` — `{ objectKey, eventType, occurredAt }`

**Responses:**
- `200` — Event processed
- `401` — Invalid HMAC
- `422` — Validation error

---

## Standard Error Shape

```json
{
  "statusCode": 422,
  "message": "Validation failed",
  "errors": [
    { "field": "phone", "constraints": { "isE164": "phone must be E.164" } }
  ]
}
```

## Swagger

OpenAPI is auto-generated at `/api/docs` in **non-production** environments
only (see `src/main.ts`). Production deployments do not expose Swagger.