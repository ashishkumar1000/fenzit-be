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

#### `GET /api/v1/auth/realtime-token` `[Bearer JWT, Role: owner | technician]`

Mint a short-lived (1 h) token for the Supabase Realtime socket. Opened to
technicians in Story 14.2 (Story 3.3 minted it owner-only; the AD-18 security
gate is satisfied by Story 14.1's RPC-grant revocation + column-limited
`users_update_own`). Supabase Realtime rejects the login JWT — it never expires
and its `role: 'owner' | 'technician'` claim is not an existing Postgres role
(Story 3.1 spike) — so the app exchanges its login token for this one.
Authorization on the Realtime path happens in the `realtime.messages` RLS
policy (`notifications_topic_recipient_only`), keyed on `sub` only — each token
can reach exactly one topic, `user:<sub>:notifications`; a foreign topic is
denied server-side regardless of what the client subscribes to.

**Body:** none

**Responses:**
- `200` — `{ token: string (JWT: sub + role: 'authenticated' + exp; iat added automatically), expiresAt: ISO8601 }` (same shape for both roles)
- `401` — Missing or invalid JWT

The client caches the token and re-fetches it slightly before `expiresAt`
(refresh margin), so a fresh token is always in hand for a (re)connect; a
failed fetch just means no socket (the app falls back to focus refresh).

**Broadcast envelope (Realtime → client):** on the topic the client receives a
BINARY-framed broadcast with event `'INSERT'` whose payload is
`{ id, table, record: { ...row } }` — the raw DB row, **snake_case** (REST maps
to camelCase in `NotificationResponse`; that split is pre-existing).

**`dedupe_key` is DB-internal:** it exists only for DB-guaranteed dedupe (the
partial unique index) and never appears in REST responses. It does appear in
the raw broadcast `record` — acceptable, since the topic is recipient-only.

**Deploy order:** migration `20260925000005` (entity/dedupe columns) must be
applied (via Supabase MCP) **before** the backend deploy that selects the new
columns — otherwise every `GET /notifications` 500s on the unknown column.

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
  — plus the same `attendance` mirror the technician branch carries
  (2026-09-30): `attendanceEnabled` is the TENANT flag
  (`attendance_settings.enabled AND setup_completed_at IS NOT NULL`), which
  gates owner-side entry points (the Home attendance tile); an owner's
  `attendanceAccess` reads `'none'` (owners are never enrolled). The
  pre-onboarding owner (no tenant) carries the attendance-free default.
- **Technician:** own skills, own jobs page, own jobCounts — plus the
  `attendance` mirror (15-7/AD-17): `{ attendanceEnabled, attendanceAccess
  ('none' | 'upcoming' | 'active' | 'history_only'), attendanceStartDate,
  onboardedAt, pendingLeaveRequests }` for first load, read from the same
  `attendance_access_state` view as `GET /attendance/me/access`; refetches
  use that light endpoint, not the profile
- **`attendance.pendingLeaveRequests` (20-1)** — view column (migration
  20261001000001): the tenant's leave REQUESTS whose review is still owed —
  `count(distinct leave_request_id)` over `leave_request_days` rows still
  `pending` (the same pending-queue definition the owner leave list and the
  19-4 reminder serve; a partially-handled request still counts). The
  OWNER'S attention fact — the view evaluates it only on the owner's row
  while the module is on (enabled + setup completed); every other mirror
  row (technicians, module-off tenants) reads 0. The FE gates the strip on
  the owner role + count > 0. First-load only: it does NOT live on
  `GET /attendance/me/access`, so after the owner handles requests the
  number stays stale until the next profile fetch (Home strip rebuilds on
  next app open); the refresh endpoint is unchanged in this story.

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

**Response 200:** `{ skills: [{ id, name }] }` — `name` is the display label
the FE renders (the skill's human-readable name; there is no separate
display-name field).

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
- `200` — `{ customer: Customer, jobHistory: { data: JobHistoryItem[], nextCursor: string | null, hasMore: boolean } }` — each `JobHistoryItem` carries `id, jobNumber, scheduledStart, status, skillName`
- `400` — Company not set up / malformed id
- `403` — Technician JWT
- `404` — Customer not found (or in another tenant)

---

### Jobs

**Job read shape (Story 4.5):** every job read surface — create response, list
items, detail, PATCH response, workflow advance response, profile job rows, and
the offline-sync payload — carries three Story 4.5 fields alongside the
existing ones:

- `skill: { id, name } | null` — the job's tagged skills-catalog skill. A plain
  left embed (no `!inner`, no `is_active` filter), so an archived skill's name
  still renders on old jobs; a job created before the skill column existed
  reads as `null`.
- `workflowTemplate: { version, steps } | null` — the stamped template the job
  advances through, as the FK embed. `steps` is the template's step list with
  camelCase fields: `{ key, label, requiresPhoto, requiresSignature,
  setsStatus, advancesOn }` (`key` stays snake_case — it is the step
  identifier the advance API takes). `null` on the rare degraded re-fetch
  (write succeeded, embed re-fetch failed — the write is never turned into a
  500).
- `currentStepIndex: number | null` — 0-based position of the job's
  `current_step` in `workflowTemplate.steps`; `null` while the job is fresh
  (no step recorded yet) and `null` on the second null case — a corrupt or
  unknown `current_step` that does not appear in the template's steps (reads
  are deliberately softer than the write path, which blocks such a step).
  Derived per read — never stored.

The customer job-history rows (`GET /api/v1/customers/:id` → `jobHistory`)
gain `skillName: string | null` the same way.

#### `POST /api/v1/jobs` `[Bearer JWT, Role: owner]`

Create a job for a customer and assign to a technician (who must belong to the
owner's tenant). `skillId` tags the job with a global skills-catalog skill
(exactly what `GET /skills` serves); the create RPC stamps that skill's latest
`workflow_templates` version onto the job (Story 4.3).

**Body:** `{ customerId? (UUID) | newCustomer (inline), skillId: UUID (global
catalog), serviceLocation: string, scheduledStart: ISO8601, technicianId: UUID,
scheduledEnd?, description?, priority?, notesForTechnician? }`
(The Story 3.8 `requireCompletionPhoto`/`requireCompletionSignature` fields are
GONE since Story 4.4 — photo/signature requirements are template step
attributes. **Rollout order:** this is a breaking backend change — the app
still sends `requireCompletion*` on create and PATCH until its Epic 5 cutover.
The ValidationPipe whitelist silently strips the flags on this create path (201,
flags ignored); a PATCH carrying only the flags comes back `422` "No
updatable fields provided". Deploy this backend first; the app must stop
sending and reading the flags in its Epic 5 change.)

**Responses:**
- `201` — Job created (`status: scheduled`, `currentStep: null`)
- `400` — Company not set up / `skillId` unknown or inactive in the catalog
- `404` — Customer or technician not found
- `422` — Validation error (non-UUID `skillId`, inverted schedule window, etc.)
- `500` — The RPC's plain "No workflow template found for skill" raise maps to
  `INTERNAL_SERVER_ERROR`; the v1 template seeds make it unreachable (every
  seeded skill has a v1 template) — reaching it means a server fault.

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

**Story 4.4 note:** the removed `requireCompletion*` flags are silently
stripped by the ValidationPipe whitelist here too — a PATCH body carrying
**only** the flags leaves no updatable fields and comes back `422` "No
updatable fields provided".

#### `POST /api/v1/jobs/:id/workflow` `[Bearer JWT, Role: technician, Idempotent]`

Advance a job through its workflow. **Technician must be the assigned
technician.** Story 4.4 — the chain is the job's **stamped template**:
`step` must be the template's first not-yet-completed step (`key` matching
`^[a-z0-9_]{1,64}$`; no skipping, no flags — `requires_photo` /
`requires_signature` are frontend action gates, not chain filters). A corrupt
`current_step` (absent from the template) rejects every advance with 422 and
is never reset. Note: photo/signature requirements never narrow the chain —
a job whose template has no photo/signature steps still walks every step
server-side; enforcing the action gates (upload the photo before advancing)
is the frontend's job (Story 4.5).

**Headers:** `X-Idempotency-Key: <UUID v4>` (optional; 24h replay dedup)

**Body:** `{ step: string }`

**Responses:**
- `200` — Updated job
- `403` — Owner JWT, or technician not assigned to the job
- `409` — Job is not advanceable in current status
- `422` — Invalid step value or out-of-order transition (body carries
  `currentStep` — the step the job is actually on)
- `500` — Corrupt template stamp (unparseable steps / stamp version mismatch /
  missing template embed) — a server fault, never silently reset

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
calls the `confirm_attachment` RPC which performs server-side conflict
resolution (see `migrations 16 and 20/21`). Since Story 4.4 the same RPC also
**auto-advances** the workflow when the attachment is the job's **first
confirmed photo** and the stamped template has a step with
`advances_on: 'photo_confirm'` whose predecessor is the job's current step —
the advance runs inside the same transaction via `advance_workflow_step`
(owner notification included); a raced/terminal job raises PT409, which the
RPC swallows (logged) so the attachment still commits. The response shape is
unchanged. Two accepted skip paths (logged, attachment still commits): a
photo-optional job — `current_step` not at the photo step's predecessor — and
a missing template row. **Worker-path note (accepted limitation):** when the
confirm arrives via the Cloudflare Worker webhook the RPC runs with a NULL
actor; the advance and activity log commit, but the owner notification is
skipped (the notification guard filters every row for a NULL actor). The app
path notifies as specified. Note: this endpoint does NOT take the idempotency
interceptor —
the `X-Idempotency-Key` header, if sent, is ignored; re-executing a confirm
is safe (the RPC returns the existing row) but is re-execution, not
key-based replay.

