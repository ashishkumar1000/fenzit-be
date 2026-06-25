---
baseline_commit: 97b09192a890ae59870f28503e95793692c07050
---

# Story 3.3: Job Detail

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an owner or technician,
I want to view the complete details of a single job including its activity log and attachments,
so that I have full context on the job's current state and history.

## Acceptance Criteria

1. **Given** a job belonging to the authenticated user's Tenant, **when** `GET /api/v1/jobs/:id` is called, **then** HTTP 200 with the full job object (same fields as `POST`/`GET /api/v1/jobs`) **plus**: `technician` profile (`id`, `name`, `countryCode`, `phoneNumber`, `skills`), `customer` profile (`id`, `name`, `countryCode`, `phoneNumber`, `address`, `city`), `activityLog` (ordered **oldest-first**), `attachments`, and `currentStep`.

2. **Given** a job belonging to a **different** Tenant, **when** `GET /api/v1/jobs/:id` is called, **then** HTTP 404 with `error_code: "RESOURCE_NOT_FOUND"` — the tenant-scoped fetch returns empty, so cross-tenant access is **indistinguishable from not-found** (never 403). [Matches Story 2.3 `getCustomerDetail` exactly.]

3. **Given** a valid-UUID job id that does not exist in the caller's Tenant, **when** `GET /api/v1/jobs/:id` is called, **then** HTTP 404 with `error_code: "RESOURCE_NOT_FOUND"`.

4. **Given** a **Technician** JWT and a job in the same Tenant **not assigned to them** (`job.technician_id !== user.userId`), **when** `GET /api/v1/jobs/:id` is called, **then** HTTP 403 with `error_code: "FORBIDDEN"`. (Owners may view any job in their Tenant; an assigned Technician may view their own.)

5. **Given** an authenticated user and a job with activity-log entries, **when** `GET /api/v1/jobs/:id` is called, **then** `activityLog` is an array ordered by `created_at` **ascending (oldest-first)**, each entry shaped `{ id, eventType, actorId, metadata, createdAt }`.

6. **Given** a job in the caller's Tenant, **when** `GET /api/v1/jobs/:id` is called, **then** `attachments` is returned as an **empty array `[]`** — the `attachments` table, `StorageRepository`, and pre-signed R2 read URLs are introduced in **Story 3.6**. Populating `attachments` with freshly-generated 1-hour-TTL pre-signed read URLs is **deferred to Story 3.6** (see Scope boundaries). This story ships the field as a stable empty placeholder so the response contract is forward-compatible.

7. **Given** a malformed `:id` (not a UUID), **when** `GET /api/v1/jobs/:id` is called, **then** HTTP 400 (via `ParseUUIDPipe`) — consistent with Story 2.3's customer-detail malformed-id behavior.

