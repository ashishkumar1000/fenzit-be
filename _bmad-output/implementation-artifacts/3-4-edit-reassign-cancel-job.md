---
baseline_commit: 9287a31194ba7fbd116582f5f77c5caef19e187c
---

# Story 3.4: Edit, Reassign & Cancel Job

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an owner,
I want to modify details, reassign, or cancel a job that is still `scheduled`,
so that I can keep job information accurate or remove jobs that are no longer needed — while the activity log faithfully records every reassignment and cancellation.

## Acceptance Criteria

1. **Given** a `scheduled` job in the owner's Tenant and a body with one or more mutable fields (`description`, `scheduledStart`, `scheduledEnd`, `notesForTechnician`, `technicianId`, `priority`), **when** `PATCH /api/v1/jobs/:id` is called by an **owner**, **then** HTTP 200 with the updated `JobResponse` (same shape as `POST`/`GET /api/v1/jobs`), the changed columns persisted, and `updated_at` refreshed.

2. **Given** a `scheduled` job and a body that **changes `technicianId`** to a different technician in the same Tenant, **when** `PATCH /api/v1/jobs/:id` is called by an owner, **then** HTTP 200 with the updated job **and** a `job_reassigned` activity-log entry is appended whose `metadata` records both ids: `{ "previousTechnicianId": "<old>", "newTechnicianId": "<new>" }`. (Atomic: the job UPDATE and the log INSERT happen in one transaction.)

3. **Given** a `scheduled` job and body `{ "status": "cancelled" }`, **when** `PATCH /api/v1/jobs/:id` is called by an owner, **then** HTTP 200, the job `status` becomes `cancelled`, and a `job_cancelled` activity-log entry is appended (atomic, same transaction).

4. **Given** a job in `in_progress` or `completed` (or already `cancelled`) status **and** any mutable field in the body, **when** `PATCH /api/v1/jobs/:id` is called by an owner, **then** HTTP 409 with `error_code: "JOB_NOT_MODIFIABLE"` — and the job is left **unchanged** (no partial write, no log).

5. **Given** a job in `in_progress` (or `completed`/`cancelled`) status **and** body `{ "status": "cancelled" }`, **when** `PATCH /api/v1/jobs/:id` is called by an owner, **then** HTTP 409 with `error_code: "JOB_NOT_MODIFIABLE"` (only a `scheduled` job may be cancelled via this endpoint).

6. **Given** a **Technician** JWT, **when** `PATCH /api/v1/jobs/:id` is called, **then** HTTP 403 with `error_code: "FORBIDDEN"` (enforced by `RolesGuard` — route is owner-only; the service is never reached).

7. **Given** a `technicianId` in the body that does **not** belong to the owner's Tenant (or is not a `technician` role), **when** `PATCH /api/v1/jobs/:id` is called, **then** HTTP 404 with `error_code: "RESOURCE_NOT_FOUND"` — mirrors `createJob`'s technician validation.

8. **Given** a job id (valid UUID) that does not exist in the owner's Tenant — including a job belonging to a **different** Tenant, **when** `PATCH /api/v1/jobs/:id` is called, **then** HTTP 404 with `error_code: "RESOURCE_NOT_FOUND"` — the tenant-scoped write affects zero rows, so cross-tenant access is **indistinguishable from not-found** (never 403). [Matches `getJobDetail`/`getCustomerDetail`.]

