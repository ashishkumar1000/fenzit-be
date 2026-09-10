# API Contracts — fenzit-be

All endpoints are mounted under `/api/v1` except those explicitly excluded
(see `src/main.ts`). All endpoints require a JWT **except** where marked
`[Public]`. JWTs are issued by `POST /api/v1/auth/otp/verify` and never expire
(no `exp` claim — interim until refresh tokens land; the guard rejects any
token whose role is not `owner`/`technician`, so the short-lived Realtime
tokens minted by `GET /api/v1/auth/realtime-token` are socket-only).

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

#### `GET /api/v1/auth/realtime-token` `[Bearer JWT, Role: owner]`

Mint a short-lived (1 h) token for the Supabase Realtime socket (Story 3.3,
owner notifications; technician live updates — Story 3.4 — may widen this
later). Supabase Realtime rejects the login JWT — it never expires and its
`role: 'owner' | 'technician'` claim is not an existing Postgres role (Story 3.1
spike) — so the app exchanges its login token for this one. Authorization on the
Realtime path happens in the `realtime.messages` RLS policy, keyed on `sub` only.

**Body:** none

**Responses:**
- `200` — `{ token: string (JWT: sub + role: 'authenticated' + exp; iat added automatically), expiresAt: ISO8601 }`
- `401` — Missing or invalid JWT
- `403` — Technician JWT

The client caches the token and re-fetches it slightly before `expiresAt`
(refresh margin), so a fresh token is always in hand for a (re)connect; a
failed fetch just means no socket (the app falls back to focus refresh).

#### `POST /api/v1/auth/invite` `[Bearer JWT, Role: owner]`

Invite a technician by phone number. Creates a `users` row with `status: invited`.

**Body:** `{ phone: string, countryCode: string, skillIds: UUID[] (min 1, max 20, unique) }`

`skillIds` are global skills-catalog UUIDs — exactly what `GET /skills` serves.

**Responses:**
- `201` — `{ invite_id: UUID }`
- `403` — Technician JWT
- `409` — Phone already an active member of this tenant
- `400` — One or more `skillIds` are invalid (unknown / inactive in the global catalog)
- `422` — Invalid `skillIds` (not UUIDs) or phone format

#### `POST /api/v1/auth/company` `[Bearer JWT, Role: owner]`

Create or update the tenant company profile. **Idempotent upsert** — first call
returns `201`, subsequent calls return `200`. Returns a fresh JWT containing
the now-set `tenantId` claim.

**Body:** `{ name?, company_name, gstin?, address?, state_code (^[A-Z]{2}$), upi_vpa? }`

`name` is the owner's display name — when sent, it is saved on the caller's
users row (`users.name`) and returned by `GET /users/me`. Optional on the wire
for backward compatibility; the app always sends it from the signup profile
screen.

**Responses:**
- `201` — Company created; `{ token, tenant }`
- `200` — Company updated (idempotent); `{ token, tenant }`
- `403` — Technician JWT
- `422` — Invalid GSTIN / missing `stateCode`

---

### Users (profile)

#### `GET /api/v1/users/me` `[Bearer JWT, Role: owner | technician]`

Role-branched profile payload — the app's primary boot call.

- **Owner:** tenant/company info, technician roster (with skills), customers
  page, jobs page, and jobCounts (`today/upcoming/overdue/completed/cancelled`)
- **Technician:** own skills, own jobs page, own jobCounts

Every row in the jobs page additionally embeds
`technician: { id, name, countryCode, phoneNumber, skills: string[] }` (always
present — jobs are never unassigned) and
`customer: { id, name, countryCode, phoneNumber, address, city }`. Both lists
are cursor-paginated.

> Note: the `GET /jobs/:id` detail embed of the same customer carries two extra
> fields — `latitude`/`longitude` (Story 2.1, `number | null`, null when the
> customer was saved without coordinates). The profile-payload jobs-page embed
> intentionally stays lean; the two shapes are no longer identical.

**Query:** `jobsScope? ('today' | 'all', default 'all')`, `jobsCursor?`,
`jobsLimit? (1-50)`, `customersCursor?`, `customersLimit? (owner only, 1-50)`