**Body:** `{ sizeBytes: number }` (integer, ≥ 1)

**Responses:**
- `200` — The confirmed attachment (`{ id, type, createdAt }`)
- `404` — Job or upload not found
- `409` — Photo limit reached (5 max per job — unconditional, template-independent)
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
20, max 50. Each item: `{ id, jobId, eventType, payload, readAt, entityType,
entityId, createdAt }` — `payload` is the verbatim Story 3.1 JSONB
(`job_number`, `step`, `technician_name`); no read-time join. Job notifications
carry their `jobId`; report notifications (Epic 12: `eventType` `report_ready`
/ `report_failed`) carry `jobId: null` and a payload of
`reportId`/`reportType`/`reportLabel`/`status`/`errorCode` — no URLs (the FE
fetches a fresh presigned URL from the report status endpoint on tap).
`entityType`/`entityId` (Story 14.2, additive + nullable) are the polymorphic
deep-link target for later attendance/leave events — all current job/report
rows return them as `null`.

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

### Reports (Epic 12, owner only)

All three endpoints are **owner-only** (`@Roles(Role.OWNER)` — a technician JWT
gets `403`). Generation is asynchronous: `POST` queues a `report_requests` row
(status `queued`) and returns immediately; the in-process worker (story 12-3)
drives `queued → generating → ready | failed`. The client polls
`GET /reports/:id` (or reads the history list) — when `ready`, that response
carries a **fresh** short-lived presigned R2 URL, minted per request
(`REPORT_PRESIGN_TTL_SECONDS`, default 600s) and never stored.

Cross-tenant reads (a foreign or unknown request id) and missing rows all map
to `404` — never a `403`, so ids are not enumerable. The in-flight cap (max 3
rows per tenant in `queued|generating`) is enforced by a `BEFORE INSERT OR
UPDATE OF status` trigger (INSERT covers create; the UPDATE leg covers the
retry's failed→queued re-queue. Count-neutral transitions — the claim's
queued→generating, lease recovery, terminal stamps — are skipped, so a report
finishing never falsely trips the cap); the app maps the trigger's `PT429`
SQLSTATE to `429 REPORT_IN_FLIGHT_LIMIT`.

#### `POST /api/v1/reports` `[Bearer JWT, Role: owner]` `[IdempotencyInterceptor]`

Body (camelCase; deep validation — calendar-date format, inclusive range ≤ 92
days, end date not in the future on the IST clock, technician membership —
lives in the service/report definition, so every failure is a `400` with a
specific error code, not a generic `422`):

```json
{
  "reportType": "technician_job_activity",   // optional, registry key; defaults to the first report
  "startDate": "2026-09-01",                 // required, YYYY-MM-DD inclusive
  "endDate": "2026-09-15",                   // required, YYYY-MM-DD inclusive, not future (IST)
  "technicianIds": ["<uuid>"]                // optional; absent/empty = all technicians; max 25
}
```

Sends `x-idempotency-key` (UUID v4) to make retries return the same row.

**Responses:**
- `201` — `{ id, status: 'queued', createdAt }`
- `400` — `VALIDATION_ERROR` (bad date format / start > end / future end date / non-technician in `technicianIds`), `REPORT_RANGE_TOO_LARGE` (> 92 days), `REPORT_TOO_MANY_TECHNICIANS` (> 25)
- `401` — Missing/invalid JWT
- `403` — Technician JWT
- `429` — `REPORT_IN_FLIGHT_LIMIT` (company already has 3 in-flight reports)
- `422` — DTO shape violations (oversized fields, non-string types)

#### `GET /api/v1/reports?cursor=` `[Bearer JWT, Role: owner]`

History, newest first (`created_at DESC, id DESC` keyset pagination, page 20).
Cursor machinery: scope `reports-list`; malformed or foreign-scope cursor →
`400`. Each item: `{ id, reportType, range: { startDate, endDate },
technicianCount, status, errorCode, createdAt, completedAt }` —
`technicianCount` is `null` when the report covers all technicians.

**Responses:**
- `200` — `{ data: [...], nextCursor: string | null, hasMore }`
- `400` — Malformed or foreign-scope cursor
- `401` / `403` — as above

#### `GET /api/v1/reports/:id` `[Bearer JWT, Role: owner]`

Status poll. Response: `{ id, reportType, params: { startDate, endDate,
technicianIds }, status, createdAt, completedAt }` plus:

- `status: 'ready'` → adds `file: { url, sizeBytes, filename }` (fresh presigned URL each poll)
- `status: 'failed'` → adds `error: { code }` (stable engine error code)

**Responses:**
- `200` — status response (any state)
- `401` / `403` — as above
- `404` — Unknown id or other company's report
- `500` — `REPORT_PRESIGN_FAILED` (R2 presigning failed for a ready row)

#### `POST /api/v1/reports/:id/retry` `[Bearer JWT, Role: owner]` `[IdempotencyInterceptor]`

Re-queues a FAILED report in place — the same row flips `failed → queued` and
regenerates (no duplicate history entry). The guarded UPDATE sets `status →
queued` and clears `error_code` / `completed_at` / `locked_until` /
`attempt_count` (a deliberate human retry gets a fresh run of the worker's
attempt budget), predicated on `status = 'failed'` — so a double-tap cannot
re-queue twice; the losing call sees the row no longer failed. Fresh
`x-idempotency-key` per tap, same rule as create.

**Responses:**
- `201` — `{ id, status: 'queued', createdAt }`
- `400` — `VALIDATION_ERROR` (caller has no tenant)
- `401` / `403` — as above
- `404` — Unknown id or other company's report
- `409` — `REPORT_NOT_RETRYABLE` (row is not `failed`, or the guard lost a race)
- `429` — `REPORT_IN_FLIGHT_LIMIT` (3 in-flight rows at the moment of re-queue)

---

### Attendance setup (Epic 15, Story 15-2, owner only)

Foundation routes for the FR-1 attendance setup wizard. No idempotency
interceptor on any attendance route (AD-6) — start/step-save are idempotent
by construction (single upsert RPC with on-conflict-do-nothing) and complete
is state-guarded. Rows are created on demand: before the owner starts the
wizard there is no `attendance_settings` row at all, and `started=false`
reports that (200, not 404).

Wizard steps (fixed vocabulary, DB CHECK-enforced): `offices` → `timings` →
`weekly_off` → `holidays` (skippable) → `employees`.

#### `GET /api/v1/attendance/setup` `[Bearer JWT, Role: owner]`

Resume state. `started=false` until `POST /attendance/setup` is called.

**Response:** `{ started, currentStep, setupCompletedAt, enabled }`
(`currentStep`/`setupCompletedAt` are null before start/completion).

**Responses:**
- `200` — setup state
- `400` — `VALIDATION_ERROR` (caller has no tenant)
- `401` / `403` — as above

#### `POST /api/v1/attendance/setup` `[Bearer JWT, Role: owner]`

Start (or resume) the wizard through the `attendance_start_setup` RPC —
idempotent: a restart mid-wizard never resets progress (the owner resumes at
their last incomplete step on any device), and a double-tap cannot duplicate
rows. `201` on the first start, `200` when already under way.

**Response:** `{ started, currentStep, setupCompletedAt, enabled }` — same
shape as GET, with the status code distinguishing first-start from resume.

**Responses:**
- `201` — wizard started (first time)
- `200` — wizard already under way (returns current state)
- `400` — `VALIDATION_ERROR` (caller has no tenant)
- `401` / `403` — as above
- `409` — `ATTENDANCE_SETUP_ALREADY_COMPLETED`

#### `PATCH /api/v1/attendance/setup` `[Bearer JWT, Role: owner]`

Persist the step the owner is now on (FR-1: progress saved after each step,
survives closing the app or switching phones). Guarded UPDATE scoped to the
tenant. The FE advances the marker; the DB pins the vocabulary (unknown
steps → 422). Once setup is completed the wizard is closed — PATCH returns
409 from then on.

**Body:** `{ currentStep: 'offices' | 'timings' | 'weekly_off' | 'holidays' | 'employees' }`

**Responses:**
- `200` — step saved
- `400` — `VALIDATION_ERROR` (caller has no tenant)
- `401` / `403` — as above
- `404` — `ATTENDANCE_SETUP_NOT_STARTED`
- `409` — `ATTENDANCE_SETUP_ALREADY_COMPLETED` (setup completed)
- `422` — unknown step value (ValidationPipe)

#### `POST /api/v1/attendance/setup/complete` `[Bearer JWT, Role: owner]`

Completes the wizard through the `attendance_complete_setup` RPC: takes the
exclusive tenant lock (AD-5), verifies at least one active office and one
tracked employee with an office assignment, then sets `setup_completed_at`
and `enabled = true` (the wizard is the module's enable act; `enabled=false`
remains the kill switch). Completable once Stories 15-3 (offices) and 15-7
(enrolments) have shipped their tables — before then the RPC's gates report
setup incomplete.

**Response:** `{ started, currentStep, setupCompletedAt, enabled }`

**Responses:**
- `200` — setup completed
- `401` / `403` — as above
- `404` — `ATTENDANCE_SETUP_NOT_STARTED`
- `409` — `ATTENDANCE_SETUP_ALREADY_COMPLETED`
- `422` — `ATTENDANCE_SETUP_INCOMPLETE` (≥1 office and ≥1 tracked employee required)