9. **Given** a malformed `:id` (not a UUID), **when** `PATCH /api/v1/jobs/:id` is called, **then** HTTP 400 (via `ParseUUIDPipe`) — consistent with `GET /api/v1/jobs/:id` (Story 3.3 AC#7).

10. **Given** an Owner JWT whose `tenantId` is `null` (company not yet set up), **when** `PATCH /api/v1/jobs/:id` is called, **then** HTTP 400 with `error_code: "VALIDATION_ERROR"` — consistent with `createJob`/`listJobs`/`getJobDetail`.

11. **Given** no `Authorization` header, **when** `PATCH /api/v1/jobs/:id` is called, **then** HTTP 401 with `error_code: "UNAUTHORIZED"`.

12. **Given** a body containing **no updatable field at all** (neither a mutable field nor `status`), **when** `PATCH /api/v1/jobs/:id` is called by an owner, **then** HTTP 422 with `error_code: "VALIDATION_ERROR"` ("No updatable fields provided") — an empty PATCH must not bump `updated_at` or write a no-op log.

13. **Given** a body where `status` is present with **any value other than `"cancelled"`** (e.g. `"completed"`, `"in_progress"`, `"scheduled"`), **when** `PATCH /api/v1/jobs/:id` is called, **then** HTTP 422 with `error_code: "VALIDATION_ERROR"` — `status` on this endpoint may **only** be `"cancelled"`; lifecycle transitions to `in_progress`/`completed` are driven by the workflow endpoint (Story 3.5), not PATCH. (Enforced by the DTO `@IsIn([JobStatus.CANCELLED])`.)

14. **Given** a body that contains `status: "cancelled"` **together with** one or more mutable edit fields, **when** `PATCH /api/v1/jobs/:id` is called, **then** HTTP 422 with `error_code: "VALIDATION_ERROR"` — cancellation and field edits are **mutually exclusive** in a single request, so the activity log records exactly one event per request (`job_cancelled` **or** `job_reassigned`, never an ambiguous mix).

15. **Given** a body with both `scheduledStart` and `scheduledEnd` where `scheduledEnd` is **before** `scheduledStart`, **when** `PATCH /api/v1/jobs/:id` is called, **then** HTTP 422 with `error_code: "VALIDATION_ERROR"` — mirrors `createJob`'s inverted-window guard. (Checked only when **both** are present in the body, exactly as `createJob` does.)

## Tasks / Subtasks

- [x] **Task 1 — `update_job_with_log` RPC migration** (AC: #1, #2, #3, #4, #5, #8)
  - [x] Create `supabase/migrations/20260621000004_rpc_update_job_with_log.sql` following the exact header/style of `20260621000003_rpc_create_job_with_log.sql` (`LANGUAGE plpgsql`, `SECURITY DEFINER`, `SET search_path = public`, `RETURNS SETOF jobs`).
  - [x] Signature (all mutable params nullable; `NULL` = "leave unchanged"):
    `update_job_with_log(p_job_id UUID, p_tenant_id UUID, p_actor_id UUID, p_cancel BOOLEAN, p_description TEXT, p_scheduled_start TIMESTAMPTZ, p_scheduled_end TIMESTAMPTZ, p_notes_for_technician TEXT, p_technician_id UUID, p_priority TEXT)`.
  - [x] Body logic (the state guard MUST be inside the transaction):
    1. `SELECT * INTO v_job FROM jobs WHERE id = p_job_id AND tenant_id = p_tenant_id FOR UPDATE;` — tenant-scoped **row lock** (closes the TOCTOU window on the `scheduled`-only rule).
    2. `IF NOT FOUND THEN RETURN; END IF;` — empty set → app maps to **404** (AC#8).
    3. `IF v_job.status <> 'scheduled' THEN RAISE EXCEPTION 'job not modifiable' USING ERRCODE = 'PT409'; END IF;` — surfaces as a distinguishable `error.code` the app maps to **409** (AC#4, #5). **Verify the exact surfaced code via MCP in Task 6 and match on it.**
    4. **Cancel path** (`p_cancel = true`): `UPDATE jobs SET status='cancelled', updated_at=now() WHERE id=p_job_id;` then `INSERT INTO activity_logs (job_id, tenant_id, event_type, actor_id) VALUES (p_job_id, p_tenant_id, 'job_cancelled', p_actor_id);`
    5. **Edit path** (`p_cancel = false`): capture `v_old_tech := v_job.technician_id;` then `UPDATE jobs SET description = COALESCE(p_description, description), scheduled_start = COALESCE(p_scheduled_start, scheduled_start), scheduled_end = COALESCE(p_scheduled_end, scheduled_end), notes_for_technician = COALESCE(p_notes_for_technician, notes_for_technician), technician_id = COALESCE(p_technician_id, technician_id), priority = COALESCE(p_priority, priority), updated_at = now() WHERE id = p_job_id;`
    6. **Reassign log — only when the technician actually changed:** `IF p_technician_id IS NOT NULL AND p_technician_id <> v_old_tech THEN INSERT INTO activity_logs (job_id, tenant_id, event_type, actor_id, metadata) VALUES (p_job_id, p_tenant_id, 'job_reassigned', p_actor_id, jsonb_build_object('previousTechnicianId', v_old_tech, 'newTechnicianId', p_technician_id)); END IF;` (re-assigning to the same technician is a no-op → no log).
    7. `RETURN QUERY SELECT * FROM jobs WHERE id = p_job_id;`
  - [x] **Apply the migration via Supabase MCP** (`mcp__supabase__apply_migration`, project `pnlvreaijzslfymlnoti`) and confirm it runs clean. The committed `.sql` file AND the applied migration must match (project-context rule #3).
- [x] **Task 2 — `UpdateJobDto`** (AC: #1, #12, #13, #14, #15)
  - [x] Create `src/jobs/dto/update-job.dto.ts`. Use the mapped-type pattern over the **mutable subset only** (NOT `OmitType` — that would leak immutable `serviceLocation`/`serviceType`/`customerId`/`newCustomer`):
    `export class UpdateJobDto extends PartialType(PickType(CreateJobDto, ['description', 'scheduledStart', 'scheduledEnd', 'notesForTechnician', 'technicianId', 'priority'] as const)) { ... }` — `PartialType`/`PickType` from `@nestjs/swagger` (reuses CreateJobDto's `@Transform(trim)`, `@MaxLength`, `@IsUUID`, `@IsISO8601`, `@IsEnum` and Swagger metadata).
  - [x] Add the **`status`** field on the subclass, restricted to cancellation only: `@ApiPropertyOptional({ enum: [JobStatus.CANCELLED] }) @IsOptional() @IsIn([JobStatus.CANCELLED]) status?: JobStatus.CANCELLED;` (import `IsIn` from `class-validator`, `JobStatus` from `../enums/job-status.enum`). This satisfies AC#13 (any non-`cancelled` status → 422 via the global `ValidationPipe`, which maps DTO failures to 422).
- [x] **Task 3 — `updateJob` service method** (AC: #1–#5, #7, #8, #10, #12, #14, #15)
  - [x] Add `async updateJob(owner: RequestUser, jobId: string, dto: UpdateJobDto): Promise<JobResponse>` to `JobsService`.
  - [x] `if (!owner.tenantId)` → `BadRequestException` `VALIDATION_ERROR` (AC#10). Mirror `createJob`.
  - [x] **Body-shape validation (before any DB call):**
    - `const isCancel = dto.status === JobStatus.CANCELLED;`
    - `const editFields = [dto.description, dto.scheduledStart, dto.scheduledEnd, dto.notesForTechnician, dto.technicianId, dto.priority];` — `const hasEdit = editFields.some((v) => v !== undefined);`
    - AC#14: `if (isCancel && hasEdit)` → **422** `VALIDATION_ERROR` ("Cancellation cannot be combined with field edits").
    - AC#12: `if (!isCancel && !hasEdit)` → **422** `VALIDATION_ERROR` ("No updatable fields provided").
    - AC#15: `if (dto.scheduledStart && dto.scheduledEnd && Date.parse(dto.scheduledEnd) < Date.parse(dto.scheduledStart))` → **422** `VALIDATION_ERROR` (reuse `createJob`'s wording/shape). Both are `@IsISO8601`, so `Date.parse` never yields NaN.
  - [x] `const admin = this.supabaseClientFactory.createAdmin();`
  - [x] **Technician validation when reassigning** (AC#7) — only if `dto.technicianId` is present: SELECT `users` by `.eq('id', dto.technicianId).eq('tenant_id', owner.tenantId).eq('role', 'technician').single()`. `error.code !== 'PGRST116'` → 500; `!data` → **404** `RESOURCE_NOT_FOUND` ("Technician not found"). **Copy `createJob`'s technician block verbatim** (jobs.service.ts:233-255).
  - [x] **Call the RPC:** `const { data, error } = await admin.rpc('update_job_with_log', { p_job_id: jobId, p_tenant_id: owner.tenantId, p_actor_id: owner.userId, p_cancel: isCancel, p_description: dto.description ?? null, p_scheduled_start: dto.scheduledStart ?? null, p_scheduled_end: dto.scheduledEnd ?? null, p_notes_for_technician: dto.notesForTechnician ?? null, p_technician_id: dto.technicianId ?? null, p_priority: dto.priority ?? null });`
  - [x] **Error mapping (order matters):**
    1. `if (error)`: check the not-modifiable code FIRST → `const code = (error as { code?: string }).code;` `if (code === 'PT409' /* CONFIRM via Task 6 */) throw new HttpException({ error_code: ErrorCode.JOB_NOT_MODIFIABLE, message: 'Job is not modifiable in its current status' }, HttpStatus.CONFLICT);` (AC#4, #5).
    2. `if (code === '23503')` → **404** `RESOURCE_NOT_FOUND` ("Referenced technician not found") — technician deleted between validation and RPC (mirror `createJob`:280-286).
    3. otherwise `logger.error` + **500** `INTERNAL_SERVER_ERROR`.
  - [x] **Empty result → 404:** `const rows = data as JobRow[] | null;` `if (!rows || rows.length === 0) throw new NotFoundException({ error_code: ErrorCode.RESOURCE_NOT_FOUND, message: 'Job not found' });` (AC#8 — the RPC `RETURN`s an empty set when the tenant-scoped row isn't found). Mirror `createJob`'s `RETURNS SETOF jobs` array handling (jobs.service.ts:294-302).
  - [x] `return this.toResponse(rows[0]);` (reuse the existing private `toResponse`).
- [x] **Task 4 — Controller `PATCH :id` handler** (AC: #1, #6, #9, #11)
  - [x] Add `@Patch(':id')` with `@Roles(Role.OWNER)`, `@HttpCode(HttpStatus.OK)`, `@ApiOperation`, `@ApiResponse` (200/400/401/403/404/409/422). Import `Patch` from `@nestjs/common`.
  - [x] Signature: `updateJob(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateJobDto)` → `this.jobsService.updateJob(user, id, dto)` (AC#9 — `ParseUUIDPipe` → 400; AC#6 — `@Roles(OWNER)` → 403 for technician via `RolesGuard`).
  - [x] Place `@Patch(':id')` near the `@Get(':id')` handler; route ordering with the list route doesn't matter for a different HTTP verb, but keep it grouped for readability.
- [x] **Task 5 — Unit tests** (AC: #1–#5, #7, #8, #10, #12, #14, #15) — `src/jobs/jobs.service.spec.ts`
  - [x] Extend the existing table-dispatch mock so `admin.rpc('update_job_with_log', …)` is mockable and `from('users').…single()` serves the technician-validation read. Capture the rpc args to assert mapping.
  - [x] Tests: (a) owner edit `scheduled` → 200, asserts rpc called with `p_cancel:false` and the changed fields; (b) owner reassign (valid new technician) → 200, asserts technician validated then rpc called with `p_technician_id`; (c) owner cancel → 200, asserts `p_cancel:true`; (d) RPC returns `error.code === 'PT409'` → **409** `JOB_NOT_MODIFIABLE`; (e) RPC returns empty `data: []` → **404** `RESOURCE_NOT_FOUND`; (f) technician-validation miss (`users` PGRST116/empty) → **404**; (g) no-tenant → **400** `VALIDATION_ERROR`; (h) empty body (`{}`) → **422** `VALIDATION_ERROR`; (i) `status:'cancelled'` + `description` → **422**; (j) `scheduledEnd` < `scheduledStart` → **422**; (k) RPC `error.code === '23503'` → **404**; (l) reassign to the **same** technician → 200 and (since the no-op-log decision lives in the RPC) assert the service still passes `p_technician_id` and returns 200 (log suppression is covered by the MCP/integration check in Task 6, not the unit mock).
  - [x] **Use the confirmed not-modifiable error code** from Task 6 in test (d) — do not hard-code `PT409` if MCP shows a different surfaced `error.code`.
- [x] **Task 6 — Live RPC verification via Supabase MCP** (AC: #2, #3, #4, #5)
  - [x] After applying the migration, exercise `update_job_with_log` against the live DB (project `pnlvreaijzslfymlnoti`) using **real seeded rows** (do NOT bypass RLS semantics for correctness checks — the RPC is `SECURITY DEFINER` and called as service role by design, but use real tenant/job/technician ids):
    - Confirm an edit on a `scheduled` job updates the row and bumps `updated_at`.
    - Confirm a reassign inserts exactly one `job_reassigned` log with `metadata = {"previousTechnicianId":…,"newTechnicianId":…}` and that a same-technician reassign inserts **no** log.
    - Confirm a cancel sets `status='cancelled'` and inserts one `job_cancelled` log.
    - Confirm calling the RPC on a non-`scheduled` job raises, and **record the exact `error.code` / SQLSTATE** surfaced by supabase-js — wire that code into the service's 409 mapping and the unit test (replace the `PT409` placeholder if it differs).
    - Confirm calling with a non-existent (or cross-tenant) `p_job_id` returns an empty set (→ 404 path) and writes nothing.
  - [x] Leave the DB clean (delete any rows you inserted for the check, or use a throwaway scheduled job).
- [x] **Task 7 — E2E tests** (AC: #1–#14) — `test/jobs.e2e-spec.ts`
  - [x] Add a `PATCH /api/v1/jobs/:id` describe block. Extend the existing `mockAdmin` to serve `rpc('update_job_with_log')` and the `users` technician-validation `.single()`. Reuse `ownerJwt`/`techJwt`.
  - [x] Tests: owner edit → 200 (body shape), owner reassign → 200, owner cancel → 200 (`status:'cancelled'`), non-scheduled → 409 `JOB_NOT_MODIFIABLE`, technician JWT → 403 `FORBIDDEN`, valid-but-missing id → 404, cross-tenant id → 404, malformed uuid → 400, no-auth → 401, no-tenant → 400, empty body → 422, `status:'cancelled'`+field → 422, non-`cancelled` status → 422.
- [x] **Task 8 — Verify** (AC: all)
  - [x] `bun run build` clean.
  - [x] Full regression: `bun run test` (unit) + e2e — no regressions; new tests green.
  - [x] `bunx eslint` — production code clean; spec/e2e at the accepted `no-unsafe-*` / `unbound-method` baseline only (matches existing `jobs`/`customers` specs). The `admin.rpc(...)` destructure carries the same accepted single `no-unsafe-assignment` as `createJob`/`auth.service.ts:268`.
  - [x] Confirm the new migration file is committed in `supabase/migrations/` **and** applied (project-context rule #3). No RLS policy change → the `rls-isolation` integration test (AR-20) is not triggered by this story, but do not break it.

### Review Findings

_Code review 2026-06-21 (adversarial: Blind Hunter + Edge Case Hunter + Acceptance Auditor). All 15 ACs SATISFIED. 3 patch findings (1 HIGH data-integrity, 2 defensive hardening) — all applied & verified; 10 dismissed as by-design/false-positive/already-deferred._

- [x] [Review][Patch] One-sided schedule-window inversion (HIGH) — the inversion guard only fires when BOTH `scheduledStart` and `scheduledEnd` are in the body. A PATCH sending only `scheduledStart` (later than the stored `scheduled_end`), or only `scheduledEnd` (earlier than the stored `scheduled_start`), persists an inverted `start > end` window with no validation. The "mirrors createJob" rationale doesn't hold — createJob always has both bounds; PATCH does not. Fix authoritatively inside the RPC: after the `FOR UPDATE` select, compute the effective window from `COALESCE(p_*, v_job.*)` and `RAISE … USING ERRCODE = 'PT422'` when `effective_end IS NOT NULL AND effective_end < effective_start`; map `PT422` → 422 `VALIDATION_ERROR` in the service. Add a unit + e2e test for the one-sided case. [supabase/migrations/20260621000004_rpc_update_job_with_log.sql, src/jobs/jobs.service.ts:347-359]
- [x] [Review][Patch] Reassignment-log technician comparison uses `<>` not `IS DISTINCT FROM` (MEDIUM, latent) — `IF p_technician_id IS NOT NULL AND p_technician_id <> v_old_tech`. `technician_id` is `NOT NULL` today so this is currently unreachable, but if the column ever becomes nullable, `<> NULL` evaluates to UNKNOWN and the `job_reassigned` audit entry for a first-assignment would be silently skipped. Cheap null-safe hardening: `IF p_technician_id IS DISTINCT FROM v_old_tech`. [supabase/migrations/20260621000004_rpc_update_job_with_log.sql]
- [x] [Review][Patch] Final `RETURN QUERY` re-selects by `id` only, not tenant-scoped (LOW, defense-in-depth) — `RETURN QUERY SELECT * FROM jobs WHERE id = p_job_id`. Correct within the transaction (the row was tenant-verified by the earlier `FOR UPDATE`), but inconsistent with the tenant-scoped discipline used everywhere else; add `AND tenant_id = p_tenant_id` so a future refactor that drops the early lock can't leak a cross-tenant row. [supabase/migrations/20260621000004_rpc_update_job_with_log.sql]

## Dev Notes

### This story ADDS a PATCH endpoint + one new RPC — no schema/table/RLS change

`jobs`, `activity_logs`, `users`, `customers` all exist and are RLS-enabled. `JobsModule`/`JobsService`/`JobsController`, `JobResponse`/`JobRow`/`toResponse`, and `ErrorCode.JOB_NOT_MODIFIABLE` (already in the enum) all exist. This story ADDS: one `PATCH :id` route, one `updateJob` service method, one `UpdateJobDto`, and **one new RPC migration** (`update_job_with_log`). **No new table, no column change, no RLS change, no `app.module.ts`/`jobs.module.ts` change, no new module.** [Source: src/jobs/jobs.service.ts; src/common/enums/error-code.enum.ts:11; supabase/migrations/20260621000002_create_jobs.sql]

### `create_job_with_log` is the atomic-write precedent — mirror it for `update_job_with_log`

AR-10 (Activity Log Atomicity): a state change and its activity-log entry MUST be a single `supabase.rpc()` transaction — never two sequential `supabase.from()` calls. Story 3.1 established this with `create_job_with_log` (job INSERT + `job_created` log). This story's reassign (UPDATE + `job_reassigned`) and cancel (UPDATE + `job_cancelled`) are the same pattern. Copy the migration's header, `SECURITY DEFINER`, `SET search_path = public`, and `RETURNS SETOF jobs` shape verbatim. [Source: supabase/migrations/20260621000003_rpc_create_job_with_log.sql; architecture.md:1087-1101 (Activity Log Atomicity); epics.md#Story 3.4 Implementation Notes line 586]

### CRITICAL: `updated_at` has NO database trigger — the RPC must set it explicitly

`jobs.updated_at` is `TIMESTAMPTZ NOT NULL DEFAULT now()` but there is **no `BEFORE UPDATE` trigger** to refresh it. A plain `UPDATE` would leave `updated_at` stale. **Every `UPDATE jobs` in the RPC must include `updated_at = now()`** (both the edit path and the cancel path). [Source: supabase/migrations/20260621000002_create_jobs.sql:25-27 — no trigger defined]

### CRITICAL: the `scheduled`-only state guard belongs INSIDE the RPC (TOCTOU)

If the service did "SELECT status → check → UPDATE" as two calls, a concurrent workflow-step advance (Story 3.5) could move the job to `in_progress` between the check and the write, letting an edit slip through on a non-`scheduled` job. **Do the guard inside the transaction**: `SELECT … FOR UPDATE` locks the row, then `IF status <> 'scheduled' THEN RAISE`. This makes AC#4/#5 race-safe. The `FOR UPDATE` lock also serializes concurrent PATCHes on the same job. [Source: architecture.md AR-10 rationale (PostgREST runs each RPC in one transaction); epics.md#Story 3.4 AC lines 573-579]

### Mapping the RPC's "not modifiable" raise to HTTP 409

The RPC raises a custom-SQLSTATE exception for a non-`scheduled` job; supabase-js surfaces it as `{ error: { code, message, … } }`. The service inspects `error.code` and maps the not-modifiable code → **409 `JOB_NOT_MODIFIABLE`**, the FK-violation `23503` → **404**, and anything else → **500**. The recommended SQLSTATE is **`PT409`** (PostgREST maps a `PTxxx` SQLSTATE's last three digits to HTTP `xxx`, which is a useful happens-to-align default — but here we read the error object ourselves, we do not rely on PostgREST's HTTP mapping). **Do NOT guess the surfaced `error.code`** — Task 6 calls the RPC via MCP, records the exact code supabase-js returns, and that confirmed value is what the service and unit test match on. [Source: feedback-use-mcp-and-docs memory — verify library behavior, don't assume; src/jobs/jobs.service.ts:280-286 (existing 23503→404 precedent)]

### `UpdateJobDto` — use `PartialType(PickType(...))`, NOT the stale epic/architecture `OmitType`

Both the epic (line 587) and architecture.md (lines 1078-1083) suggest `PartialType(OmitType(CreateJobDto, ['tenantId', 'createdBy'] as const))`. **That guidance is stale/generic and wrong for this DTO:**
- `CreateJobDto` has **no** `tenantId` or `createdBy` field (those never existed on it), so the `OmitType` omits nothing.
- `OmitType` would therefore expose **every** `CreateJobDto` field — including the **immutable** `serviceLocation`, `serviceType`, `customerId`, and `newCustomer`, which FR-9 does **not** list as mutable. Allowing them through PATCH would let an owner silently re-point a job to a different customer or change its service type with no log entry.

Correct approach: `PartialType(PickType(CreateJobDto, ['description', 'scheduledStart', 'scheduledEnd', 'notesForTechnician', 'technicianId', 'priority'] as const))` — exactly the FR-9 mutable set — then add the cancellation-only `status` field. This reuses CreateJobDto's validators (`@Transform(trim)`, `@MaxLength(2000)`, `@IsUUID`, `@IsISO8601`, `@IsEnum`) and keeps the contract tight. The global `ValidationPipe` runs `whitelist: true, forbidNonWhitelisted: false` (verified in src/main.ts:25-29), so any property not on the DTO schema (e.g. `customerId`, `serviceType`, `serviceLocation`, `newCustomer`) is **silently stripped** — and because `PickType` excludes them from the schema entirely, those immutable fields can never reach the service even if a client sends them. [Source: src/jobs/dto/create-job.dto.ts; src/main.ts:25-29; architecture.md:1076-1083 (generic Update DTO pattern); epics.md line 587; FR-9 mutable list line 35]

### Cancellation vs edit are mutually exclusive (AC#14) — one event per request

The activity log must record exactly one event per PATCH: `job_cancelled` OR `job_reassigned`, never both. So a body mixing `status:'cancelled'` with mutable fields is rejected 422 at the service layer (before the RPC). Inside the RPC, `p_cancel` selects the branch: cancel writes `job_cancelled` and ignores the edit params; edit writes the COALESCE update and conditionally `job_reassigned`. This keeps the transaction semantics unambiguous. [Source: epics.md#Story 3.4 AC lines 565-571; FR-11 event types line 39]

### Reassignment log fires only on an ACTUAL technician change

`job_reassigned` is logged only when `p_technician_id IS NOT NULL AND p_technician_id <> previous technician_id`. Re-submitting the same technician (or omitting `technicianId`) is a no-op for the log — the metadata would otherwise record `previous == new`, which is noise. The `previousTechnicianId` is captured from the locked row **before** the UPDATE. Metadata keys are **camelCase** (`previousTechnicianId`, `newTechnicianId`) per the JSON-field convention. [Source: epics.md#Story 3.4 AC line 567; architecture.md:895 (JSON fields camelCase)]

### COALESCE limitation — clearing a nullable field to `null` is OUT OF SCOPE

The `COALESCE(p_field, existing)` pattern means a `null` param is treated as "leave unchanged", so this endpoint **cannot clear** the nullable fields (`scheduledEnd`, `description`, `notesForTechnician`) back to `null`. The AC set only requires **setting** values, and class-validator's `@IsOptional` cannot distinguish an absent key from an explicit `null` anyway. This is an accepted MVP limitation — **add a `deferred-work.md` note** so a later story can introduce explicit-clear semantics (e.g. per-field `p_set_*` flags or a sentinel) if the product needs it. [Source: src/jobs/jobs.service.ts:260-274 (createJob's `?? null` param style); deferred-work.md]

### Status-code map (consistent with the jobs module)

- `ParseUUIDPipe` malformed `:id` → **400** (AC#9). [Source: src/jobs/jobs.controller.ts:84]
- Business `BadRequestException` (no-tenant) → **400 `VALIDATION_ERROR`** (AC#10).
- DTO validation failure (bad `status` enum, type errors) → **422** via the global `ValidationPipe` (`errorHttpStatusCode: 422`). Body-shape rules (empty patch, cancel+edit mix, inverted window) → **422 `VALIDATION_ERROR`** thrown in the service as `HttpException(..., 422)` (AC#12, #13, #14, #15) — mirror `createJob`'s `HttpException(..., HttpStatus.UNPROCESSABLE_ENTITY)` usage.
- Missing/invalid JWT → **401 `UNAUTHORIZED`** (global `JwtAuthGuard`) (AC#11).
- Technician JWT on owner-only route → **403 `FORBIDDEN`** (`RolesGuard`) (AC#6).
- Not-found / cross-tenant / invalid technician → **404 `RESOURCE_NOT_FOUND`** (AC#7, #8).
- Non-`scheduled` job → **409 `JOB_NOT_MODIFIABLE`** (AC#4, #5).
[Source: src/common/enums/error-code.enum.ts; src/main.ts ValidationPipe (errorHttpStatusCode 422); src/jobs/jobs.service.ts createJob 422 usages]

### The 422-vs-400 split (do not confuse them)

This module already distinguishes: **no-tenant business precondition → 400** (`BadRequestException`), but **input/body validation → 422** (`HttpException` with `UNPROCESSABLE_ENTITY`, or DTO failures via the pipe). Follow `createJob` exactly: it throws `BadRequestException` for no-tenant (400) and `HttpException(..., 422)` for the customerId/newCustomer XOR and the inverted-window check. [Source: src/jobs/jobs.service.ts:160-194]

### Scope boundaries

- **Mutation of ONE `scheduled` job only.** No workflow-step advance (Story 3.5), no attachment handling (Story 3.6).
- Mutable fields per FR-9: `description`, `scheduledStart`, `scheduledEnd`, `notesForTechnician`, `technicianId`, `priority`. **Immutable** (must NOT be patchable): `serviceLocation`, `serviceType`, `customerId`, `newCustomer`, `jobNumber`, `status` (except `→ cancelled`), `currentStep`.
- `status` via PATCH may **only** be `cancelled`; `in_progress`/`completed` transitions are the workflow endpoint's job (3.5).
- Owner-only route; no technician access (no service-layer ownership gate needed — `RolesGuard` blocks technicians at 403 before the service).
- No clearing of nullable fields to `null` (COALESCE limitation — deferred).
- One new RPC migration; no other schema/RLS change.

### Testing standards

- **Unit** (`src/jobs/jobs.service.spec.ts`): extend the table-dispatch mock to (a) serve `from('users').…single()` for technician validation and (b) make `admin.rpc('update_job_with_log', args)` a capturable mock returning `{ data, error }`. Assert: the rpc param mapping (`p_cancel`, `p_technician_id`, changed fields), the 409/404/422/400 branches, and that technician validation runs **before** the rpc. The create path (`create_job_with_log`) and detail reads must keep working — dispatch `rpc` by function name.
- **E2E** (`test/jobs.e2e-spec.ts`): extend `mockAdmin` to serve the update rpc + technician `.single()`; reuse `ownerJwt`/`techJwt` and the `ValidationPipe { whitelist, transform, errorHttpStatusCode: 422 }` from `beforeAll`. Assert the updated `JobResponse` body, 403 for technician, 409 for non-scheduled, 404 for missing/cross-tenant, 400 for malformed uuid + no-tenant, 422 for the body-shape rules, 401 for no-auth.
- **Live RPC** (Task 6, Supabase MCP, project `pnlvreaijzslfymlnoti`): this is where the atomicity + log-metadata + raise-code behaviors are confirmed against the real DB — the unit/e2e mocks cannot prove the transaction or the surfaced SQLSTATE. Record the confirmed not-modifiable `error.code` and wire it into code + tests.
- **Lint baseline (accepted, do not fight):** spec/e2e `@typescript-eslint/unbound-method` on jest mocks + `no-unsafe-member-access` on `JSON.parse(response.body)`; in `jobs.service.ts` the single `admin.rpc(...)` destructure carries the same accepted `no-unsafe-assignment` baseline as `createJob` / `auth.service.ts:268`. Production code otherwise lints clean.
- No real-DB integration test in the CI suite (CI has no DB — AR-20 / J1 infra gap in deferred-work.md). All app logic is unit-testable with mocks; the live RPC check is a manual MCP gate during dev.

### Project Structure Notes

- **New:** `src/jobs/dto/update-job.dto.ts`, `supabase/migrations/20260621000004_rpc_update_job_with_log.sql`.
- **Modified:** `src/jobs/jobs.service.ts` (+`updateJob`, import `Patch`-related nothing — service only; reuse existing imports `BadRequestException`/`HttpException`/`HttpStatus`/`InternalServerErrorException`/`NotFoundException`/`ErrorCode`/`JobStatus`), `src/jobs/jobs.controller.ts` (+`@Patch(':id')`, import `Patch`), `src/jobs/jobs.service.spec.ts` (+update unit tests), `test/jobs.e2e-spec.ts` (+PATCH describe), `_bmad-output/implementation-artifacts/deferred-work.md` (COALESCE-clear limitation note).
- **No** `app.module.ts`/`jobs.module.ts` change (DTO is auto-wired by the controller param; the RPC lives in the DB).
- Naming: service method `updateJob`; DTO `UpdateJobDto`; RPC `update_job_with_log` (mirrors `create_job_with_log`).

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 3.4: Edit, Reassign & Cancel Job (lines 557-589)] — the 5 epic ACs + implementation notes (RPC atomicity; the **stale** OmitType hint)
- [Source: _bmad-output/planning-artifacts/epics.md#FR-9 (line 35)] — mutable field list; owner-only; 409 invalid transition; `job_reassigned`/`job_cancelled` logs
- [Source: _bmad-output/planning-artifacts/epics.md#FR-11 (line 39)] — canonical activity-log event types incl. `job_reassigned`, `job_cancelled`
- [Source: _bmad-output/planning-artifacts/architecture.md:1087-1101] — Activity Log Atomicity (AR-10): state change + log in one `supabase.rpc()` transaction
- [Source: _bmad-output/planning-artifacts/architecture.md:1076-1083] — generic Update DTO pattern (omit immutable fields) — applied here as `PickType` of the mutable subset
- [Source: _bmad-output/planning-artifacts/architecture.md:1062-1064] — `JOB_NOT_MODIFIABLE` belongs to the Jobs error group
- [Source: supabase/migrations/20260621000003_rpc_create_job_with_log.sql] — the RPC header/style/`RETURNS SETOF jobs` to mirror; `SECURITY DEFINER`, `SET search_path = public`
- [Source: supabase/migrations/20260621000002_create_jobs.sql:18-27, 41-50] — `jobs.status` CHECK values, `updated_at` has **no trigger**, `activity_logs.metadata` JSONB column
- [Source: src/jobs/jobs.service.ts:159-305] — `createJob`: no-tenant 400, 422 input guards, technician validation block, `admin.rpc` call + `RETURNS SETOF` array handling, `23503`→404 mapping, `toResponse`
- [Source: src/jobs/jobs.controller.ts:62-87] — `@Get(':id')` + `ParseUUIDPipe` (400) + `@Roles` + `@ApiResponse` conventions to mirror for `@Patch(':id')`
- [Source: src/jobs/dto/create-job.dto.ts] — validators/transformers to inherit via `PickType`
- [Source: src/jobs/enums/job-status.enum.ts] — `JobStatus.CANCELLED` for the DTO `@IsIn` and the cancel branch
- [Source: src/common/enums/error-code.enum.ts:11] — `JOB_NOT_MODIFIABLE` already defined
- [Source: live Supabase schema, project pnlvreaijzslfymlnoti — list_migrations] — all jobs migrations applied; no `update_job_with_log` RPC exists yet
- [Source: 3-3-job-detail.md] — single-literal-select / lint baseline / tenant-scope-defense-in-depth / 404-before-403 facts; mock-shape patterns for the jobs specs
- [Source: project-context.md] — Supabase MCP for all DB work; migration files committed AND applied via MCP; never two sequential calls for an atomic write (AR-10)

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m]

### Debug Log References

- Build clean (`bun run build`). Full regression: unit **147/147** (11 suites), e2e **120 pass / 2 skip** (8 suites). No regressions.
- `jobs.service.spec.ts` 38 → **50** (+12 `updateJob` unit tests). `jobs.e2e-spec.ts` +12 `PATCH /api/v1/jobs/:id` tests.
- **Live RPC verification (Supabase MCP, project `pnlvreaijzslfymlnoti`):** seeded a throwaway tenant/owner/2-technicians/customer/2-jobs (one `scheduled`, one `completed`), exercised `update_job_with_log`, then deleted all seed rows (DB confirmed back to 0 tenants / 0 jobs / 0 customers). Confirmed: edit updates fields + bumps `updated_at`; reassign (b1→b2) inserts exactly one `job_reassigned` with `metadata = {"previousTechnicianId":…,"newTechnicianId":…}`; same-tech reassign inserts NO log; cancel sets `status='cancelled'` + one `job_cancelled` log (final trail `job_reassigned,job_cancelled`); a non-`scheduled` job raises **SQLSTATE `PT409`** (captured via `GET STACKED DIAGNOSTICS`) and leaves the row untouched; a missing/cross-tenant `p_job_id` returns the empty set and writes nothing.
- **PostgREST contract (Context7-verified):** a `PTxyz` SQLSTATE sets the HTTP status to `xyz` AND the error body's `code` field carries the SQLSTATE — so supabase-js surfaces `error.code === 'PT409'`. The service matches on that.
- **Lint:** production files (`jobs.service.ts`, `jobs.controller.ts`, `update-job.dto.ts`) clean except the accepted `admin.rpc()` destructure `no-unsafe-assignment` — now 2 occurrences (existing `createJob` + new `updateJob`), the identical accepted pattern (`auth.service.ts:268`). spec/e2e at the accepted `no-unsafe-*` baseline (`JSON.parse(response.body)`).

### Completion Notes List

- Added `PATCH /api/v1/jobs/:id` (owner-only) to edit / reassign / cancel a `scheduled` job, returning the updated `JobResponse`. Backed by a new `update_job_with_log` RPC (atomic job UPDATE + activity-log insert, AR-10).
- **State guard inside the RPC** (`SELECT … FOR UPDATE` then `IF status <> 'scheduled' THEN RAISE … PT409`) — TOCTOU-safe against a concurrent workflow advance; mapped to **409 `JOB_NOT_MODIFIABLE`**. `updated_at = now()` is set explicitly in the RPC (no DB trigger exists).
- **`UpdateJobDto = PartialType(PickType(CreateJobDto, mutable-subset))`** + cancellation-only `status` (`@IsIn([CANCELLED])`). Deliberately NOT `OmitType` (the epic/architecture hint) — that would leak the immutable `serviceLocation`/`serviceType`/`customerId`/`newCustomer`.
- **Cancellation ⊻ edit** are mutually exclusive (422 on mix) so the log records exactly one event per request. **`job_reassigned` fires only on an actual technician change**, metadata `{previousTechnicianId, newTechnicianId}` (camelCase).
- Validation: no-tenant → 400; empty body / cancel+edit / inverted window → 422; bad `status` enum → 422 (DTO); technician-not-in-tenant → 404; non-scheduled → 409; missing/cross-tenant → 404; technician JWT → 403 (RolesGuard); malformed id → 400 (`ParseUUIDPipe`).
- **COALESCE limitation** (can't clear nullable fields to `null`) logged as deferred-work E1; live-RPC-only verification gap logged as E2.

### File List

- `supabase/migrations/20260621000004_rpc_update_job_with_log.sql` (new — atomic edit/reassign/cancel RPC; applied via Supabase MCP)
- `src/jobs/dto/update-job.dto.ts` (new — `UpdateJobDto`, PickType mutable subset + cancellation-only `status`)
- `src/jobs/jobs.service.ts` (modified — `updateJob` method; `UpdateJobDto` import)
- `src/jobs/jobs.controller.ts` (modified — `@Patch(':id')` handler; `Patch` + `UpdateJobDto` imports)
- `src/jobs/jobs.service.spec.ts` (modified — +12 `updateJob` unit tests)
- `test/jobs.e2e-spec.ts` (modified — +12 `PATCH /api/v1/jobs/:id` e2e tests)
- `_bmad-output/implementation-artifacts/deferred-work.md` (modified — E1 COALESCE-clear limitation, E2 live-RPC-only verification gap)

### Change Log

| Date       | Change                                  |
|------------|-----------------------------------------|
| 2026-06-21 | Story 3.4 created (ready-for-dev) — comprehensive context engine analysis. Key decisions: new `update_job_with_log` RPC mirrors `create_job_with_log` (atomic UPDATE + `job_reassigned`/`job_cancelled` log, AR-10); state guard `SELECT … FOR UPDATE` inside the RPC (TOCTOU-safe `scheduled`-only rule); RPC must set `updated_at = now()` (no DB trigger exists); `UpdateJobDto = PartialType(PickType(CreateJobDto, mutable-subset))` + cancellation-only `status` (the epic/architecture `OmitType` hint is stale — would leak immutable fields); cancel and edit mutually exclusive (one log event per request, 422 on mix); `job_reassigned` logs only on an actual technician change with camelCase `previous/newTechnicianId` metadata; COALESCE can't clear nullables → deferred; not-modifiable raise mapped to 409 via a confirmed (MCP-verified) `error.code`. One new RPC migration; no table/RLS change. |
| 2026-06-21 | Story 3.4 implemented: `PATCH /api/v1/jobs/:id` (owner-only) edit/reassign/cancel of a `scheduled` job via the new `update_job_with_log` RPC. TOCTOU-safe `scheduled`-only guard + explicit `updated_at=now()` inside the RPC; `PT409` raise → 409 `JOB_NOT_MODIFIABLE` (PostgREST→supabase-js code mapping verified). `UpdateJobDto` = PickType mutable subset + cancellation-only `status`; cancel⊻edit (422); `job_reassigned` only on real tech change with camelCase metadata. +12 unit, +12 e2e. Unit 147/147, e2e 120 pass/2 skip, build clean, prod lint at accepted baseline. Migration written to `supabase/migrations/` AND applied via MCP; RPC behaviors verified live then seed cleaned up. COALESCE-clear + live-RPC-only-verification gaps deferred (E1/E2). Status → review. |
| 2026-06-21 | Code review (adversarial 3-layer): all 15 ACs satisfied. 3 patch findings applied — (P1, HIGH) one-sided schedule-window inversion now rejected inside the RPC via an effective-window check raising `PT422` → mapped to 422 `VALIDATION_ERROR`, with +1 unit/+1 e2e test; (P2) `<>` → `IS DISTINCT FROM` null-safe technician comparison; (P3) final `RETURN QUERY` re-select now tenant-scoped (`AND tenant_id = p_tenant_id`). 10 findings dismissed (by-design/false-positive/already-deferred). RPC re-applied via MCP and the PT422 one-sided guard verified live (raises PT422, leaves the row unmutated, valid one-sided edit succeeds) then seed cleaned up. Unit 148/148, e2e 121 pass/2 skip, build clean, prod lint at accepted baseline (2 × accepted `admin.rpc()` destructure). Status → done. |