8. **Given** an Owner JWT whose `tenantId` is `null` (company not yet set up), **when** `GET /api/v1/jobs/:id` is called, **then** HTTP 400 with `error_code: "VALIDATION_ERROR"` — consistent with `createJob` (AC#9), `listJobs` (AC#11), and `getCustomerDetail`.

9. **Given** no `Authorization` header, **when** `GET /api/v1/jobs/:id` is called, **then** HTTP 401 with `error_code: "UNAUTHORIZED"`.

## Tasks / Subtasks

- [x] **Task 1 — `JobDetailResponse` shape + activity-log/attachment placeholder types** (AC: #1, #5, #6)
  - [x] In `src/jobs/jobs.service.ts`, add `export interface JobDetailResponse extends JobResponse` adding: `technician`, `customer`, `activityLog: ActivityLogEntry[]`, `attachments: JobAttachmentResponse[]`.
  - [x] Add `interface ActivityLogEntry { id: string; eventType: string; actorId: string; metadata: Record<string, unknown> | null; createdAt: string; }`.
  - [x] Add a **placeholder** `export interface JobAttachmentResponse { id: string; type: string; url: string; createdAt: string }` with a `// Story 3.6 finalizes this shape + populates it; empty [] until then` comment. (Mirrors how Story 2.3 pre-declared `JobHistoryItem` while returning an empty envelope.)
  - [x] Nested profile inline types: `technician: { id: string; name: string; countryCode: string; phoneNumber: string; skills: string[] }`, `customer: { id: string; name: string; countryCode: string; phoneNumber: string; address: string | null; city: string | null }`.
- [x] **Task 2 — `getJobDetail` service method** (AC: #1, #2, #3, #4, #5, #6, #8)
  - [x] Add `async getJobDetail(user: RequestUser, jobId: string): Promise<JobDetailResponse>` to `JobsService`.
  - [x] `if (!user.tenantId)` → `BadRequestException` `VALIDATION_ERROR` (AC#8). Mirror `createJob`/`listJobs`.
  - [x] `const admin = this.supabaseClientFactory.createAdmin();`
  - [x] **Fetch + auth gate (order matters):** select the job by `.eq('id', jobId).eq('tenant_id', user.tenantId).single<JobRow>()`. A genuine DB error (`error.code !== 'PGRST116'`) → 500; `PGRST116`/empty/`data.tenant_id !== user.tenantId` → 404 `RESOURCE_NOT_FOUND` (AC#2, AC#3). **Then** the 403 check: `if (user.role === Role.TECHNICIAN && row.technician_id !== user.userId)` → `ForbiddenException` `FORBIDDEN` (AC#4). 404 (tenant scope) is checked **before** 403 so a cross-tenant job is never disclosed as 403.
  - [x] **Assemble related records** (after the auth gate): fetch in parallel via `Promise.all` — (a) technician `users` row (`id, name, country_code, phone_number`) by `.eq('id', row.technician_id).eq('tenant_id', user.tenantId)`, (b) technician skills from `user_skills` joined to `tenant_skills(name)` by `user_id = row.technician_id`, (c) customer `customers` row (`id, name, country_code, phone_number, address, city`) by `.eq('id', row.customer_id).eq('tenant_id', user.tenantId)`, (d) `activity_logs` (`id, event_type, actor_id, metadata, created_at`) by `.eq('job_id', jobId).eq('tenant_id', user.tenantId).order('created_at', { ascending: true })` (AC#5, oldest-first).
  - [x] Any error on the related fetches → 500 `INTERNAL_SERVER_ERROR` (technician + customer FKs are `NOT NULL`, so the rows always exist; a missing row is a server fault, not a 404).
  - [x] `attachments: []` (AC#6) — no `attachments` query, no `StorageRepository`, no R2 call in this story.
  - [x] Map to `JobDetailResponse` via a small `toDetailResponse` helper reusing `this.toResponse(row)` for the base job fields, then attach `technician`/`customer`/`activityLog`/`attachments`.
- [x] **Task 3 — controller `GET :id` handler** (AC: #1, #7, #9)
  - [x] Add `@Get(':id')` with `@Roles(Role.OWNER, Role.TECHNICIAN)`, `@HttpCode(OK)`, `@ApiOperation`, `@ApiResponse` (200/400/401/403/404).
  - [x] Signature: `getJobDetail(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string)` → `this.jobsService.getJobDetail(user, id)` (AC#7 — `ParseUUIDPipe` → 400 on malformed id).
  - [x] Import `Param`, `ParseUUIDPipe`. **Place `@Get(':id')` BELOW the existing parameterless `@Get()` list route** — a bare `:id` param route otherwise shadows `GET /jobs`. Add the same guard comment as `customers.controller.ts`.
- [x] **Task 4 — Unit tests** (AC: #1–#6, #8) — `src/jobs/jobs.service.spec.ts`
  - [x] Add a builder mock that dispatches by table name: `jobs`→`.single()` (job row), `users`→`.single()` (technician), `user_skills`→awaited array (skills join), `customers`→`.single()` (customer), `activity_logs`→`.order()` terminal awaited array. Capture `.eq`/`.order` args to assert tenant scoping + `created_at ASC`.
  - [x] Tests: (a) owner happy path → full `JobDetailResponse` shape incl. nested `technician`/`customer`/`activityLog`/`attachments: []`; (b) technician own job → 200; (c) technician other's job → 403 `FORBIDDEN`; (d) not-found / cross-tenant → 404 `RESOURCE_NOT_FOUND`; (e) no-tenant → 400 `VALIDATION_ERROR`; (f) job-fetch DB error → 500; (g) `activityLog` ordered oldest-first (assert `.order('created_at', { ascending: true })` **and** the mapped order); (h) `attachments` is `[]`.
- [x] **Task 5 — E2E tests** (AC: #1–#9) — `test/jobs.e2e-spec.ts`
  - [x] Add a `GET /api/v1/jobs/:id` describe block. Extend the existing `mockAdmin` to serve the detail chains (job `.single()`, technician `.single()`, `user_skills` array, customer `.single()`, `activity_logs` `.order()` array). Reuse `ownerJwt`/`techJwt`.
  - [x] Tests: 200 full shape (owner), technician-own 200, technician-other 403, valid-but-missing id 404, malformed uuid 400, no-auth 401, no-tenant 400, `attachments: []` asserted, `activityLog` oldest-first asserted.
- [x] **Task 6 — Verify** (AC: all)
  - [x] `bun run build` clean.
  - [x] Full regression: `bun run test` (unit) + e2e — no regressions; new tests green.
  - [x] `bunx eslint` — production code clean; spec/e2e at the accepted `no-unsafe-*` / `unbound-method` baseline only (matches existing `jobs`/`customers` specs).
  - [x] **No migration / schema / RLS change** — all tables (`jobs`, `users`, `customers`, `activity_logs`, `user_skills`, `tenant_skills`) already exist. Run a read-only Supabase MCP sanity query confirming the detail SELECTs (job by id+tenant, technician, skills join, customer, activity_logs order ASC) run clean.

### Review Findings

_Code review 2026-06-21 (adversarial: Blind Hunter + Edge Case Hunter + Acceptance Auditor). All 9 ACs SATISFIED. No High/Medium correctness defects. 5 patch findings (1 defense-in-depth, 1 observability, 3 test-hardening); 7 dismissed as by-design/false-positive._

- [x] [Review][Patch] Skills sub-query is not tenant-scoped (defense-in-depth gap) — the `user_skills` read filters only `.eq('user_id', row.technician_id)`; the other three related reads all carry `.eq('tenant_id', …)`. `user_skills` has no `tenant_id` column (PK `user_id, skill_id`), so scope via the embed: `.select('tenant_skills!inner(name)')` + `.eq('tenant_skills.tenant_id', user.tenantId)`. Low risk (technician already tenant-verified via the `users` read; `createAdmin` bypasses RLS so the app layer is the only gate). [src/jobs/jobs.service.ts:443-446]
- [x] [Review][Patch] Orphaned-FK diagnostic log is unreachable for the real case — a 0-row `.single()` on `users`/`customers` returns `error.code === 'PGRST116'`, which is caught by the earlier `techRes.error || custRes.error` check (→ generic "Failed to assemble job detail"). The dedicated `!techRes.data || !custRes.data` branch with the informative `jobId/technicianId/customerId` log never fires for a missing FK row. Status is correctly 500 either way; only the forensic log is lost. Fix: treat `PGRST116` on the technician/customer reads as the missing-row case so the ID-naming log runs. [src/jobs/jobs.service.ts:461-484]
- [x] [Review][Patch] Tests don't assert tenant scoping on related reads (false-confidence) — `mockDetailAdmin`/`mockDetail` build the `users`/`customers`/`activity_logs` chains with anonymous `eq` mocks that assert nothing on their args. Removing `.eq('tenant_id', …)` (a cross-tenant leak) would leave every test green. Add assertions that the related reads call `.eq('tenant_id', …)` and `.eq('job_id', …)`. [src/jobs/jobs.service.spec.ts:552-589, test/jobs.e2e-spec.ts:565-606]
- [x] [Review][Patch] No test for the missing-related-row (PGRST116) → 500 path — the related-error test uses `code: 'XX000'` only; the `!techRes.data` branch is never executed. Add a unit test feeding `{ data: null, error: { code: 'PGRST116' } }` to the `users` (and `customers`) mock and asserting 500. [src/jobs/jobs.service.spec.ts]
- [x] [Review][Patch] Skills array-shape / null normalization untested + no null-name/dedup guard — all fixtures use the single-object `tenant_skills` shape; the `Array.isArray(ts)` and null-element branches are unexercised, and an array element with a null `name` (or duplicate skills) passes through unfiltered. Add a unit test with the array shape and a null-name element; optionally filter falsy names. [src/jobs/jobs.service.ts:485-490]

## Dev Notes

### This is a pure ADD to the existing jobs module — no migration

`jobs`, `activity_logs`, `users`, `customers`, `user_skills`, `tenant_skills` all exist and are RLS-enabled (verified live via Supabase MCP, project `pnlvreaijzslfymlnoti`). `JobsModule`/`JobsService`/`JobsController` and `JobResponse`/`JobRow`/`toResponse` exist (Stories 3.1–3.2, done). This story ADDS one `GET :id` endpoint. **No new migration, no schema change, no RLS change, no `app.module.ts` change, no new module.** [Source: src/jobs/jobs.service.ts, supabase/migrations/20260621000002_create_jobs.sql]

### Story 2.3 `getCustomerDetail` is the canonical detail-by-id precedent — mirror it

Story 2.3 (done + reviewed) established the **GET `:id` detail** pattern. Copy its structure verbatim where it applies:
- `@Param('id', ParseUUIDPipe)` → **400** on malformed id (AC#7). [Source: src/customers/customers.controller.ts:71-92]
- Tenant-scoped fetch with **explicit `.eq('tenant_id', …)` even though `createAdmin()` bypasses RLS** (defense-in-depth). Empty/`PGRST116` → **404 `RESOURCE_NOT_FOUND`**; cross-tenant is indistinguishable from not-found — **never 403** (AC#2). Genuine DB error (`error.code !== 'PGRST116'`) → **500** *before* the not-found check (don't collapse `error || !data` → 404; that masks real failures). [Source: src/customers/customers.service.ts:313-360]
- **Empty-envelope-until-dependency-lands** pattern: 2.3 returned `jobHistory: new PaginatedResponse([], null)` because the jobs table arrived in Epic 3. This story returns **`attachments: []`** for the identical reason — the attachments table/StorageRepository arrive in Story 3.6 (AC#6). [Source: src/customers/customers.service.ts:356-358]

### The 403 case — this story's one genuine difference from list/customer-detail

Unlike `GET /api/v1/jobs` (list — no 403; technicians are silently narrowed to their own rows) and `getCustomerDetail` (owner-only — 403 comes from the `RolesGuard`), **this endpoint allows both roles AND has a service-layer 403**: a technician requesting a same-tenant job that isn't theirs gets **403 `FORBIDDEN`** (AC#4). Critical ordering: **resolve the 404 (tenant scope) first, then the 403 (ownership)** — a job in another tenant must 404, never 403, so existence in another tenant is never leaked. Owners are never 403'd here. [Source: epics.md#Story 3.3 AC line 543-545]

```ts
async getJobDetail(user: RequestUser, jobId: string): Promise<JobDetailResponse> {
  if (!user.tenantId) {
    throw new BadRequestException({
      error_code: ErrorCode.VALIDATION_ERROR,
      message: 'Company setup required before viewing jobs',
    });
  }
  const admin = this.supabaseClientFactory.createAdmin();

  // 1) fetch + tenant gate → 500 (real error) / 404 (empty or cross-tenant)
  const { data: row, error } = await admin
    .from('jobs')
    .select('id, job_number, tenant_id, customer_id, technician_id, service_location, service_type, scheduled_start, scheduled_end, status, current_step, priority, require_completion_photo, description, notes_for_technician, created_at, updated_at')
    .eq('id', jobId)
    .eq('tenant_id', user.tenantId)
    .single<JobRow>();
  if (error && error.code !== 'PGRST116') { /* logger.error + 500 */ }
  if (!row || row.tenant_id !== user.tenantId) { /* 404 RESOURCE_NOT_FOUND */ }

  // 2) ownership gate → 403 (technician, not their job)
  if (user.role === Role.TECHNICIAN && row.technician_id !== user.userId) {
    throw new ForbiddenException({ error_code: ErrorCode.FORBIDDEN, message: 'Forbidden' });
  }

  // 3) assemble related records (parallel reads — reads need no atomicity; AR-10 is write-only)
  const [tech, skills, customer, logs] = await Promise.all([ /* … */ ]);
  // 4) map → JobDetailResponse, attachments: []
}
```
**`select(...)` must be a single string literal** — concatenation collapses the postgrest-js literal type to `GenericStringError[]` and breaks the `.single<JobRow>()` typing (TS2352). Reuse the exact 17-column literal from `listJobs`. [Source: src/jobs/jobs.service.ts:248-250, 3-2-list-jobs.md#Debug Log]

### Assembling related records — separate parallel reads (recommended), not one embedded select

The architecture says the response *"assembles: job entity + technician User record + customer Customer record + activity_logs ordered created_at ASC + attachments"*. **Recommended:** fetch the job first (it gates auth), then run the 3 dependent reads with `Promise.all`. Rationale: (1) reads don't need atomicity — AR-10's `supabase.rpc()` rule is about **writes** (job-state + activity-log inserts), not reads; (2) it matches the codebase's single-table-select style and the existing `.single()`/array mock shapes, keeping unit tests simple; (3) it avoids deep PostgREST embedding (`users!fk(user_skills(tenant_skills(name)))`) whose nested-join typing is brittle under the single-literal-select constraint. A single embedded select is a valid alternative but is **not** recommended for this story. [Source: epics.md#Story 3.3 Implementation Notes line 551-553; architecture.md (AR-10 atomicity = writes)]

- **technician:** `users` is **not RLS-enabled** (live check + advisory) but still filter `.eq('tenant_id', user.tenantId)` for defense-in-depth. Columns: `id, name, country_code, phone_number`. The `technician_id` FK is `NOT NULL` → the row always exists; a missing row is a 500, not a 404.
- **technician skills:** join `user_skills (user_id, skill_id)` → `tenant_skills (id, name)`; return `skills: string[]` (the skill **names**). PostgREST: `from('user_skills').select('tenant_skills(name)').eq('user_id', technicianId)` then map `rows.map(r => r.tenant_skills.name)`. A technician with no skills → `skills: []`. [Source: supabase live schema; src/auth/auth.service.ts:250 user_skills insert; src/skills/skills.service.ts]
- **customer:** `customers` row (`id, name, country_code, phone_number, address, city`), `.eq('id', row.customer_id).eq('tenant_id', user.tenantId)`. `customer_id` FK is `NOT NULL` → always exists.
- **activity_logs:** `.eq('job_id', jobId).eq('tenant_id', user.tenantId).order('created_at', { ascending: true })` — **oldest-first** (AC#5). At least one row always exists (`create_job_with_log` inserts a `job_created` entry on creation), but handle `[]` gracefully. Map `event_type→eventType`, `actor_id→actorId`, `created_at→createdAt`; pass `metadata` through. [Source: supabase/migrations/20260621000002_create_jobs.sql activity_logs; 20260621000003_rpc_create_job_with_log.sql]

### `skillType` in FR-8 is STALE — return `skills: string[]` (names)

FR-8 / the epic AC (line 537) say the technician profile returns `skillType`. **That field no longer exists** — Story 1.5 introduced `tenant_skills`/`user_skills` and Story 1.6 replaced the `skillType` enum with a `skillIds` array (`POST /auth/invite` now takes `skillIds`). So the technician profile returns **`skills: string[]`** (resolved skill names from `user_skills → tenant_skills.name`), not a single `skillType`. This is a deliberate, documented deviation from the (outdated) epic text to keep the API consistent with the post-1.6 data model. [Source: src/auth/dto/invite-technician.dto.ts:31 (`skillIds`); git ccedc27/cbd26da; live schema has no `skill_type` column on `users`]

### Phone is exposed as `countryCode` + `phoneNumber` (separate camelCase fields)

Match `CustomerResponse` exactly: phone is **two** fields, `countryCode` and `phoneNumber` — do **not** concatenate into a single `phone` string (the epic's "phone" maps to this pair). Both the nested `technician` and `customer` profiles use this shape. [Source: src/customers/customers.service.ts:17-27, 381-400]

### Attachments / pre-signed R2 read URLs — DEFERRED to Story 3.6 (out of scope here)

The epic AC *"Given a job with 3 photo attachments → each URL is a freshly generated R2 pre-signed read URL (1-hour TTL, regenerated each call)"* (lines 547-549) **cannot be satisfied in 3.3** and is **explicitly deferred to Story 3.6**, which introduces:
- the `attachments` table (does **not** exist — confirmed live; only `jobs`/`activity_logs`/`job_sequences` were created in 3.1),
- the abstract `StorageRepository.getPresignedReadUrl(key, 3600)` + `CloudflareR2StorageRepository` (`@aws-sdk/client-s3`) — **none of which exist yet** (only the four `CLOUDFLARE_R2_*` env vars are validated in `app.module.ts`; there is no R2 client),
- the upload flow + webhook that creates attachment rows.

This story ships `attachments: []` so the response contract is stable and forward-compatible. **Add a deferred-work note** (see Task list / below) so 3.6 wires presigned-URL population into this same endpoint. [Source: architecture.md:175-226 (R2/StorageRepository/attachment visibility), 583-618 (planned attachments.service/storage.repository files); epics.md#Story 3.6; supabase live schema = no attachments table]

> **Deferred → Story 3.6:** populate `GET /api/v1/jobs/:id` `attachments` with the real attachment rows, each carrying a freshly-generated R2 pre-signed read URL (1-hour TTL, regenerated every call, never cached). Finalize `JobAttachmentResponse`. Add this to `deferred-work.md` during dev.

### Validation status-code map (already established, do not change)

- `ParseUUIDPipe` malformed `:id` → **400** (AC#7). [Source: src/customers/customers.controller.ts:90]
- Business `BadRequestException` (no-tenant) → **400 `VALIDATION_ERROR`** (AC#8).
- Missing/invalid JWT → **401 `UNAUTHORIZED`** (global `JwtAuthGuard`) (AC#9).
- Technician-not-owner → **403 `FORBIDDEN`** (service-layer `ForbiddenException`) (AC#4).
- Not-found / cross-tenant → **404 `RESOURCE_NOT_FOUND`** (AC#2, AC#3).
[Source: src/common/enums/error-code.enum.ts; src/main.ts ValidationPipe; src/customers/customers.service.ts]

### Scope boundaries

- **Read-only detail of ONE job.** No mutation (PATCH is Story 3.4), no workflow advance (3.5), no attachment upload (3.6).
- `attachments: []` only — **no** `StorageRepository`, **no** R2 client, **no** presigned URL generation, **no** `attachments` table read.
- No new migration, no RLS change, no new module, no `app.module.ts` change.
- Both roles allowed on the route (`@Roles(OWNER, TECHNICIAN)`); ownership enforced in the service (403), tenant scope via 404.
- `current_step` passes through `toResponse` as-is (null until Story 3.5 advances it).

### Testing standards

- **Unit** (`src/jobs/jobs.service.spec.ts`): extend the existing mock to **dispatch by table name** — `from('jobs')` → `.single()` chain, `from('users')` → `.single()`, `from('user_skills')` → awaited array, `from('customers')` → `.single()`, `from('activity_logs')` → `.order()`-terminal awaited array. Capture `.eq`/`.order` args to assert tenant scoping + `created_at ASC`. The create path uses a `.single()` terminal and list uses a `.limit()` terminal — keep all three working.
- **E2E** (`test/jobs.e2e-spec.ts`): extend `mockAdmin` to serve the detail chains; reuse `ownerJwt`/`techJwt` and the `ValidationPipe { whitelist, transform, errorHttpStatusCode: 422 }` from `beforeAll`. Assert the full `JobDetailResponse` body shape (incl. nested profiles, `activityLog` order, `attachments: []`), 403 for technician-other, 404 for missing, 400 for malformed uuid + no-tenant, 401 for no-auth.
- **Lint baseline (accepted, do not fight):** spec/e2e `@typescript-eslint/unbound-method` on jest mocks + `no-unsafe-member-access` on `JSON.parse(response.body)`; in `jobs.service.ts` the `data as JobRow[]`/`as X` casts carry the same accepted `no-unsafe-assignment` baseline as `auth.service.ts:268` / `listCustomers`. Production code otherwise lints clean.
- No real-DB integration test in scope (CI has no DB — AR-20 / J1 infra gap in deferred-work.md). All assembly logic is unit-testable with mocks.

### Project Structure Notes

- **Modified:** `src/jobs/jobs.service.ts` (+`getJobDetail`, +`JobDetailResponse`/`ActivityLogEntry`/`JobAttachmentResponse`, +`toDetailResponse`, import `ForbiddenException`), `src/jobs/jobs.controller.ts` (+`@Get(':id')`, import `Param`/`ParseUUIDPipe`), `src/jobs/jobs.service.spec.ts` (+detail unit tests), `test/jobs.e2e-spec.ts` (+`GET :id` describe block).
- **No** new file, **no** migration, **no** `app.module.ts`/`jobs.module.ts` change.
- Naming: service method `getJobDetail` mirrors `getCustomerDetail`; response `JobDetailResponse` mirrors `CustomerDetailResponse`.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 3.3: Job Detail (lines 527-553)] — the 4 epic ACs + implementation notes
- [Source: _bmad-output/planning-artifacts/epics.md#FR-8 (line 33)] — job detail intent; technician 403; activity log oldest-first; attachments with presigned URLs
- [Source: _bmad-output/planning-artifacts/architecture.md:175-226] — R2 presigned read URLs, `StorageRepository`, attachment visibility (both roles), key pattern — **all land in Story 3.6**
- [Source: _bmad-output/planning-artifacts/architecture.md:583-618] — planned `storage.repository.ts` / `attachments.service.ts` / `job-response.dto.ts` (Story 3.6 surface)
- [Source: src/customers/customers.service.ts:313-360] — `getCustomerDetail`: tenant-scoped 404, 500-before-404 guard, empty-envelope-until-dependency pattern
- [Source: src/customers/customers.controller.ts:71-92] — `@Get(':id')` + `ParseUUIDPipe` (400) + route-ordering comment + `@ApiResponse` set
- [Source: src/jobs/jobs.service.ts:24-62, 224-323] — `JobResponse`/`JobRow`/`toResponse`, no-tenant guard, `createAdmin`, single-literal 17-col select, `listJobs`
- [Source: src/jobs/jobs.controller.ts] — controller to extend; `@Roles`, `@CurrentUser`, `@ApiResponse` conventions
- [Source: src/common/enums/error-code.enum.ts] — `FORBIDDEN`, `RESOURCE_NOT_FOUND`, `VALIDATION_ERROR`, `INTERNAL_SERVER_ERROR`
- [Source: src/auth/dto/invite-technician.dto.ts:31; git cbd26da/ccedc27] — `skillIds` replaced `skillType` (FR-8 `skillType` is stale → return `skills: string[]`)
- [Source: supabase/migrations/20260621000002_create_jobs.sql; 20260621000003_rpc_create_job_with_log.sql] — `jobs`/`activity_logs` columns; `job_created` log inserted at creation
- [Source: live Supabase schema, project pnlvreaijzslfymlnoti] — confirmed: NO `attachments` table; `user_skills`→`tenant_skills(name)` for skills; `users`/`customers` columns
- [Source: 3-2-list-jobs.md] — single-literal select constraint, lint baseline, mock shapes, IST/cursor facts

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m]

### Debug Log References

- Build clean (`bun run build`). Full regression: unit **130/130** (11 suites), e2e **106 pass / 2 skip** (8 suites). No regressions.
- `jobs.service.spec.ts` 23 → **33** (+10 `getJobDetail` unit tests). `jobs.e2e-spec.ts` +7 `GET /api/v1/jobs/:id` e2e tests.
- **Lint trap (resolved):** an inline 17-column `.select('…')` literal + `.single<JobRow>()` tripped `no-unsafe-assignment` on the `{ data, error }` destructure (the literal-parsed Result resolved `data` to `any`). Fix: hoist the columns to a `const JOB_DETAIL_COLUMNS` and use `.select(JOB_DETAIL_COLUMNS).single<JobRow>()` — the explicit generic types `data` cleanly (identical to `getCustomerDetail` / `CUSTOMER_COLUMNS`). Note: `listJobs` keeps an inline literal because its `as JobRow[]` cast needs the literal column type — the two patterns are not interchangeable.
- Production lint: `jobs.controller.ts` clean; `jobs.service.ts` at the pre-existing accepted baseline only (1 × `no-unsafe-assignment` on `createJob`'s `admin.rpc(...)` destructure, matches `auth.service.ts:268`). spec/e2e at the accepted `no-unsafe-*` / `unbound-method` baseline (`JSON.parse(response.body)` + jest mocks).
- Read-only Supabase MCP sanity (project `pnlvreaijzslfymlnoti`): all five detail SELECTs (job 17-col, technician, customer, `activity_logs` ORDER BY created_at ASC, `user_skills`→`tenant_skills` join) resolved with no column/join errors.

### Completion Notes List

- Added `GET /api/v1/jobs/:id` (owner **and** technician) returning `JobDetailResponse` = base job + nested `technician` (`id`, `name`, `countryCode`, `phoneNumber`, `skills[]`) + `customer` (`id`, `name`, `countryCode`, `phoneNumber`, `address`, `city`) + `activityLog` (oldest-first) + `attachments` — **no migration**.
- **Auth ordering (AC#2/#3/#4):** tenant-scoped fetch → 404 (`RESOURCE_NOT_FOUND`) for missing/cross-tenant resolved **before** the technician-ownership 403 (`FORBIDDEN`), so another tenant's job is never disclosed as 403. Owners are never 403'd. No-tenant → 400; malformed `:id` → 400 via `ParseUUIDPipe`.
- **Related records** assembled with `Promise.all` after the auth gate (reads need no atomicity; AR-10 governs writes). `technician_id`/`customer_id` are NOT NULL FKs → a missing row is a 500, not a 404.
- **`skills: string[]`** (resolved names via `user_skills`→`tenant_skills`) replaces the stale FR-8 `skillType` (removed in Story 1.6); handles both PostgREST embed shapes (object/array) and `[]` when none.
- **`attachments: []`** (AC#6) — `JobAttachmentResponse` pre-declared as a placeholder; presigned R2 read-URL population deferred to **Story 3.6** (logged in `deferred-work.md`), mirroring how Story 2.3 returned an empty `jobHistory` envelope until its dependency landed.

### File List

- `src/jobs/jobs.service.ts` (modified — `getJobDetail`, `toDetailResponse`, `JobDetailResponse`/`ActivityLogEntry`/`JobAttachmentResponse` + row interfaces, `JOB_DETAIL_COLUMNS`, `ForbiddenException` import)
- `src/jobs/jobs.controller.ts` (modified — `@Get(':id')` handler, `Param`/`ParseUUIDPipe` imports)
- `src/jobs/jobs.service.spec.ts` (modified — +10 `getJobDetail` unit tests, table-dispatch detail mock)
- `test/jobs.e2e-spec.ts` (modified — +7 `GET /api/v1/jobs/:id` e2e tests)
- `_bmad-output/implementation-artifacts/deferred-work.md` (modified — Story 3.6 attachments-population deferral)

### Change Log

| Date       | Change                                  |
|------------|-----------------------------------------|
| 2026-06-21 | Story 3.3 created (ready-for-dev) — comprehensive context engine analysis. Key decisions: `attachments: []` placeholder (presigned-URL population deferred to Story 3.6, mirroring 2.3's empty `jobHistory` envelope); `skills: string[]` replaces stale FR-8 `skillType`; service-layer 403 (technician-not-owner) resolved AFTER tenant-scoped 404; parallel related-record reads (reads need no atomicity). No migration. |
| 2026-06-21 | Story 3.3 implemented: `GET /api/v1/jobs/:id` (owner+technician) → full job + technician/customer profiles + activity log (oldest-first) + `attachments: []`. 404-before-403 auth ordering; `ParseUUIDPipe` 400; `skills` via `user_skills`→`tenant_skills`. +10 unit, +7 e2e. Unit 130/130, e2e 106 pass/2 skip, build clean, lint at accepted baseline. Attachments presigned-URL population deferred to Story 3.6. Status → review. |
| 2026-06-21 | Code review (adversarial 3-layer): all 9 ACs satisfied, no correctness defects. 5 patch findings applied — (P1) tenant-scoped the skills read via `tenant_skills!inner` + embedded `tenant_id` filter; (P2) made the orphaned-FK diagnostic log reachable by excluding `PGRST116` from the related-read error gate; (P5) drop falsy skill names; (P3) unit test asserting every related read is tenant-scoped; (P4) unit tests for missing-FK `PGRST116`→500 (technician + customer); (P5) unit test for both PostgREST embed shapes. 7 findings dismissed as by-design/false-positive. Unit 134/134, e2e 106 pass/2 skip, build clean, prod lint at accepted baseline (1 × pre-existing createJob RPC). Live skills-embed SELECT verified via Supabase MCP. Status → done. |