**DB foundation (this story, additive):** `tenants.timezone` (default
`Asia/Kolkata`, validated by the `tenants_timezone_guard` trigger against
`pg_timezone_names` — region-style names only, PT422
`ATTENDANCE_INVALID_TIMEZONE` otherwise); `attendance_settings` +
`attendance_setup_progress` tables (tenant-isolation RLS); shared helpers
`attendance_today(p_tenant_id)`, `attendance_lock_tenant(tenant_id,
exclusive)` / `attendance_lock_employee(employee_id)` (AD-5 advisory locks).
Every attendance function is SECURITY DEFINER, executable by service_role
only (AD-3).

---

### Attendance offices (Epic 15, Story 15-3, owner only)

FR-5 office management — create, edit, archive. No idempotency interceptor
(AD-6): create is FE-guarded (the unique-name index bounds a double-tap to a
409, not a duplicate row), PATCH is naturally idempotent, archive is
lock-serialised. Offices are archived (`archived_at`), never deleted (AD-25).

An Office holds the location and the timing rules. Pin and radius are NOT
effective-dated (plain columns); the timing/hours rules are — every rules
edit takes effect from tomorrow (`attendance_update_office_rules`, AD-8
algorithm), and all past dates keep the rule active on that date.

**Office shape:** `{ id, name, latitude, longitude, radiusM, archivedAt,
rule, nextRule }` where `rule` is the rule valid on today and `nextRule`
(null normally) shows a pending rules edit. Rule shape: `{ id, startTime,
endTime, lateCutoffMinutes, fullDayHours, halfDayHours, validFrom, validTo }`
— times `HH:mm`, dates `YYYY-MM-DD` (AD-7), `validTo` null while open-ended.
The rule valid on today is picked in the service (`pickCurrentRule` against
`attendance_today`) — PostgREST cannot filter daterange rows by containment
against a scalar, so all of an office's rule rows are fetched and selected
client-of-DB; the recorded deviation in the story's Code Map.

**Validation ranges (DB CHECK constraints are the final guard; DTO mirrors
them for 422s):** radius 50–1000 m (default 100), late cut-off 0–120 min
(default 15), full-day hours > 0 (default 8), half-day hours > 0 and < full
(default 4), end time after start time, same day. Office names are unique
per tenant, case-insensitive, up to 80 characters — the 80 cap is an API-edge
guard only (`@MaxLength(80)`; the DB column has no length CHECK) — and
trimmed: leading/trailing whitespace is stripped before the uniqueness
check, and a whitespace-only name is rejected. Archived offices keep their
name reserved (the unique index includes them).

#### `GET /api/v1/attendance/offices` `[Bearer JWT, Role: owner]`

List offices. Archived offices are hidden unless `?includeArchived=true`
(archived offices have `archivedAt` set and typically no `rule`).

**Response:** `Office[]` (empty list is fine, never 404)

**Responses:**
- `200` — offices list
- `400` — `VALIDATION_ERROR` (caller has no tenant)
- `401` / `403` — as above

#### `GET /api/v1/attendance/offices/:id` `[Bearer JWT, Role: owner]`