`jobsScope=today` narrows the jobs page to the current **IST day window** on
`scheduled_start` (same window `GET /jobs?scope=today` uses, no status filter)
and sorts it `scheduled_start` ASC — soonest first, dispatch order. As on the
jobs list, a **technician's** today view also includes their `in_progress`
jobs regardless of the day window; the owner view keeps the pure window. A
`jobsCursor` minted for one scope is rejected (400) on the other.

**Responses:**
- `200` — Role-specific profile payload
- `400` — Malformed / wrong-scope cursor
- `401` — Missing/invalid JWT
- `422` — Invalid `jobsScope` (anything other than `today`/`all`)

#### `PATCH /api/v1/users/me` `[Bearer JWT, Role: owner | technician]`

Update the caller's own display name. Returns the same shape as
`GET /users/me`.

**Body:** `{ name }`

**Responses:**
- `200` — Updated profile payload
- `401` — Missing/invalid JWT
- `422` — Validation error

---

### Skills (global catalog)

The skill vocabulary is one fixed platform-wide catalog, seeded exclusively by
developer migrations. The global catalog itself has no create/update/delete
endpoint and must never get one — the old per-tenant POST/DELETE routes (which
wrote the now-dropped `tenant_skills` table) were removed in Story 4.2 and
return 404.
`GET /skills` replaced the old per-tenant list in Story 4.1: the response
dropped the old GET's `tenantId`/`createdAt` fields and widened access from
owner-only to owner+technician (pre-launch, fenzo-app consumes the new shape
from Epic 5 — fenzit-be ships first, NFR5).

#### `GET /api/v1/skills` `[Bearer JWT, Role: owner or technician]`

List the global skills catalog (developer-seeded; inactive rows excluded).
Order is seed order, pinned by the `skills.sort_order` column — the FE picker
renders it as-is.

**Response 200:** `{ skills: [{ id, name }] }`

**Responses:**
- `401` — Missing/invalid JWT
- `403` — Role outside owner/technician

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
- Default scope is `today` (IST day window on `scheduled_start`). For
  **technicians** on the default view (no explicit `date`), the today scope
  also always includes their `in_progress` jobs regardless of the day window —
  an active job must not vanish when its slot crosses midnight IST. An explicit
  `date` re-anchor keeps the pure day window (day-history view). Owners keep
  the pure day-window view. Timeline scopes (`scope=upcoming|overdue|history`,
  Story 3.7) are unchanged; a job that is both in-progress and past its slot
  appears in `today` and `overdue` for the technician.
- A caller `status` filter ANDs down to both sides of the OR branch — e.g.
  `scope=today&status=completed` returns only today-window completed jobs (an
  in_progress job can never pass a `completed` filter).

**FE note:** a technician's `today` list may contain jobs whose
`scheduled_start` falls outside the current IST day (their active job). Do not
assume every row is scheduled for today.

**Query:** `scope? (today | upcoming | overdue | history, default today)`,
`date? (YYYY-MM-DD, IST day — today scope only)`, `status?`, `technicianId?`,
`cursor?`

**Responses:**
- `200` — `{ items: Job[], nextCursor: string | null }`
- `400` — Company not set up / malformed cursor
- `422` — Validation error

#### `GET /api/v1/jobs/:id` `[Bearer JWT, Role: owner | technician]`

Full job detail: technician & customer profiles, activity log, attachments. The
embedded customer profile is
`{ id, name, countryCode, phoneNumber, address, city, latitude, longitude }`
(`latitude`/`longitude` are `number | null` — null when the customer was saved
without coordinates; Story 2.1).

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

**Side effect (Story 3.1):** a committed advance writes exactly one
`notifications` row for the tenant owner (`event_type` = the step, `payload` =
`{ job_number, step, technician_name }`) and broadcasts it over Supabase
Realtime to the private topic `user:<owner_id>:notifications` (event
`INSERT`). No notification is written for a rejected advance or when the
owner advances their own job. Realtime tokens require `exp` and
`role: 'authenticated'` claims (Supabase Realtime rejects the login JWT's
never-expire token — see Story 3.1 spike); the app mints them from its login
token via `GET /api/v1/auth/realtime-token`.