Full effective-dated rules history, ascending by `validFrom` (the edit
screen's source).

**Response:** `{ id, name, latitude, longitude, radiusM, archivedAt, rules: OfficeRule[] }`

**Responses:**
- `200` — office detail (archived offices are readable too; their rule
  history stays intact)
- `400` — `VALIDATION_ERROR` (malformed office id — not a UUID)
- `404` — `ATTENDANCE_OFFICE_NOT_FOUND` (unknown id or another tenant's)

#### `POST /api/v1/attendance/offices` `[Bearer JWT, Role: owner]`

Creates the office and its initial rule (valid `[today, ∞)`) through the
`attendance_create_office` RPC — two row-sets, one RPC (AD-3). Times are
`HH:mm` 24-hour strings.

**Body:** `{ name, latitude, longitude, radiusM?, startTime, endTime,
lateCutoffMinutes?, fullDayHours?, halfDayHours? }` (defaults: radius 100,
cut-off 15, hours 8/4)

**Responses:**
- `201` — office created, response carries the seeded rule
- `401` / `403` — as above
- `409` — `ATTENDANCE_OFFICE_NAME_TAKEN` (case-insensitive)
- `422` — out-of-range values (ValidationPipe / DB CHECK)

#### `PATCH /api/v1/attendance/offices/:id` `[Bearer JWT, Role: owner]`

One route, two write mechanics (user decision 2026-09-26):
- name/latitude/longitude/radiusM → guarded single-row UPDATE (immediate,
  not effective-dated; an archived office returns 404);
- startTime/endTime/lateCutoffMinutes/fullDayHours/halfDayHours →
  `attendance_update_office_rules` RPC, effective from tomorrow — must be
  sent as a complete set of five.

**Body:** any of the fields above; at least one required.

**Responses:**
- `200` — updated, response carries the full rules history
- `400` — `VALIDATION_ERROR` (nothing to update / partial rules set / no tenant / malformed office id)
- `404` — `ATTENDANCE_OFFICE_NOT_FOUND` (unknown, other tenant's, or archived)
- `409` — `ATTENDANCE_OFFICE_NAME_TAKEN`
- `422` — out-of-range values

#### `POST /api/v1/attendance/offices/:id/archive` `[Bearer JWT, Role: owner]`

Archives through the `attendance_archive_office` RPC — exclusive tenant
lock (AD-5), blocked by tracked employees with current or future
assignments (AD-25). Idempotent: an already-archived office is a no-op
success (204). Never a hard delete.

**Responses:**
- `204` — archived
- `400` — `VALIDATION_ERROR` (malformed office id)
- `401` / `403` — as above
- `404` — `ATTENDANCE_OFFICE_NOT_FOUND`
- `409` — `ATTENDANCE_OFFICE_ARCHIVE_BLOCKED`; the body carries
  `blockers: [{ employeeId, employeeName }]`
- `500` — before Story 15-7's tables exist the blocker check fails loud

#### `GET /api/v1/attendance/offices/:id/archive/preview` `[Bearer JWT, Role: owner]`

AD-24 preview: who blocks archiving this office — the same
`attendance_office_archive_blockers` read the archive write's 409 body uses.

**Response:** `{ officeId, blockers: [{ employeeId, employeeName }] }`
(empty list = free to archive)

**Responses:**
- `200` — blocker list (possibly empty)
- `400` — `VALIDATION_ERROR` (malformed office id)
- `404` — `ATTENDANCE_OFFICE_NOT_FOUND`
- `500` — before Story 15-7's tables exist the read fails loud

**DB foundation (this story, additive):** `btree_gist` extension;
`attendance_offices` (name unique per tenant via
`UNIQUE (tenant_id, lower(name))`, radius 50–1000 CHECK, `archived_at`) and
`attendance_office_rules` (`valid daterange`, `EXCLUDE USING gist
(office_id WITH =, valid WITH &&)` non-overlap, range CHECKs); RPCs
`attendance_create_office`, `attendance_update_office_rules`,
`attendance_archive_office`, and the read function
`attendance_office_archive_blockers` — every one SECURITY DEFINER,
executable by service_role only (AD-3). Both tables: RLS enabled, no
policies (deny-by-default, admin-client only). The two blocker-facing
functions reference the 15-7 enrolment/assignment tables and are
lazily compiled — they fail loud until 15-7 lands.

---

### Attendance weekly offs & holidays (Epic 15, Story 15-5, owner only)

FR-18/19 weekly offs (tenant default + per-employee overrides) and FR-20
holidays. Owner-only; day-status resolution that consumes these tables
arrives with Epic 16 (16-1's `attendance_day_context`). No idempotency
interceptor (AD-6): every weekly-off write is lock-serialised and
converges on retry; a retried holiday add is a 409; notification fan-outs
are dedupe-key bounded. "Today" comes only from `attendance_today` (AD-7).

**Weekly-off vocabulary:** `days` is ISO weekday numbers, 1=Mon .. 7=Sun
(stored sorted). At least one working day must remain (FR-18): a 7-day
selection is rejected 422 (`ATTENDANCE_NO_WORKING_DAYS` — pre-DB service
check, with the RPC's PT422 and the table CHECKs as backstops). An **empty `days` array is legal**:
- on the default PUT it clears future defaults from `effectiveFrom`
  (absence of a covering row = all 7 days working);
- on an override PUT it means "this employee works all 7 days" (the
  override **replaces** the tenant default while its range covers the
  date, AD-22). Removing the override is the DELETE — a separate
  operation; the employee then falls back to the tenant default.

There is **no seeded default** — "the default is Sunday" is an FE
preselection; the wizard's first save creates the row.

#### `GET /api/v1/attendance/weekly-offs` `[Bearer JWT, Role: owner]`

The tenant default: the selection valid on today (`default: null` = all
7 days working, including never-configured), the earliest pending future
edit (`next`), and the full effective-dated `history` (ascending). Range
picks are made on the fetched rows against `attendance_today`.

**Response 200:** `{ default: { days, validFrom, validTo } | null, next: … | null, history: […] }`

**Responses:**
- `200` — empty state is `{ default: null, next: null, history: [] }` (never-configured is a 200, not a 404)
- `400` — `VALIDATION_ERROR` (owner without a company)
- `404` — `ATTENDANCE_TENANT_NOT_FOUND` (stale/unknown tenant — `attendance_today` fails loud)
- `401` / `403` — as above

#### `PUT /api/v1/attendance/weekly-offs` `[Bearer JWT, Role: owner]`

Sets the tenant default through `attendance_set_weekly_off_default` —
the AD-8 algorithm with `effectiveFrom` defaulting (and past values
clamping) to today: future ranges are replaced, the covering range is
clipped at `effectiveFrom`, the new range is `[effectiveFrom, ∞)`.

**Body:** `{ days: number[] (1–7, unique, ≤6, empty allowed), effectiveFrom?: 'YYYY-MM-DD' }`

**Responses:**
- `200` — resolved default: `{ default, next, history }` (same shape as GET)
- `400` — `VALIDATION_ERROR` (no tenant)
- `404` — `ATTENDANCE_TENANT_NOT_FOUND`
- `422` — `ATTENDANCE_NO_WORKING_DAYS` (7-day selection, pre-DB) or `VALIDATION_ERROR` (malformed `effectiveFrom`)

#### `GET /api/v1/attendance/weekly-offs/overrides` `[Bearer JWT, Role: owner]`

Per-employee overrides with current/pending picks. Employees without an
override row are absent — they read the tenant default.

**Response 200:** `[{ employeeId, employeeName, current: { days, validFrom, validTo } | null, next: … | null }]`

**Responses:**
- `200` — possibly empty list
- `400` / `401` / `403` — as above
- `404` — `ATTENDANCE_TENANT_NOT_FOUND` (stale/unknown tenant — `attendance_today` fails loud)

#### `PUT /api/v1/attendance/weekly-offs/overrides/:employeeId` `[Bearer JWT, Role: owner]`

Sets one employee's override via `attendance_set_weekly_off_override`
(same AD-8 algorithm, keyed on the employee).

**Body:** `{ days: number[], effectiveFrom?: 'YYYY-MM-DD' }`

**Responses:**
- `200` — `{ employeeId, employeeName, current, next }`
- `400` — `VALIDATION_ERROR` (malformed employee id / no tenant)
- `404` — `ATTENDANCE_EMPLOYEE_NOT_FOUND` (employee not a tenant member) or `ATTENDANCE_TENANT_NOT_FOUND`
- `422` — `ATTENDANCE_NO_WORKING_DAYS` (7-day selection) or `VALIDATION_ERROR` (malformed `effectiveFrom`)

#### `DELETE /api/v1/attendance/weekly-offs/overrides/:employeeId?effectiveFrom=` `[Bearer JWT, Role: owner]`

Removes the override from `effectiveFrom` (default today) via
`attendance_remove_weekly_off_override` — clip-without-insert: earlier
override dates keep their override; from `effectiveFrom` the employee
reads the tenant default. Idempotent (no covering range → no-op).

**Responses:**
- `200` — post-removal state: `{ employeeId, employeeName, current, next }`
- `400` / `404` — as above
- `422` — `VALIDATION_ERROR` (malformed `effectiveFrom` query)

#### `GET /api/v1/attendance/holidays` `[Bearer JWT, Role: owner]`

Tenant-scoped holidays, ascending by date; the FE groups upcoming/past.

**Response 200:** `[{ id, date: 'YYYY-MM-DD', name }]`

**Responses:**
- `200` — possibly empty list
- `400` / `401` / `403` — as above
- `404` — `ATTENDANCE_TENANT_NOT_FOUND` (stale/unknown tenant — checked before the list read, the same fail-loud contract as the weekly-off reads)

#### `POST /api/v1/attendance/holidays` `[Bearer JWT, Role: owner]`

Adds a holiday via `attendance_add_holiday` (exclusive tenant lock).
Past dates are allowed and silent (day statuses recompute on read,
AD-10). Future dates fan an `attendance.holiday_added` notification out
to tracked employees **in the same transaction** (AD-13) — until Story
15-7 creates `attendance_enrolments` the recipient branch is a guarded
no-op (zero notifications, correct: nobody can be tracked yet).

**Body:** `{ date: 'YYYY-MM-DD', name: string (≤80, trimmed) }`

**Responses:**
- `201` — `{ id, date, name }`
- `400` — `VALIDATION_ERROR` (no tenant)
- `404` — `ATTENDANCE_TENANT_NOT_FOUND` (stale/unknown tenant)
- `409` — `ATTENDANCE_HOLIDAY_TAKEN` (a holiday already exists on this date)
- `422` — malformed date (ValidationPipe)

#### `PATCH /api/v1/attendance/holidays/:id` `[Bearer JWT, Role: owner]`

Renames a holiday via `attendance_update_holiday` (guarded UPDATE). The
**date is immutable** — impact and notifications differ per date; a date
change is remove + add. A `date` key in the body is rejected 422 even
though the global pipe silently strips unknown keys (explicit raw-body
check).

**Body:** `{ name: string }`

**Responses:**
- `200` — `{ id, date, name }`
- `400` — `VALIDATION_ERROR` (malformed id / no tenant)
- `404` — `ATTENDANCE_HOLIDAY_NOT_FOUND` (unknown holiday) or `ATTENDANCE_TENANT_NOT_FOUND` (stale/unknown tenant — the RPC resolves `attendance_today` first, so these are distinct codes)
- `422` — `VALIDATION_ERROR` (`date` key present in the body)

#### `DELETE /api/v1/attendance/holidays/:id` `[Bearer JWT, Role: owner]`

Hard-deletes via `attendance_remove_holiday` (no archive — FR-20). Removed
**future** dates fan an `attendance.holiday_removed` notification out to
tracked employees so a planned day off doesn't vanish silently
(scope decision 2026-09-27); pre-15-7 this is a guarded no-op.

**Responses:**
- `204` — removed
- `400` — `VALIDATION_ERROR` (malformed id / no tenant)
- `404` — `ATTENDANCE_HOLIDAY_NOT_FOUND` (unknown holiday) or `ATTENDANCE_TENANT_NOT_FOUND` (stale/unknown tenant — the RPC resolves `attendance_today` first, so these are distinct codes)

#### `GET /api/v1/attendance/holidays/impact?date=` `[Bearer JWT, Role: owner]`

AD-24 preview: employees the holiday would affect. **Returns an empty
list until 15-7 lands** (the tracked-employee query is behind the same
`to_regclass` guard — never a 42P01). **Employees on approved leave
overlapping the date arrive with Epic 17** (this route's extension point;
the holiday-inside-leave notification ACs are re-tested there).

**Response 200:** `{ date, affectedEmployees: [{ employeeId, employeeName }] }`

**Responses:**
- `200` — empty list pre-15-7 (never a 42P01)
- `400` — `VALIDATION_ERROR` (no tenant)
- `404` — `ATTENDANCE_TENANT_NOT_FOUND` (stale/unknown tenant — the RPC fails loud on `attendance_today`)
- `422` — malformed `date` (ValidationPipe)

**DB foundation (this story, additive):** `attendance_weekly_off_defaults`
and `attendance_weekly_off_overrides` (`valid daterange` + `EXCLUDE USING
gist` non-overlap on tenant_id / employee_id, `days` weekday-CHECKs,
`cardinality(days) < 7` CHECK, `UNIQUE (id, tenant_id)` on users + composite
child FK per the 15-3 hardening) and `holidays` (`UNIQUE (tenant_id,
holiday_date)`); RPCs `attendance_set_weekly_off_default`,
`attendance_set_weekly_off_override`,
`attendance_remove_weekly_off_override`, `attendance_add_holiday`,
`attendance_update_holiday`, `attendance_remove_holiday`, and the read
function `attendance_holiday_impact` — every one SECURITY DEFINER,
executable by service_role only (AD-3). All three tables: RLS enabled, no
policies (deny-by-default, admin-client only). Notification dedupe keys are
recipient-prefixed: `<tenantId>:<eventType>:<recipientId>:<holidayId>` (the
14-2 convention). The AD-13 backend event registry lives in
`src/attendance/notification-events.ts` (the FE mirrors it in 15-6).

---

### Attendance enrolments & access (Epic 15, Story 15-7 — owner writes, technician reads)

FR-2/FR-6 enrolment lifecycle and the AD-17 access state. **No new RPCs**
(user decision 2026-09-28, AD-3 amendment): the lifecycle writes run as ONE
pg transaction each over the direct Postgres pool (`DATABASE_URL` — direct
or session-pooler; never the transaction pooler), taking the existing
`attendance_lock_tenant` (shared) + `attendance_lock_employee` (exclusive)
helpers (AD-5, same lock space as the RPCs) and the existing
`attendance_today` (AD-7); the AD-8 algorithm
(delete-future → clip-covering → insert, `effective_from = greatest(from,
today)`) is computed in `enrolments-response.model.ts` and executed in
`enrolments.repository.ts`. A `DEFERRABLE INITIALLY DEFERRED` coverage
constraint trigger (DB authority, NFR-4 — checked at COMMIT, since the
enable co-writes two tables in separate statements) rejects any state where
an enrolled date lacks its assignment or an assignment pokes outside an
enrolment — surfaced as 422 `ATTENDANCE_ASSIGNMENT_GAP`. Liveness is
required only for CURRENT-OR-FUTURE periods; closed history stays valid
after its office is archived. There is **no bulk route**: FR-2's "enable
all" is an FE loop of the single-employee PUT (each employee commits
independently; per-employee failures are retried individually).

**Access state** is computed once, in SQL, by the `attendance_access_state`
view (revoked from anon/authenticated; admin client + pg pool only):
`none` (never tracked, or the module kill switch
`attendance_settings.enabled = false` — no attendance UI for anyone while
off, history untouched), `upcoming` (next period starts in the future),
`active` (an enrolment covers today), `history_only` (past periods only),
plus `attendance_start_date`, `enabled_at`, `onboarded_at` and the live
covering assignment's office (anchored at **today** for an active
employee — a reassignment moves the assignment forward while the
enrolment's period start stays behind — and at the next period's start
when upcoming; 20260928000001). Every surface below reads those same rows.

**DB foundation (this story, additive):** `attendance_enrolments
(employee_id, valid daterange, enabled_at)`,
`attendance_office_assignments (employee_id, office_id, valid)` — both
AD-8 (`EXCLUDE USING gist` non-overlap, composite FKs onto
`users(id, tenant_id)` / `attendance_offices(id, tenant_id)`); 
`attendance_onboarding (employee_id PK, onboarded_at)`; RLS enabled, no
policies on all three (deny-by-default). Reconciled pre-existing function
bodies (signatures unchanged): complete-setup **Gate 2 now requires a live
office**; the archive-blocker predicate is shared by
`attendance_archive_office` / `attendance_office_archive_blockers`, ordered,
deduped, and blocks on any current-or-future assignment of an enrolled
employee; the holiday notification recipients and the impact preview use
the tracked predicate (enrolment covers the date + live covering
assignment). `attendance_records` does not exist yet — FR-6's
"checked in today → applies from tomorrow" is probed and self-activates in
Epic 16. `/users/me` (technician branch) carries the same access fields for
first load, read from the view via the admin client (no attendance module
import).

#### `GET /api/v1/attendance/enrolments` `[Bearer JWT, Role: owner]`

The roster: one row per technician — `{ employeeId, employeeName, phone,
attendanceEnabled, attendanceAccess, attendanceStartDate, attendanceEndedOn,
enabledAt, onboardedAt, officeId, officeName }` (state from the view; names from
users). Empty only when the tenant has no technicians (200 `[]`, never
404) — enrolled or not, EVERY technician gets a row. `attendanceEndedOn`
carries the me/access history_only-only semantics (19-6).

**Field semantics (read before consuming — misreading these shipped a
broken consumer once):** `attendanceEnabled` is the TENANT MODULE flag
(`settings.enabled AND setup_completed_at IS NOT NULL`) — false for every
row until setup completes; it is NOT "this employee is enrolled". The
per-employee enrolment truth is `attendanceStartDate`, carried UNGATED:
`<= today` the enrolment covers today, `> today` upcoming, `null` not
enrolled (null never means "covers today"). `officeId`/`officeName` are
the LIVE covering assignment (null while none covers today / the next
period, or while its office is archived). `attendanceAccess` is the
module-gated visibility state — a consumer gated on it sees nothing until
setup completes; derive per-employee state from the ungated fields.

**Responses:** `200`; `400 VALIDATION_ERROR` (no tenant); `401/403`;
`404 ATTENDANCE_TENANT_NOT_FOUND`.

#### `PUT /api/v1/attendance/enrolments/:employeeId` `[Bearer JWT, Role: owner]`

Enables attendance (FR-2) — or changes / re-states a future start date —
co-writing the enrolment and the office assignment in one transaction.
`startDate` defaults to today; past dates are clamped (never a 422).

**Body:** `{ officeId: uuid, startDate?: 'YYYY-MM-DD' }`

**Responses:**
- `200` — the post-write access state
- `400` — malformed employee id / no tenant / bad date
- `404` — `ATTENDANCE_EMPLOYEE_NOT_FOUND` (not a tenant member) |
  `ATTENDANCE_OFFICE_NOT_FOUND` | `ATTENDANCE_TENANT_NOT_FOUND`
- `409` — `ATTENDANCE_OFFICE_ARCHIVED` (enrol with a live office)
- `422` — `ATTENDANCE_ASSIGNMENT_GAP` (coverage trigger rejected at COMMIT)

#### `PUT /api/v1/attendance/enrolments/:employeeId/office` `[Bearer JWT, Role: owner]`

FR-6 reassignment. `effectiveFrom` defaults to today and must fall inside
an enrolment (for an upcoming employee, pass their start date); applies
from tomorrow automatically once `attendance_records` exists and the
employee has checked in today.

**Body:** `{ officeId: uuid, effectiveFrom?: 'YYYY-MM-DD' }`

**Responses:** as the PUT above, plus `422
ATTENDANCE_ASSIGNMENT_NOT_ENROLLED` (no enrolment covers the date).

#### `DELETE /api/v1/attendance/enrolments/:employeeId` `[Bearer JWT, Role: owner]`

Disables (FR-2): both ranges clipped at `effectiveFrom` (default today),
history read-only; cancelling a future start removes the rows entirely.
Idempotent.

**Query:** `effectiveFrom?: 'YYYY-MM-DD'`

**Responses:** `200` post-disable state (`history_only` after a past period;
`none` when the same-day start was cancelled outright — a never-enrolled or
already-disabled employee is an idempotent 200 with unchanged state);
`400`/`401`/`403`/`404` as above.

#### `GET /api/v1/attendance/me/access` `[Bearer JWT, Role: technician]`

AD-17: the entry-point gate. The employee id comes only from the JWT.

**Response:** `{ attendanceEnabled, attendanceAccess, attendanceStartDate,
attendanceEndedOn, enabledAt, onboardedAt, officeId, officeName }` — kill
switch off forces `attendanceAccess: 'none'`. `attendanceEndedOn` (19-6)
is the LAST TRACKED DAY (`YYYY-MM-DD`) for the "tracking ended on" note,
populated ONLY in `history_only` by the view's CASE gate (`null` while
active/upcoming, so a disable→re-enrol employee never carries a stale
date; `null` never means "ended today" — gate on `attendanceAccess`
first). View semantics (20260930000001): `max(upper(valid)) - 1` over
closed enrolment periods, excluding `'infinity'` uppers.

**Responses:** `200`; `401`; `403` (non-technician role); `500` if the view
read fails (fail-loud, never a fabricated state).

#### `POST /api/v1/attendance/me/onboarding` `[Bearer JWT, Role: technician]`

FR-4: records onboarding completion, once per employee (upsert with
`ignoreDuplicates`); replays answer 200 with the ORIGINAL `onboardedAt`.

**Response:** `{ onboardedAt }` — recording is allowed in any access state
(the server records; the FE gates the UI); replays answer the original value.

**Responses:** `200`; `401`; `403` (non-technician role); `400
VALIDATION_ERROR` (no tenant).

#### `GET /api/v1/attendance/me/summary` `[Bearer JWT, Role: technician]`

Story 15-10: the FR-4 onboarding/entry summary — Office, Start/End time,
Late cut-off, Weekly offs — for the states that have an anchored office.
Office and the effective date come from the SAME `attendance_access_state`
view row `me/access` reads (the office join anchored at TODAY when active,
at the next period's start when upcoming), so the two endpoints can never
disagree about which office applies. The rule shown is the office rule row
covering that effective date (FR-5: rule changes apply from tomorrow);
weekly offs are the employee's override covering it if one exists, else the
tenant's effective defaults (an override with an empty `days` array = works
all 7 days).

**Response:** `{ officeId, officeName, startTime, endTime,
lateCutOffMinutes, weeklyOffDays, officeLatitude, officeLongitude, today,
todayRecord }`. Times travel as `HH:mm` (the API convention — 12-hour
display is the app's job, NFR-5). `weeklyOffDays` are ISO weekday numbers
`1=Mon..7=Sun`, sorted ascending; `[]` = no weekly offs. Fields are `null`
when the state carries no anchored office.

**Today extension (Story 16-4, active employees only):**
`officeLatitude`/`officeLongitude` are the anchored office's pin (display
inputs — the app's distance hint is display-only, NFR-2). `today` is
`{ date, isWeeklyOff, isHoliday, holidayName, isWorkingDay, leaveState,
leavePart }` for the server's today (AD-7) — the pre-flight dialog's
input, so the app never derives a weekday or holiday client-side.
`leaveState` is `'pending' | 'approved' | null` — today's ACTIVE leave
(Story 17-8): a `leave_request_days` row covering today in a live state,
null when none does (cancelled/revoked/no leave all read null);
`leavePart` mirrors the covering request's part
(`'full_day' | 'first_half' | 'second_half'`), null with `leaveState`.
The app checks in straight through a pending/approved leave at its own
risk — the server still owns every verdict (the D11 gate asks for
confirmation only on `leaveState != null && leavePart === 'full_day'`
working days). `todayRecord` is
`{ checkinAt, checkoutAt, lateMinutes, isLate, workedMinutes, earlyCheckout,
earlyCheckoutMinutes }` — field names/semantics mirror the check-in/out
responses; instants carry the tenant offset (AD-7/D11); `lateMinutes` is
null when no rule covers today (D7); `workedMinutes`/`earlyCheckout*` are
null until check-out; early checkout grades against the rule end (the
leave-aware midpoint is Epic 18's grading concern). Both are `null` for
`upcoming` (the anchor there is a future date) and in the honest-empty
payload.

**Responses:** `200` (also for `none`/`history_only` — an honest empty
payload, the endpoint is not defined for those states and the app never
calls it there); `401`; `403` (non-technician role); `404`
`ATTENDANCE_TENANT_NOT_FOUND` only if the tenant row vanishes between the
view read and the tenant-date resolution (defence in depth — fail-loud);
`500` if any read fails (fail-loud, never a fabricated rule).

---

### Attendance check-in & check-out (Epic 16, Stories 16-1/16-2, technician only)

One pg transaction per call over the direct pool (the 15-7 pattern — zero
new SQL functions per the AD-3 amendment, 2026-09-27): shared tenant lock →
exclusive employee lock (AD-5), `attendance_today` for the date (AD-7), the
day context computed in `src/attendance/day-context.ts` (the single source
of the per-employee-date facts, AD-22). Rejections are COMMITTED outcomes
first — every call that passes validation writes exactly one
`attendance_attempts` row (AD-6/AD-15) — and are then answered as ordinary
errors; throwing inside the transaction would roll the attempt back, so the
exception is raised only after COMMIT.

**Headers:** `X-Idempotency-Key: <uuid v4>` — required; missing/malformed →
`422 VALIDATION_ERROR` with no attempt row (AD-6). One key per user tap.

**Body (both routes, the AD-20 capture object):**
`{ latitude, longitude, accuracyM, mocked?: boolean|null, provider?:
string|null, fixAgeMs, confirmLeaveCancel?: boolean }`. `mocked: null` =
not detected. `confirmLeaveCancel` is accepted and ignored until Epic 17.

- `POST /api/v1/attendance/me/check-in` → `201` (one `attendance_records`
  INSERT per `UNIQUE (employee_id, work_date)`)
- `POST /api/v1/attendance/me/check-out` → `201` (one guarded UPDATE of the
  same row; `not_checked_in` when none, `already_checked_out` when closed)

**Check-in response:** `{ workDate, checkinAt, lateMinutes, isLate,
dayContext: { isWeeklyOff, isHoliday, holidayName, isWorkingDay } }`.
**Check-out response:** `{ workDate, checkinAt, checkoutAt, workedMinutes,
earlyCheckout, earlyCheckoutMinutes, dayContext }`. Instants are ISO-8601
**with the tenant offset** (`2026-09-28T10:22:00+05:30`, AD-7) — the app
formats the wall-clock parts and never converts timezones. `lateMinutes` /
`earlyCheckout*` are `null` when no office rule covers today (D7).
`lateMinutes = max(0, checkin − (start + lateCutOff))`,
`workedMinutes` from the stored instants, truncated to whole minutes.

**Server-side checks, in priority order (first wins):** rate-limit block
(AD-15) → tracked gate (enrolment covers today + setup completed + module
enabled; the FR-2 enable-day grace cannot block the check-in itself) →
state conflicts → `stale_fix` (`fixAgeMs > 30000`, AD-20) →
`low_accuracy` (`accuracyM > 100`) → `too_far` (haversine(pin, fix) >
radius, distance computed server-side) → `mocked`. Weekly offs and
holidays do NOT block check-in (FR-7 — the app confirms before calling).

**Rate limit (AD-15):** only `too_far`/`low_accuracy`/`mocked`/`stale_fix`
count. The 5th counted rejection within 10 minutes sets `blocked_until` =
its time + 10 min; further attempts record `rate_limited` (not counted)
and get `429` + `Retry-After`. The window is shared by check-in and
check-out.

**Fake-location alert (AD-13):** on the 3rd `mocked` attempt of the
tenant-local calendar month the owner receives one
`attendance.fake_location` notification (payload `employeeName`, `month`,
`attemptCount`), deduped by
`<tenantId>:attendance.fake_location:<ownerId>:<employeeId>:<yyyy-mm>`.

**Error catalogue (AD-4 + `already_checked_out`):**

- `422 ATTENDANCE_TOO_FAR` — body carries `distanceM` + `radiusM`
- `422 ATTENDANCE_LOW_ACCURACY`
- `422 ATTENDANCE_MOCK_LOCATION`
- `422 ATTENDANCE_STALE_FIX`
- `429 ATTENDANCE_RATE_LIMITED` — `Retry-After` header
- `409 ATTENDANCE_ALREADY_CHECKED_IN` / `409 ATTENDANCE_ALREADY_CHECKED_OUT`
- `409 ATTENDANCE_NOT_CHECKED_IN`
- `403 ATTENDANCE_NOT_TRACKED`
- `409 ATTENDANCE_LEAVE_CONFIRMATION_REQUIRED` — enum reserved for Epic 17

A replayed idempotency key returns the stored outcome (success rebuilt from
the record) with no second attempt row or side effect. Coordinates on
rejected attempts are kept for the owner's dispute view; the 90-day prune
is Epic 19 pg_cron work (AD-26).

**Responses:** `201` on success; `401`; `403` (non-technician role or
not-tracked); `422` (location catalogue or body validation); `429`; `500`
only for contract breaks (fail-loud).

---

### Places (Epic 1 + Story 15-4, owner only)

Google Places/Geocoding-backed address endpoints. No DB involvement
(AD-2). Every endpoint is rate-limited **per tenant** (429s carry a
`Retry-After` header with the window's remaining seconds; budgets tune via
the optional `PLACES_{AUTOSUGGEST,RESOLVE,REVERSE}_RATE_LIMIT_{MAX,WINDOW_SECONDS}`
env vars — defaults 30 / 10 / 10 per 60s window respectively).

#### `GET /api/v1/places/autosuggest?q=&sessionToken=` (owner only)

Free-text address search (3-char minimum server-enforced). Session token
groups one autosuggest→resolve session (Google billing semantics) —
client-generated, reused across every autosuggest call and the terminating
resolve.

**Response 200:** `{ suggestions: [{ placeId, text }] }` (possibly empty)

---

#### `GET /api/v1/places/resolve/:placeId?sessionToken=` (owner only)

Resolves an autosuggest selection into a full address + coordinates.

**Response 200:**
```json
{
  "placeId": "…",
  "formattedAddress": "Andheri West, Mumbai, Maharashtra 400058, India",
  "city": "Mumbai",
  "pincode": "400058",
  "latitude": 19.1364,
  "longitude": 72.8296
}
```
`city`/`pincode` are `null` when the place lacks them (never omitted or
`''`). A place Google cannot locate surfaces as a 502, never a
null-coordinate success.

---

#### `GET /api/v1/places/reverse?lat=&lng=` (owner only, Story 15-4)

Reverse geocodes raw coordinates (the map-picker pin row). Google's legacy
Geocoding API under the hood — same server-side key (its project must have
the Geocoding API enabled), no session token (this API is billed per call;
the per-endpoint rate limit bounds abuse).

**Response 200:** all three fields `null` when the point has no address
(e.g. open water) — a "not found" point is a success, never a 404; the
caller falls back to showing the raw coordinates.
```json
{
  "formattedAddress": "Andheri West, Mumbai, Maharashtra 400058, India",
  "city": "Mumbai",
  "pincode": "400058"
}
```

Open-water point (no address anywhere near) — the payload the app must
handle when the owner drops the pin off-shore; the row falls back to the
raw coordinates:
```json
{
  "formattedAddress": null,
  "city": null,
  "pincode": null
}
```

**Errors:** 422 (lat/lng outside `[-90, 90]` / `[-180, 180]` or
non-numeric), 429 rate-limited, 502 `PLACES_UPSTREAM_ERROR` on any
Google/network failure or timeout.

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

---

### Leave management (Epic 17, Stories 17-1..17-4)

Three tables (`leave_requests`, `leave_request_days`, `leave_events` —
migration `20260929000001`), zero new RPCs beyond the AD-11 state guard
trigger `leave_request_days_state_guard()`; every write is one pg
transaction in NestJS reusing the AD-5 lock helpers (spec:
`spec-17-1-to-17-4-backend-leave-management.md`). Day states live ONLY in
`leave-transition.ts` (AD-23's single writer); request-level status is
DERIVED on read (order: pending > approved > revoked > cancelled >
rejected, `DERIVED_STATUS_ORDER` in `leave.model.ts`) and `workingDays`
recompute from current weekly-off/holiday facts.

**Technician routes (`/api/v1/attendance/me/leave`):**

- `GET …/me/leave/preview?startDate&endDate?&part?` → `200`
  `{ ok: true, workingDays, totalDays, part, dates[] }` or
  `200 { ok: false, errorCode, message }` — the same validation path as the
  write, persists nothing; the app renders rejections inline.
- `POST …/me/leave` — body `{ startDate, endDate?, part?, reason }` +
  `X-Idempotency-Key` (required, UUID v4) → `201` request view. Replays
  return the stored view with no second row; a key raced by a DIFFERENT
  caller answers `409 DUPLICATE_RESOURCE`.
- `GET …/me/leave?cursor&limit` → own history (cursor scope `leave-me-list`).
- `GET …/me/leave/:id/preview` → `200 { action: 'cancel', actionDates,
  keepDates, request }` (empty `actionDates` when nothing is actionable —
  previews never 409).
- `POST …/me/leave/:id/cancel` → `200` refreshed view + `cancelledDates`;
  no reason (FR-15). Own retry answers `200`; a conflicting state `409
  LEAVE_NOT_CANCELLABLE`.

**Owner routes (`/api/v1/attendance/leave`):**

- `GET …/leave?status?&employeeId?&cursor&limit` → `PaginatedResponse`
  (cursor scope `leave-owner-list`); `status=pending` is the queue; the
  filter matches the DERIVED status.
- `GET …/leave/:id/preview` → revoke split (as above).
- `POST …/leave/:id/approve` / `POST …/leave/:id/reject` (`{ reason? }` —
  empty valid) → `200` refreshed view; own retry `200`, conflict `409
  LEAVE_NOT_PENDING`.
- `POST …/leave/:id/revoke` (`{ reason }` required) → `200` refreshed view
  + `revokedDates`.
- `POST …/leave/on-behalf` — `{ employeeId, startDate, endDate?, part?,
  reason }` + `X-Idempotency-Key` → `201` with every day APPROVED
  immediately (FR-16); a target outside the tenant answers `404
  ATTENDANCE_EMPLOYEE_NOT_FOUND` before any other check.

**The five apply rejections, in report order (first wins):** span/format
(`LEAVE_INVALID_RANGE`, incl. the 62-day cap) → start-date floor
(`LEAVE_BEFORE_START_DATE` — an UPCOMING employee may apply from their
start date, FR-12) → 7-days-back (`LEAVE_TOO_OLD`) → a past-or-today date
with a check-in (`LEAVE_CHECKED_IN_CONFLICT`) → every date off
(`LEAVE_ALREADY_OFF`, "These days are already off") → overlap
(`LEAVE_OVERLAP`, 409).

**Split rule (revoke & cancel):** actionable = future dates, or today
while now(tenant tz, DB clock) < that day's Office Start; revoke takes
`approved` days only, cancel takes `pending`+`approved`. Past days (and
today after the cutoff) STAY in their state — the request splits; when no
rule covers today the cutoff counts as NOT passed.

**FR-9 (check-in × leave):** a full-day active (pending/approved) leave on
a WORKING day makes check-in answer `409
ATTENDANCE_LEAVE_CONFIRMATION_REQUIRED` (a committed, rate-limit-exempt
attempt row) until the client sends `confirmLeaveCancel: true`; the
confirmed path cancels ONLY today's date after the location ladder passes
(a rejected attempt never touches leave) and notifies the owner once per
date. Half-day leave dates and weekly-off/holiday days inside a span never
gate. On a first-half leave day `lateMinutes` is computed from the
midpoint (FR-7); on a second-half leave day `earlyCheckout` compares to
the midpoint.

**Notifications (`leave.*`, entity_type `leave`, entity_id = the request):
** applied (owner), applied_on_behalf (employee), approved, rejected
(reason when given), owner_revoked (exact dates + reason),
employee_cancelled (owner), cancelled_by_disable, checkin_auto_cancel
(owner, deduped per date). Disabling an employee cancels ALL their pending
leave plus approved leave from the disable's effective date (AD-23).

## Day statuses & corrections (Epic 18, Stories 18-1/18-2)

Two tables (migration `20260929000002`, review-hardened by
`20260929000003` — the at-rest status-XOR-instants check and the
corrections history page index): `attendance_day_overrides` — one
ACTIVE row per `(employee_id, work_date)` (`UNIQUE`, status
present | half_day | absent XOR manual instants, `deleted_at` soft
removal; the engine reads only `deleted_at IS NULL` rows, so a removal
recompute-lives on the next read) — and `attendance_corrections`, an
append-only audit chain (per-date `seq`, note 1-500, old/new value JSON).
New in the same migration: `attendance_attempts.acknowledged_at` (the
AD-10 fake-location marker lifecycle). Zero new stored functions (AD-3
amendment); all logic lives in `day-status.model.ts` (the FR-10 engine)
and `corrections.service.ts` under the AD-5 employee lock.
Spec: `spec-18-1-and-18-2-backend-day-status-and-corrections.md`.

**The FR-10 engine (one implementation):** first-match-wins per
employee-date — 1 active correction (status arm short-circuits; a
times-only arm substitutes instants per field and evaluation CONTINUES,
so a corrected check-in on an off-day reads `worked_on_holiday`) →
2 `not_tracked` → 3 `worked_on_holiday` (weekly off ∪ holiday with a
check-in; no Late/Early flags on off-day statuses) → 4 `weekly_off`
/ `holiday` → 5 approved full-day leave, no check-in (`leave`,
leaveCredit 1) → 6 `half_day_leave` (today's open record defers to rule
10; the checkout_missing arm is past-only) → 7 graded
present / half_day / absent by the worked minutes → 8 past open record
(`checkout_missing`, daysWorked 0 until corrected) → 9 past `absent` →
10 today/future (`not_checked_in_yet` / `in_progress`). Markers:
`corrected` (active override), `leave_pending` (any pending part),
`checkout_missing`, `fake_location_attempt` (unacknowledged mocked
attempts — clears on acknowledge, AD-10). FR-11 credits per row:
`daysWorked` (present 1, half_day 0.5, earned half 0.5, else 0),
`leaveCredit` (1 / 0.5), `workedOnHolidayCredit` (1 / 0.5 / 0); leave
outranked by rules 1/3/4/7 stays data-only with zero credits — Epic 19
sums these same rows.

**Routes (`/api/v1/attendance`; cross-tenant ids answer 404
`ATTENDANCE_EMPLOYEE_NOT_FOUND` — no existence leak):**

- `GET /attendance/day-statuses?employeeId&from&to` `[owner]` →
  `200 { employeeId, from, to, today, days: DayStatusRow[] }` — every date of the
  range, oldest first; `today` is the tenant-local date the read ran under
  (spec-18-3 D2 — clients never derive a device date); `from ≤ to`, span ≤ 62
  days (else `422
  ATTENDANCE_INVALID_RANGE`); future dates valid input. `DayStatusRow`:
  `{ workDate, status, lateMinutes, isLate, earlyCheckoutMinutes,
  earlyCheckout, workedMinutes, daysWorked, leaveCredit,
  workedOnHolidayCredit, isWeeklyOff, holidayName, isWorkingDay,
  officeId, officeName, checkinAt, checkoutAt,
  checkinSource: 'gps'|'manual'|null, checkoutSource,
  checkinDistanceM, checkoutDistanceM, markers,
  latestCorrection?, leaveRequestId }`; instants are tenant-offset ISO (AD-7); the
  distances (metres, the stored record columns) are surfaced ONLY for
  gps-sourced instants — a times-only correction substitutes manual
  instants while the stored distance describes the original GPS fix, so
  the field is null for a manual source or a record-less day (spec-18-3 D2).
  `leaveRequestId` (20-1): the covering `leave_requests.id` when the day
  carries an active pending/approved leave day-row, `null` otherwise —
  per-day request ids ride ONLY these day-status rows (the profile mirror
  and the access summary never carry them). The FE sheet uses it to
  resolve the request for its leave actions: a still-pending day's id goes
  to the technician cancel route, and "convert to full day" is a FE
  composition of cancel + re-file (the BE serves only
  `POST /attendance/me/leave/:id/cancel` and the apply route — no convert
  route). A stale id on a raced day answers
  `409 LEAVE_NOT_CANCELLABLE` and the FE re-resolves the day.
- `GET /attendance/me/day-statuses?from&to` `[technician]` → same rows
  (and the same `today` echo) for the JWT identity; the AD-17 gate answers
  `403 ATTENDANCE_NOT_TRACKED`
  when access state is none (history_only stays readable).
- `PUT /attendance/corrections/:employeeId/:workDate` `[owner]` — body:
  exactly one of `{ status: 'present'|'half_day'|'absent', note }` XOR
  `{ checkinAt, checkoutAt?, note }` (a checkout alone → `422
  VALIDATION_ERROR`; no `X-Idempotency-Key` — AD-6's letter: a replay is
  a legitimate re-correction). A malformed `employeeId` (non-UUID) and a
  malformed `workDate` both answer `422 VALIDATION_ERROR` pre-DB — never
  Postgres's raw 400. Gates in order: 404
  employee scope + note hygiene (trim, control chars, 1-500) → `422
  ATTENDANCE_FUTURE_DATE` (workDate > tenant today) → `422
  ATTENDANCE_DATE_NOT_TRACKED` → instants anchor the work date (check-in
  exactly; check-out on the date or +1 day; NEITHER instant after DB now
  → `422 ATTENDANCE_INVALID_RANGE`) → upsert + ONE audit row. `200 { workDate,
  override, correctedAt, actorId }`; `attendance_records` is never touched.
- `DELETE /attendance/corrections/:employeeId/:workDate` `[owner]` → soft
  delete → `200 { deleted: boolean }`, `200 { deleted: false }` on an own
  retry; ONE audit row ("Removed correction", new value empty).
- `GET /attendance/corrections?employeeId&workDate?&cursor&limit`
  `[owner]` and `GET /attendance/me/corrections?workDate?` `[technician]`
  (the owner read 404s a foreign employee no-leak; a malformed
  `employeeId` → `422 VALIDATION_ERROR`, same as the write routes; the
  `me` read 403s `ATTENDANCE_NOT_TRACKED` when the access state is none)
  → `PaginatedResponse` of `{ id, employeeId, workDate, correctedAt,
  actorName, note, oldValue, newValue }`. Page bounds: `limit` 1-50
  (default 20); pages order `created_at desc, id desc`; a foreign-scope
  cursor → `400 VALIDATION_ERROR 'Invalid cursor'`. The
  `attendance_correction_audit.seq` identity column is reserved for the
  last-guard recompute chain — no consumer today; history reads order by
  `created_at desc, id desc`, not `seq`. Cursors scope
  `day-corrections-owner` / `day-corrections-me` — a cursor never replays
  across the two endpoints.
- `POST /attendance/attempts/acknowledge` `[owner]` — body
  `{ employeeId, workDate }` → `200 { acknowledgedCount }` (200 even at
  0; the attempt rows are kept for the dispute view, AD-4). Deliberate
  asymmetry vs PUT/DELETE: acknowledge runs only the workDate-shape and
  employee-404 gates — no future-date or track-day gate — because it
  filters attempt rows rather than asserting a state change, and
  accepting any date yields 200 at 0 instead of an error.

**Interaction with leave (D2 mirror gate):** a leave apply or on-behalf
apply (and the apply preview) rejects a target date carrying a
NON-absent override — status present | half_day, or a times-only
correction — with `LEAVE_CHECKED_IN_CONFLICT`; approved leave may sit
only under a plain `absent` correction. The same code intentionally
serves both arms (a check-in conflict and a correction conflict) — the
message distinguishes them ("already checked in" vs "You have a
correction on …"), a spec-sanctioned reuse so clients gate on one code.
A correction landing on a date
covered by active leave (pending or approved) is always allowed — the
engine's recompute decides which side wins the status by the FR-10 order.

## Scheduled reminders & read views (Epic 19, Stories 19-1/19-2/19-3)

Migration `20260929000004` (pg_cron — AD-14, the ONE sanctioned SQL-side
behaviour in Epics 16–19; everything else stays NestJS-first, AD-22 = the
TS `DayContext`).

**19-1 — `attendance_run_reminders()` every 5 minutes** (`attendance-run-reminders`;
per-tenant `BEGIN…EXCEPTION → RAISE WARNING` with the tenant id only — one
tenant's failure never stops the others; dedupe keys are the 14-2
tenant-prefixed shape riding the `notifications.dedupe_key` partial unique
index with `ON CONFLICT DO NOTHING`, so a re-run never re-notifies). Fires
only when an office rule, the enrolment AND the assignment all cover today
(no rule → the employee drops out entirely) and never on weekly offs or
holidays. Approved leave shifts/suppresses; pending leave suppresses
nothing. Registry entries: `notification-events.ts` (AD-13 — the FE mirror
is the Epic 19 FE stories' work).

| Event (recipient) | Due instant (tenant wall time) | Payload (camelCase) | Dedupe key (tenant-prefixed) |
|---|---|---|---|
| `attendance.reminder_checkin` (employee; wave 1) | Start + Late cut-off (Midpoint + cut-off on an approved first-half leave day; an approved FULL-day leave suppresses) | `{ workDate }` | `<tenantId>:attendance.reminder_checkin:<recipientId>:<workDate>` |
| `attendance.reminder_checkout` (employee; wave 1) | Expected end + actual late minutes (`late = 0` → Expected end; Midpoint + late on an approved second-half leave day) | `{ workDate, checkinAt }` | `<tenantId>:attendance.reminder_checkout:<recipientId>:<workDate>` |
| `attendance.reminder_not_checked_in` (owner per office; wave 2) | Start + Late cut-off | `{ officeName, notCheckedInCount, workDate }` | `<tenantId>:attendance.reminder_not_checked_in:<recipientId>:<workDate>:<officeId>` |
| `leave.pending_reminder` (owner; wave 2) | 10:00 tenant wall time, once per day | `{ pendingCount }` | `<tenantId>:leave.pending_reminder:<recipientId>:<workDate>` |

Reminder recipients are FR-2-tracked and grace-aware (the enable-day grace
skips the check-in reminder and the summary count); a status-only day
override is an owner adjudication and suppresses both the employee
reminders and the summary count for that day. Two hygiene jobs ship
alongside: `cron-job-run-details-cleanup` (daily 03:00 — prunes
`cron.job_run_details` past 7 days) and
`attendance-attempts-coordinate-cleanup` (daily 03:10 — AD-26: nulls the
coordinates of `outcome <> 'ok'` attempt rows after 90 days; accepted
records' coordinates are kept forever).

**NFR-9 (the reminder job's Grafana signal):** two OTel ObservableGauges —
`attendance.reminder_job.runs` (last-24 h run count, the
`cron.job.status` = succeeded | failed attribute) and
`attendance.reminder_job.last_run_age_seconds` — observed at EXPORT time
over `cron.job_run_details` via the pg pool seam
(`src/telemetry/app-metrics.ts` + `ReminderJobMetricsBinder`). No timer in
the web service (AD-14 posture), no new tables (AD-26). No finished run in
the window → the gauges observe nothing.

**18-5 fold-in — `attendance_complete_setup` gate 3** (migration
`20260929000005`): every ACTIVE office must carry an office rule covering
today at completion — else `422`-shaped PT422 with
`ATTENDANCE_SETUP_INCOMPLETE` (`hint` the FE wizard maps). The gate
messages are **owner-facing** and tell the owner WHY and what to do — gate
3: "attendance setup could not be completed: office ««office»» has no
timing rule covering today. Add a rule for this office, then try again.";
gates 1–2 use the same owner-friendly treatment; the raw tenant-id text
lives only in the SQL `detail` (never user-facing).

**Read routes (aggregated in TypeScript over the 18-x day-status engine —
one implementation; a dashboard/calendar/summary cell can never disagree):**

#### `GET /api/v1/attendance/dashboard?officeId=` `[Bearer JWT, Role: owner]`

FR-24, today only (no date params). Tiles: `tracked` (grid rows where the
engine tracks today), `checkedIn` (a presence grade — in_progress |
present | half_day | worked_on_holiday; includes a rule-1 status-only
`present`/`half_day` override even where no punch landed), `onLeave`
(a leave grade — `leave` | `half_day_leave`, however much of it was
actually worked), `notCheckedIn` (everything else — not_checked_in_yet,
weekly_off, holiday, and the not-short-day `absent` grades: an
owner-adjudicated `absent` override, or the past-no-check-in rule-9
`absent`), `late` (`outcome.isLate` — a qualifier of `checkedIn`; it
only counts inside that bucket and is not a bucket itself). The FOUR buckets PARTITION `tracked` (2026-10-01 ruling
after an on-device under-count: the bucket follows the OUTCOME STATUS —
the same grade the calendar cell shows — so a tile can never disagree
with the calendar; a punched half-day leaver reads on leave and their
worked half stays a day-sheet/summary truth). `shortDay` holds the
ENGINE-graded short-day rows — a rule-7 `absent`: a punch-in AND
punch-out that the engine graded below the half-day threshold, with no
owner status override (row moves out of `notCheckedIn`, never copies —
`tracked = checkedIn + notCheckedIn + onLeave + shortDay`). An
owner-adjudicated `absent` override and the past-no-check-in rule-9
`absent` stay under `notCheckedIn` — the owner's word overrides the
tile, always. The optional `officeId` filters by
today's covering assignment office
(malformed → `422 VALIDATION_ERROR`; unknown-but-well-formed → `200`
with zeros + empty flags, never `404`).

**Flags:** `checkoutMissing` — past tracked dates with a check-in, no
check-out and no adjudicating override (engine rule 8's exact set,
override-only days included; clears when a correction lands);
`fakeLocationAttempt` — unacknowledged `mocked` attempts grouped per
employee-date with `attemptCount` (clears on acknowledge, AD-10). Rows:
`{ employeeId, employeeName, workDate, officeName }` (+ `attemptCount`),
ascending by workDate then name. A parity probe in the integration suite
pins flag-set ↔ engine markers.

**Responses:** `200` tiles + flags; `403` (non-owner); `422`
`VALIDATION_ERROR`; `500` fail-loud.

#### `GET /api/v1/attendance/monthly?from=&to=&officeId=` `[Bearer JWT, Role: owner]`

FR-25 — one summary row per tracked employee with any day in the range
(history-only/disabled employees included, FR-28; dates after disable read
`not_tracked` and drop out). `from ≤ to`, span ≤ **31 days**, `to ≤
tenant-today` (else `422 ATTENDANCE_INVALID_RANGE`). `officeId` filters by
today's covering assignment office (unknown → `200` empty roster, never
`404`). Office in each row = the assignment covering TODAY (the roster's
current office). Sorting: resolved name, then id.

**Response:** `{ from, to, today, employees: [{ employeeId, employeeName,
officeId, officeName, summary }] }` with
`summary: { daysWorked, halfDays, lateCount, leave, weeklyOffs, holidays,
workedOnHoliday, absent, checkoutMissing }` — Σ/count of the engine's
FR-11 credits over the same grid rows (no second implementation); a later
correction flips `checkoutMissing`/`absent` live. `today` is the
tenant-local clock (`YYYY-MM-DD`) the range check resolves — the same
value the `to ≤ tenant-today` check compares against, echoed so the FE
shapes its request window from the wire, never the device clock (19-5).

#### `GET /api/v1/attendance/me/monthly?from=&to=` `[Bearer JWT, Role: technician]`

FR-26 — the SAME summary shape for the JWT identity (server-side scoping;
FR-11's owner↔me parity is structural — one aggregation function), plus
`today` (the same tenant-local echo the owner route carries), `weeklyOffs`
(the today-effective weekly-off weekdays, ISO `1=Mon..7=Sun`, via the
shared `pickWeeklyOffDays` contract) and `upcomingHolidays` (the tenant's
next 10 from today, `{ holidayDate, holidayName }`). Leave history is NOT
duplicated — `GET /attendance/me/leave` serves it paginated. Range rules
as the owner route (span ≤ 31, `to ≤ tenant-today`, 422s).

**Unbounded reads (accepted, 2026-09-29 review decision):** both flag
strips and the monthly employee-set + grid carry no caps or pagination in
the contract. The population is implicitly capped by the tenant's tracked
roster (ENR ∩ ASSIGN ∩ active office), the routes are one screen's single
load, and flags clear as they are handled — so a bounded shape was judged
premature pre-launch (a `limit/cursor` option was estimated 1.5–2 h and
deferred). If a tenant's roster or flag backlog grows past a screen's
practical budget, revisit pagination here first.

**Responses:** `200`; `403` `ATTENDANCE_NOT_TRACKED` (AD-17 gate — none;
`history_only` reads the own-records rows); `422`
`ATTENDANCE_INVALID_RANGE` / `VALIDATION_ERROR`; `500` fail-loud.

## Swagger

OpenAPI is auto-generated at `/api/docs` in **non-production** environments
only (see `src/main.ts`). Production deployments do not expose Swagger.