#### `POST /api/v1/jobs/:id/attachments` `[Bearer JWT, Role: technician, Idempotent]`

**Phase 1 of two-phase upload.** Request a presigned R2 upload URL.

**Headers:** `X-Idempotency-Key: <UUID v4>` (optional; 24h replay dedup via
`IdempotencyInterceptor`)

**Body:** `{ filename: string, mimeType: string, attachmentType: 'photo' | 'signature' }`
— `mimeType` must be one of `image/jpeg | image/png | image/heic`.

**Responses:**
- `200` — `{ presignedPutUrl: string (presigned R2 PUT; the signature covers
  the `Content-Type` header), uploadId: UUID, key: string (R2 object key,
  tenant/job-scoped), expiresAt: ISO8601 (900 s — matches the URL TTL) }`
- `409` — Photo limit reached (5 confirmed photos max per job)
- `422` — Validation error (unknown mimeType, missing fields)

The client PUTs the raw bytes to `presignedPutUrl` directly against R2 —
`Content-Type` header only, **no `Authorization` header** — then confirms.

#### `POST /api/v1/jobs/:id/attachments/:uploadId/confirm` `[Bearer JWT, Role: technician]`

**Phase 2 of two-phase upload.** Confirm a completed R2 upload; the backend
calls `rpc_confirm_attachment` (Postgres RPC) which performs server-side
conflict resolution (see `migration 13/14`). Note: this endpoint does NOT
take the idempotency interceptor — the `X-Idempotency-Key` header, if sent,
is ignored; re-executing a confirm is safe (the RPC returns the existing
row) but is re-execution, not key-based replay.

**Body:** `{ sizeBytes: number }` (integer, ≥ 1)

**Responses:**
- `200` — The confirmed attachment (`{ id, type, createdAt }`)
- `404` — Job or upload not found
- `409` — Photo limit reached (5 max per job)
- `410` — Upload session expired (client should restart from presign)
- `422` — Validation error (missing/non-integer/zero `sizeBytes`)

---

### Notifications (Story 3.2)

All four endpoints are **recipient-scoped by the JWT `sub` claim** — every
query filters by both `tenant_id` and `user_id`, so a caller can only ever see
and mutate their own rows (a technician's set is naturally empty today; rows
are written only by `advance_workflow_step`, see the Story 3.1 side effect
under `### Jobs`). Deliberately **not** role-gated: recipient-scoping is the
authorization.

The list uses the shared `{ data, nextCursor, hasMore }` cursor envelope and
the house cursor machinery (base64url JSON, scope `notifications-list`;
malformed or foreign-scope cursor → `400`). DTO rejections are `422` per the
global ValidationPipe.

#### `GET /api/v1/notifications?limit=&cursor=` `[Bearer JWT]`

Newest-first list (`created_at DESC, id DESC` keyset pagination). Default page
20, max 50. Each item: `{ id, jobId, eventType, payload, readAt, createdAt }`
— `payload` is the verbatim Story 3.1 JSONB (`job_number`, `step`,
`technician_name`); no read-time join.

**Responses:**
- `200` — `{ data: [...], nextCursor: string | null, hasMore }`
- `400` — Malformed or foreign-scope cursor
- `401` — Missing/invalid JWT
- `422` — Validation error (`limit` must be an integer 1–50)

#### `GET /api/v1/notifications/unread-count` `[Bearer JWT]`

**Responses:**
- `200` — `{ unreadCount: number }` (rows with `read_at IS NULL` for the caller)

#### `POST /api/v1/notifications/mark-read` `[Bearer JWT]`

Marks own, currently-unread rows read. Idempotent; foreign/missing/already-read
ids silently no-op.

**Body:** `{ ids: string[] }` (UUIDs, 1–100 items)

**Responses:**
- `200` — `{ markedCount: number }` (rows actually marked)
- `401` — Missing/invalid JWT
- `422` — Validation error (empty ids, non-UUID id, > 100 ids)

#### `POST /api/v1/notifications/mark-all-read` `[Bearer JWT]`

Marks every unread row of the caller read. Idempotent (repeat → `markedCount: 0`).

**Responses:**
- `200` — `{ markedCount: number }`
- `401` — Missing/invalid JWT

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