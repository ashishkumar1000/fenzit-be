---
baseline_commit: 15566038fc9b706e1ac65c03479f517c6f438ce9
---

# Story 3.5: Technician Workflow Step Advancement

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a technician,
I want to advance a job through its 6 ordered workflow steps,
so that the owner sees my real-time progress and the job lifecycle is fully and immutably recorded.

## Acceptance Criteria

1. **Given** a `scheduled` job assigned to me with `current_step = null` and body `{ "step": "on_my_way" }`, **when** `POST /api/v1/jobs/:id/workflow` is called by the **assigned technician**, **then** HTTP 200 with the updated `JobResponse`; the job `status` transitions `scheduled → in_progress`, `current_step` becomes `on_my_way`, and a `step_on_my_way` activity-log entry is appended. (Atomic: the job UPDATE and the log INSERT happen in one transaction.)

2. **Given** an `in_progress` job with `current_step = on_my_way` and body `{ "step": "arrived" }`, **when** the endpoint is called by the assigned technician, **then** HTTP 200; `current_step` becomes `arrived`, `status` stays `in_progress`, and a `step_arrived` log entry is appended.

3. **Given** an `in_progress` job with `current_step = signature_captured` and body `{ "step": "completed" }`, **when** the endpoint is called by the assigned technician, **then** HTTP 200; `status` transitions `in_progress → completed`, `current_step` becomes `completed`, and a `step_completed` log entry is appended.

4. **Given** an `in_progress` job with `current_step = in_progress` **and `require_completion_photo = false`** and body `{ "step": "signature_captured" }`, **when** the endpoint is called by the assigned technician, **then** HTTP 200 — `photos_uploaded` is **validly skipped**, `current_step` becomes `signature_captured`, and a `step_signature_captured` log entry is appended.

5. **Given** an `in_progress` job with `current_step = in_progress` **and `require_completion_photo = true`** and body `{ "step": "signature_captured" }`, **when** the endpoint is called by the assigned technician, **then** HTTP 422 with `error_code: "INVALID_WORKFLOW_STEP"` and `currentStep: "in_progress"` in the response body — `photos_uploaded` may **not** be skipped when a completion photo is required.

6. **Given** a job whose `current_step = on_my_way` and body `{ "step": "completed" }` (a step submitted out of order), **when** the endpoint is called by the assigned technician, **then** HTTP 422 with `error_code: "INVALID_WORKFLOW_STEP"` and `currentStep: "on_my_way"` in the response body; the job is left **unchanged** (no write, no log).

7. **Given** a job whose `current_step` already equals (or is past) the submitted step and **no** `X-Idempotency-Key` header, **when** the same step is replayed, **then** HTTP 422 with `error_code: "INVALID_WORKFLOW_STEP"` and the current `currentStep` in the body — a backward/same step is out of order. (Idempotent dedup of an in-flight retry is AC #8; conflict-tolerant offline replay is refined later in Story 4.3.)

8. **Given** an `X-Idempotency-Key: {uuid-v4}` header on a workflow-step call that already succeeded within the last 24 hours (same key, same tenant), **when** the identical request is re-submitted, **then** HTTP 200 with the **original** response body; the step is **NOT** re-applied — the `advance_workflow_step` RPC is never called again and **no** new activity-log entry is written.

9. **Given** a workflow-step call **without** the `X-Idempotency-Key` header, **when** the endpoint is called, **then** the request proceeds normally with no idempotency check (the key is optional per FR-17).

10. **Given** an **Owner** JWT, **when** `POST /api/v1/jobs/:id/workflow` is called, **then** HTTP 403 with `error_code: "FORBIDDEN"` (enforced by `RolesGuard` — route is technician-only; the service is never reached).

11. **Given** a **technician** who is **not** the assignee of the job (job exists in the same tenant but `technician_id !== caller`), **when** the endpoint is called, **then** HTTP 403 with `error_code: "FORBIDDEN"` — resolved **after** the 404 check so a cross-tenant job is never disclosed as 403. (Mirrors `getJobDetail`'s ownership gate.)

12. **Given** a job id (valid UUID) that does not exist in the caller's tenant — including a job in a **different** tenant, **when** the endpoint is called, **then** HTTP 404 with `error_code: "RESOURCE_NOT_FOUND"` — cross-tenant access is indistinguishable from not-found (never 403). [Matches `getJobDetail`/`updateJob`.]

13. **Given** a malformed `:id` (not a UUID), **when** the endpoint is called, **then** HTTP 400 (via `ParseUUIDPipe`) — consistent with `GET`/`PATCH /api/v1/jobs/:id`.

14. **Given** a technician JWT whose `tenantId` is `null` (company not set up), **when** the endpoint is called, **then** HTTP 400 with `error_code: "VALIDATION_ERROR"` — consistent with `createJob`/`listJobs`/`getJobDetail`/`updateJob`.

15. **Given** no `Authorization` header, **when** the endpoint is called, **then** HTTP 401 with `error_code: "UNAUTHORIZED"`.

16. **Given** a body whose `step` is missing or not one of the six valid steps (`on_my_way`, `arrived`, `in_progress`, `photos_uploaded`, `signature_captured`, `completed`), **when** the endpoint is called, **then** HTTP 422 with `error_code: "VALIDATION_ERROR"` (via the global `ValidationPipe` + DTO `@IsEnum(WorkflowStep)`).

17. **Given** a job in a **terminal** status (`completed` or `cancelled`) and **any** step in the body, **when** the endpoint is called by the assigned technician, **then** HTTP 409 with `error_code: "JOB_NOT_MODIFIABLE"` — a finished or cancelled job cannot advance; the job is left unchanged.

18. **Given** the job's `current_step` is changed by a concurrent advance **between** the service's read and the RPC's write, **when** the RPC executes its `SELECT … FOR UPDATE` compare-and-set, **then** the stale request is rejected (RPC raises → mapped to **409 `JOB_NOT_MODIFIABLE`**) and exactly one of the racing advances wins — no double-applied step, no duplicate log. (TOCTOU safety; verified live via MCP in the verification task.)

## Tasks / Subtasks

- [x] **Task 1 — `idempotency_log` table migration** (AC: #8, #9)
  - [x] Create `supabase/migrations/20260621000005_create_idempotency_log.sql`. Follow the header/style of `20260621000002_create_jobs.sql` (comment banner, `ENABLE ROW LEVEL SECURITY`, a `*_tenant_isolation` policy mirroring `jobs_tenant_isolation`).
  - [x] Columns exactly per epic Implementation Notes (line 624): `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`, `key TEXT NOT NULL`, `tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE`, `response_body JSONB NOT NULL`, `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`, and `UNIQUE (key, tenant_id)` (AR-9 — cross-tenant keys never collide; the unique index also serves the guard's lookup).
  - [x] RLS: `ENABLE ROW LEVEL SECURITY` + policy `idempotency_log_tenant_isolation FOR ALL USING (tenant_id = (auth.jwt() ->> 'tenantId')::uuid) WITH CHECK (...)` — defense-in-depth, identical shape to `jobs`/`activity_logs` (the interceptor uses `createAdmin()` which bypasses RLS; app-layer `tenant_id` scoping is the real gate).
  - [x] **Do NOT add the `pg_cron` 24-hour cleanup job here** — that is explicitly Story 4.2's scope (epics.md line 747). To keep the 24-hour window correct *before* the cron exists, the interceptor's lookup filters `created_at > now() - 24h` (Task 5). Note this in a SQL comment.
  - [x] **Apply via Supabase MCP** (`mcp__supabase__apply_migration`, project `pnlvreaijzslfymlnoti`). Committed `.sql` AND applied migration must match (project-context rule #3).

- [x] **Task 2 — `advance_workflow_step` RPC migration** (AC: #1, #2, #3, #4, #17, #18)
  - [x] Create `supabase/migrations/20260621000006_rpc_advance_workflow_step.sql` following the exact header/style of `20260621000003_rpc_create_job_with_log.sql` and `…000004_rpc_update_job_with_log.sql` (`LANGUAGE plpgsql`, `SECURITY DEFINER`, `SET search_path = public`, `RETURNS SETOF jobs`).
  - [x] Signature — note this is a **superset** of the architecture sketch (architecture.md:1104-1114), which omits tenant scoping, status transition, the `activity_logs.tenant_id` NOT-NULL column, and the TOCTOU compare-and-set; the sketch is illustrative only — implement the full version:
    `advance_workflow_step(p_job_id UUID, p_tenant_id UUID, p_actor_id UUID, p_step TEXT, p_new_status TEXT, p_expected_current_step TEXT)`.
  - [x] Body logic (all guards INSIDE the transaction):
    1. `SELECT * INTO v_job FROM jobs WHERE id = p_job_id AND tenant_id = p_tenant_id FOR UPDATE;` — tenant-scoped **row lock**.
    2. `IF NOT FOUND THEN RETURN; END IF;` — empty set → app maps to **404** (AC#12).
    3. `IF v_job.status NOT IN ('scheduled','in_progress') THEN RAISE EXCEPTION 'job % not advanceable in status %', p_job_id, v_job.status USING ERRCODE = 'PT409'; END IF;` — terminal `completed`/`cancelled` → **409** (AC#17).
    4. `IF v_job.current_step IS DISTINCT FROM p_expected_current_step THEN RAISE EXCEPTION 'workflow step changed concurrently (expected %, found %)', p_expected_current_step, v_job.current_step USING ERRCODE = 'PT409'; END IF;` — **compare-and-set** closes the TOCTOU window (AC#18). `IS DISTINCT FROM` is null-safe (`current_step` is nullable; the very first `on_my_way` advance passes `p_expected_current_step = NULL`).
    5. `UPDATE jobs SET current_step = p_step, status = COALESCE(p_new_status, status), updated_at = now() WHERE id = p_job_id;` — `p_new_status` is `'in_progress'` for `on_my_way`, `'completed'` for `completed`, else `NULL` (status unchanged). **`updated_at = now()` is mandatory — `jobs` has NO update trigger** (see Dev Notes).
    6. `INSERT INTO activity_logs (job_id, tenant_id, event_type, actor_id) VALUES (p_job_id, p_tenant_id, 'step_' || p_step, p_actor_id);` — event_type is `step_<step>` (e.g. `step_on_my_way`). `tenant_id` and `actor_id` are **NOT NULL** on `activity_logs` — both must be passed (the architecture sketch omits `tenant_id`; the real table requires it).
    7. `RETURN QUERY SELECT * FROM jobs WHERE id = p_job_id AND tenant_id = p_tenant_id;` — tenant-scoped re-select (consistent with `update_job_with_log`'s P3 review patch).
  - [x] **Apply via Supabase MCP** and confirm clean. Committed `.sql` AND applied migration must match.

- [x] **Task 3 — `WorkflowStep` enum + `AdvanceWorkflowDto`** (AC: #16)
  - [x] Create `src/jobs/enums/workflow-step.enum.ts`: `export enum WorkflowStep { ON_MY_WAY='on_my_way', ARRIVED='arrived', IN_PROGRESS='in_progress', PHOTOS_UPLOADED='photos_uploaded', SIGNATURE_CAPTURED='signature_captured', COMPLETED='completed' }`. Mirror the existing `JobStatus`/`JobPriority` enum file style.
  - [x] Create `src/jobs/dto/advance-workflow.dto.ts`:
    ```ts
    export class AdvanceWorkflowDto {
      @ApiProperty({ enum: WorkflowStep })
      @IsEnum(WorkflowStep)
      step: WorkflowStep;
    }
    ```
    (`@ApiProperty` from `@nestjs/swagger`, `@IsEnum` from `class-validator`.) A missing/invalid `step` → 422 via the global `ValidationPipe` (`errorHttpStatusCode: 422`). The `X-Idempotency-Key` is a **header**, NOT a DTO field — it is handled entirely by the interceptor (Task 5); do not add it to the DTO.

- [x] **Task 4 — `WorkflowService`** (AC: #1–#7, #11, #12, #14, #17, #18) — `src/jobs/workflow.service.ts`
  - [x] Create `@Injectable() WorkflowService` with `private readonly logger = new Logger(WorkflowService.name)` and constructor `(private readonly supabaseClientFactory: SupabaseClientFactory)`. It does **not** need `CustomersService`.
  - [x] Define the canonical order as a module-level const: `const STEP_ORDER: WorkflowStep[] = [ON_MY_WAY, ARRIVED, IN_PROGRESS, PHOTOS_UPLOADED, SIGNATURE_CAPTURED, COMPLETED];`
  - [x] `validateStep(currentStep: string | null, requested: WorkflowStep, requireCompletionPhoto: boolean): boolean` — pure, unit-testable:
    - `const curIdx = currentStep === null ? -1 : STEP_ORDER.indexOf(currentStep as WorkflowStep);`
    - `const reqIdx = STEP_ORDER.indexOf(requested);`
    - **Normal advance:** `if (reqIdx === curIdx + 1) return true;`
    - **Photo skip:** `if (!requireCompletionPhoto && requested === SIGNATURE_CAPTURED && currentStep === IN_PROGRESS) return true;` (skips `photos_uploaded` only when not required — AC#4; when required, this returns false → 422, AC#5).
    - else `return false`.
  - [x] `async advanceWorkflowStep(user: RequestUser, jobId: string, dto: AdvanceWorkflowDto): Promise<JobResponse>`:
    1. `if (!user.tenantId)` → `BadRequestException` `VALIDATION_ERROR` ("Company setup required before advancing jobs") (AC#14). Mirror `getJobDetail`.
    2. `const admin = this.supabaseClientFactory.createAdmin();` Fetch the job tenant-scoped: `.from('jobs').select('id, tenant_id, status, current_step, require_completion_photo, technician_id').eq('id', jobId).eq('tenant_id', user.tenantId).single<…>()`. `error.code !== 'PGRST116'` → 500; `!row || row.tenant_id !== user.tenantId` → **404** `RESOURCE_NOT_FOUND` (AC#12). **(Copy the guard-order discipline from `getJobDetail` jobs.service.ts:563-582 — real DB error 500 FIRST, then 404.)**
    3. **Ownership gate (AC#11):** `if (row.technician_id !== user.userId) throw new ForbiddenException({ error_code: ErrorCode.FORBIDDEN, message: 'Forbidden' });` — resolved **after** the 404 (mirror `getJobDetail` jobs.service.ts:586-591).
    4. **Friendly pre-checks** (the authoritative guards also live in the RPC for TOCTOU safety):
       - Terminal status: `if (row.status !== 'scheduled' && row.status !== 'in_progress')` → **409** `JOB_NOT_MODIFIABLE` (AC#17).
       - `if (!this.validateStep(row.current_step, dto.step, row.require_completion_photo))` → **422** `HttpException({ error_code: ErrorCode.INVALID_WORKFLOW_STEP, message: 'Invalid workflow step transition', currentStep: row.current_step }, HttpStatus.UNPROCESSABLE_ENTITY)` (AC#5, #6, #7). The `currentStep` extra field is forwarded to the body by the GlobalExceptionFilter passthrough (Task 6).
    5. Compute target status: `const newStatus = dto.step === ON_MY_WAY ? JobStatus.IN_PROGRESS : dto.step === COMPLETED ? JobStatus.COMPLETED : null;`
    6. Call RPC: `await admin.rpc('advance_workflow_step', { p_job_id: jobId, p_tenant_id: user.tenantId, p_actor_id: user.userId, p_step: dto.step, p_new_status: newStatus, p_expected_current_step: row.current_step });`
    7. **Error mapping (order matters):** `const code = (error as { code?: string }).code;` `if (code === 'PT409')` → **409** `JOB_NOT_MODIFIABLE` (terminal status raced in, or concurrent step change — AC#17, #18). Otherwise `logger.error` + **500**. **CONFIRM the exact surfaced `error.code` via the MCP task and match on it (don't hard-code `PT409` blindly — but it is the same contract proven for `update_job_with_log`).**
    8. **Empty result → 404:** `const rows = data as JobRow[] | null; if (!rows || rows.length === 0) throw new NotFoundException(... RESOURCE_NOT_FOUND ...)` (the RPC `RETURN`s an empty set when the job vanished between fetch and RPC).
    9. `return this.toResponse(rows[0]);` — **reuse a shared `toResponse`.** `JobsService.toResponse` is currently `private`; refactor it to a small reusable mapper. Options (pick the lowest-churn): (a) move the `JobRow`/`JobResponse` types + `toResponse` into a shared helper, or (b) make `JobsService.toResponse` `public` and inject `JobsService` into `WorkflowService`, or (c) duplicate the tiny mapper in `WorkflowService`. **Prefer (b)** — make `toResponse` public on `JobsService`, inject `JobsService` into `WorkflowService`; least duplication, `JobRow`/`JobResponse` already exported from jobs.service.ts. Do NOT re-derive the snake→camel mapping inconsistently.

- [x] **Task 5 — `IdempotencyInterceptor`** (AC: #8, #9, #16-adjacent) — `src/common/interceptors/idempotency.interceptor.ts`
  - [x] Create `@Injectable() IdempotencyInterceptor implements NestInterceptor` (mirror the existing `src/common/interceptors/logging.interceptor.ts` for file/Logger style). Constructor: `(private readonly supabaseClientFactory: SupabaseClientFactory)`.
  - [x] `async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>>`:
    1. `const req = context.switchToHttp().getRequest<FastifyRequest & { user?: RequestUser }>();`
    2. `const raw = req.headers['x-idempotency-key'];` (Fastify lower-cases header names.) `if (!raw || typeof raw !== 'string') return next.handle();` — **no key → proceed normally (AC#9).**
    3. **Validate UUID v4** with a regex; if malformed → throw `HttpException({ error_code: ErrorCode.VALIDATION_ERROR, message: 'X-Idempotency-Key must be a UUID v4' }, 422)`. (Decision: reject malformed keys to keep the dedup store clean; documented in Dev Notes.)
    4. `const user = req.user; if (!user?.tenantId) return next.handle();` — let the handler/service produce the 400 (AC#14); the interceptor never short-circuits a tenant-less request.
    5. `const admin = this.supabaseClientFactory.createAdmin();` Look up the cache **within the 24h window**: `.from('idempotency_log').select('response_body').eq('key', raw).eq('tenant_id', user.tenantId).gt('created_at', new Date(Date.now() - 24*60*60*1000).toISOString()).maybeSingle();`
    6. **Hit:** `if (!error && data) return of(data.response_body);` — short-circuits; the route handler (and thus the RPC) never runs (AC#8). RxJS `of()` per NestJS cache-interceptor pattern (Context7-verified). The route's `@HttpCode(200)` still applies to the short-circuited response.
    7. **Miss:** `return next.handle().pipe(tap((body) => { void admin.from('idempotency_log').insert({ key: raw, tenant_id: user.tenantId, response_body: body }).then(({ error: insErr }) => { if (insErr && insErr.code !== '23505') this.logger.error('idempotency_log insert failed', { insErr }); }); }));` — `tap` runs **only on a successful emission**, so failed advances are never cached (a retried failure re-executes). A `23505` from a concurrent duplicate is swallowed (the other request already cached it). The insert is fire-and-forget; it must never fail the request.
  - [x] Import `Observable`, `of` from `rxjs`; `tap` from `rxjs/operators`. Type the response generically (`unknown`); store/return it verbatim.

- [x] **Task 6 — Forward extra error fields in `GlobalExceptionFilter`** (AC: #5, #6, #7) — `src/common/filters/global-exception.filter.ts` + spec
  - [x] The filter currently sends only `{ statusCode, error_code, message, stack? }` and **drops** any other keys on the exception response object. AC#5/#6/#7 require `currentStep` in the 422 body. Patch the filter to forward extra fields: when `response` is an object, capture the remaining keys after removing `error_code`, `message`, `statusCode`, `stack` and spread them into the sent payload:
    ```ts
    // inside the `typeof response === 'object'` branch, after reading error_code/message:
    const { error_code: _ec, message: _m, statusCode: _sc, stack: _st, ...extra } = r;
    // ... then in reply.send: { statusCode, error_code, message, ...extra, ...(stack) }
    ```
  - [x] This is **backward compatible** — every existing thrown exception carries only `error_code` + `message`, so `extra` is empty and the output is byte-identical. This is the **one shared-infra change** in this story; keep it minimal and additive.
  - [x] Extend `src/common/filters/global-exception.filter.spec.ts`: (a) a new test that an `HttpException` whose body has an extra field (`{ error_code, message, currentStep: 'on_my_way' }`) yields that field in the response; (b) confirm the existing error-shaping tests still pass unchanged (no regression).

- [x] **Task 7 — Controller route + module wiring** (AC: #1, #10, #13, #15)
  - [x] `src/jobs/jobs.controller.ts`: add `@Post(':id/workflow')` handler:
    - Decorators: `@Roles(Role.TECHNICIAN)`, `@HttpCode(HttpStatus.OK)`, `@UseInterceptors(IdempotencyInterceptor)`, `@ApiOperation`, `@ApiHeader({ name: 'X-Idempotency-Key', required: false, description: 'UUID v4 — 24h replay dedup' })`, `@ApiResponse` (200/400/401/403/404/409/422).
    - Signature: `advanceWorkflow(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AdvanceWorkflowDto)` → `this.workflowService.advanceWorkflowStep(user, id, dto)`.
    - Inject `WorkflowService` into the controller constructor alongside `JobsService`.
    - Imports to add: `UseInterceptors` from `@nestjs/common`; `ApiHeader` from `@nestjs/swagger`; `WorkflowService`, `AdvanceWorkflowDto`, `IdempotencyInterceptor`.
    - Route ordering: `@Post(':id/workflow')` is a distinct verb+path from `@Post()` (create) and `@Get(':id')`; no shadowing. Place it after `updateJob` for readability.
  - [x] `src/jobs/jobs.module.ts`: add `WorkflowService` and `IdempotencyInterceptor` to `providers`. `SupabaseModule` is already imported (supplies `SupabaseClientFactory` to both). No `app.module.ts` change (the interceptor is route-scoped via `@UseInterceptors`, NOT a global `APP_INTERCEPTOR`).
  - [x] AC#13 (`ParseUUIDPipe` → 400), AC#10 (`@Roles(TECHNICIAN)` → owner gets 403 via `RolesGuard`), AC#15 (no JWT → 401 via global `JwtAuthGuard`) are all satisfied by the decorators — no service code needed.

- [x] **Task 8 — Unit tests** (AC: #1–#9, #11, #12, #14, #16, #17, #18)
  - [x] `src/jobs/workflow.service.spec.ts` (new — mirror `jobs.service.spec.ts` mock style: a `from()` table-dispatch + `rpc` mock on the `createAdmin()` return; inject a mocked `JobsService` exposing `toResponse`):
    - `validateStep` direct unit table: null→on_my_way ✓, on_my_way→arrived ✓, arrived→in_progress ✓, in_progress→photos_uploaded ✓, in_progress→signature_captured (photo=false) ✓, in_progress→signature_captured (photo=true) ✗, signature_captured→completed ✓, on_my_way→completed ✗, in_progress→on_my_way (backward) ✗, completed→completed (same) ✗.
    - `advanceWorkflowStep`: (a) on_my_way happy → 200, asserts rpc called with `p_new_status:'in_progress'`, `p_step:'on_my_way'`, `p_expected_current_step:null`; (b) completed happy → asserts `p_new_status:'completed'`; (c) arrived → asserts `p_new_status:null`; (d) out-of-order → **422** `INVALID_WORKFLOW_STEP`, body carries `currentStep`, **rpc NOT called**; (e) skip-photo-when-required → **422**; (f) owner-not-assignee → **403** (after fetch); (g) job not found / cross-tenant (PGRST116 / row null) → **404**; (h) no-tenant → **400**; (i) terminal status → **409**, rpc not called; (j) RPC `error.code==='PT409'` → **409**; (k) RPC empty `data:[]` → **404**.
  - [x] `src/common/interceptors/idempotency.interceptor.spec.ts` (new): (a) no header → `next.handle()` called, no DB lookup; (b) cache **hit** → returns cached body, `next.handle()` **NOT** called; (c) cache **miss** → `next.handle()` called and `insert` invoked with `{ key, tenant_id, response_body }`; (d) malformed key → **422** thrown, no lookup; (e) insert returns `23505` → swallowed (no throw, request still resolves); (f) no tenant on `req.user` → passthrough. Drive the observable with a small `CallHandler` stub (`{ handle: () => of(payload) }`) and `lastValueFrom`/subscribe.
  - [x] `src/common/filters/global-exception.filter.spec.ts` (extend): extra-field passthrough (Task 6) + unchanged baseline.

- [x] **Task 9 — E2E tests** (AC: #1, #5, #6, #9, #10, #11, #12, #13, #14, #15, #16, #17) — `test/jobs.e2e-spec.ts`
  - [x] Add a `POST /api/v1/jobs/:id/workflow` describe block. **Extend `mockAdmin`** (test/jobs.e2e-spec.ts:118-134) to also serve: `from('jobs').select(...).eq().eq().single()` (the job fetch — add a `job?` option returning `{ data: jobRow, error }`), `from('idempotency_log')` (the interceptor lookup — default a **miss**: `maybeSingle → { data: null, error: null }`, and a no-op `insert().then()`), and `rpc('advance_workflow_step')`. Keep the existing `customers`/`users`/`create`/`update` dispatch working (switch on table name and rpc function name).
  - [x] Add an `assignedTechJwt()` helper whose `sub === TECH_ID` (the existing `techJwt()` uses `sub: 'tech-uuid'`, which is NOT the assignee → useful for the 403 case). Use a `jobRow` variant with `current_step: null, status: 'scheduled'` for the happy path.
  - [x] Tests: on_my_way by assignee → **200** (`status:'in_progress'`, `currentStep:'on_my_way'`); out-of-order (`completed` on a `current_step:on_my_way` job, mock rpc untouched) → **422** `INVALID_WORKFLOW_STEP` with `currentStep` in body; skip-photo-when-required → **422**; owner JWT → **403** `FORBIDDEN`; non-assignee technician (`techJwt()`) → **403**; cross-tenant/missing job (`job: notFound`) → **404**; malformed uuid → **400**; no-tenant tech JWT → **400**; no-auth → **401**; invalid `step` enum → **422** `VALIDATION_ERROR`; terminal-status job (`job` with `status:'completed'`) → **409** `JOB_NOT_MODIFIABLE`; **no `X-Idempotency-Key`** path → 200 (AC#9). The full 24h-replay **hit** (AC#8) is covered by the interceptor unit test + the live MCP check (the e2e mock can optionally assert a `X-Idempotency-Key` miss still writes); do not over-engineer a stateful two-call mock here.

- [x] **Task 10 — Live verification via Supabase MCP** (AC: #1, #2, #3, #4, #8, #17, #18) — project `pnlvreaijzslfymlnoti`
  - [x] After applying both migrations, seed a **throwaway** tenant + technician (role `technician`) + customer + one `scheduled` job (`current_step = null`) using real ids (do not bypass RLS semantics for correctness; the RPC is `SECURITY DEFINER` by design).
  - [x] Walk the full chain via `advance_workflow_step`: `on_my_way` (assert `status → in_progress`, `current_step = on_my_way`, one `step_on_my_way` log) → `arrived` → `in_progress` → `signature_captured` with `require_completion_photo = false` (assert `photos_uploaded` skipped) → `completed` (assert `status → completed`). Confirm the `activity_logs` trail is `step_on_my_way, step_arrived, step_in_progress, step_signature_captured, step_completed` and `updated_at` advanced each call.
  - [x] Confirm a step on a **terminal** job raises and **record the exact `error.code` / SQLSTATE** supabase-js surfaces (expect `PT409`); wire it into the service + unit test if it differs.
  - [x] Confirm the **compare-and-set** guard: call with a stale `p_expected_current_step` (≠ the row's actual `current_step`) → raises `PT409`, row unchanged (AC#18).
  - [x] Confirm `idempotency_log`: insert a row `(key, tenant_id, response_body)`, re-select within 24h returns it, and the `UNIQUE(key, tenant_id)` rejects a duplicate with `23505`.
  - [x] **Leave the DB clean** — delete all seeded rows; confirm tenant/job/customer/idempotency counts return to their pre-test baseline.

- [x] **Task 11 — Verify + deferred-work** (AC: all)
  - [x] `bun run build` clean.
  - [x] Full regression: `bun run test` (unit) + e2e — no regressions; new suites green. (The `toResponse` visibility refactor in Task 4 must not break existing `JobsService` tests.)
  - [x] **Lint scope discipline:** run `bunx eslint --fix` on **only the files this story touches** — do NOT run `bun run lint` (it is `eslint "{src,apps,libs,test}/**/*.ts" --fix` and will reformat the whole repo; this happened in 3.4 and had to be reverted). Production code clean except the accepted `admin.rpc(...)` destructure `no-unsafe-assignment` baseline; spec/e2e at the accepted `no-unsafe-*`/`unbound-method` baseline.
  - [x] Confirm both new migration files are committed in `supabase/migrations/` **and** applied (project-context rule #3). **No RLS *policy* change to existing tables** — the new `idempotency_log` policy is additive; the `rls-isolation` integration test (AR-20) is not triggered, but do not break it.
  - [x] Add `deferred-work.md` notes for any gaps surfaced (expected: live-RPC/interceptor behaviors verified only via MCP, not a committed CI regression test — same J1/E2/AR-20 CI-no-DB gap; and the `pg_cron` 24h cleanup is Story 4.2).

### Review Findings (code review 2026-06-21)

- [x] [Review][Decision→Patch] Idempotency key not scoped to route/resource — cross-`:id` (and future cross-endpoint in Story 3.6) replay returned the **wrong** cached body. **Resolved (harden now):** researched the IETF Idempotency-Key draft + Stripe — the key must bind to the tenant AND the concrete request. Added a `scope` column (`"METHOD:/concrete/path"`) to `idempotency_log`, changed the UNIQUE to `(key, tenant_id, scope)`, and the interceptor now probes/inserts `scope`. Verified live via MCP: same key + different scope coexist; same key + same scope → `23505`. (A request-payload fingerprint is deferred — see deferred-work.md.) [src/common/interceptors/idempotency.interceptor.ts; supabase/migrations/20260621000005_create_idempotency_log.sql] (blind+edge+auditor)
- [x] [Review][Patch] `GlobalExceptionFilter` leaked Nest's default `error` envelope key into every validation-error body — regression from this story's `...extra` spread. **Fixed:** `delete extra['error']` + a filter spec test for the ValidationPipe shape. [src/common/filters/global-exception.filter.ts] (edge)
- [x] [Review][Patch] `validateStep` permitted `on_my_way` from an unknown/corrupt `current_step` (`indexOf → -1`, same as the `null` fresh-job case). **Fixed:** `if (currentStep !== null && curIdx === -1) return false;` + two truth-table cases. [src/jobs/workflow.service.ts] (blind+edge)
- [x] [Review][Patch] Idempotency interceptor swallowed a real lookup DB error with no log, and the fire-and-forget insert had no `.catch()`. **Fixed:** log the lookup `error` (then fail open); wrap the insert in `Promise.resolve(...).catch(...)` + a fail-open unit test. [src/common/interceptors/idempotency.interceptor.ts] (blind+edge+auditor)
- [x] [Review][Defer] Live-RPC/interceptor behaviors (RPC atomicity, `PT409` terminal + compare-and-set, `UNIQUE(key,tenant_id)` `23505`) and several happy/edge e2e paths (PT409 409, mid-chain steps, valid photo-skip, cache-miss insert-on-success, no-key replay→422) are verified only by manual MCP + mocks — already tracked as W2. — deferred, pre-existing (CI-no-DB gap)
- [x] [Review][Defer] Read-through dedup is best-effort: the insert is not awaited, so a sequential retry arriving before the async insert lands re-runs the RPC; double-apply is backstopped only by the workflow RPC compare-and-set, not for reused endpoints — already tracked as W3. — deferred, pre-existing
- [x] [Review][Defer] `PT409` conflation — terminal-status (permanent) and compare-and-set conflict (transient/retryable) both map to `409 JOB_NOT_MODIFIABLE`; client cannot tell "retry me" from "give up". Accepted per AC#18; revisit if clients need a retry signal. — deferred
- [x] [Review][Defer] Advanceable-status whitelist is duplicated — service (`JobStatus.SCHEDULED`/`IN_PROGRESS`) and RPC SQL (`IN ('scheduled','in_progress')`) must be edited in lockstep. — deferred
- [x] [Review][Defer] `message` cast `r['message'] as string` emits an array verbatim for `ValidationPipe` errors (message is `string[]`) — pre-existing, predates this story's filter change. — deferred, pre-existing

## Dev Notes

### This story ADDS one endpoint, two migrations, one service, one interceptor — plus a tiny shared-filter tweak

`jobs`, `activity_logs`, `users`, `customers`, `tenants` all exist and are RLS-enabled. `JobsModule`/`JobsService`/`JobsController`, `JobResponse`/`JobRow`/`toResponse`, `RequestUser`, `RolesGuard`/`JwtAuthGuard`, and the `ErrorCode.INVALID_WORKFLOW_STEP` + `JOB_NOT_MODIFIABLE` enum members **already exist**. This story ADDS: `idempotency_log` table + `advance_workflow_step` RPC (two migrations), `WorkflowStep` enum, `AdvanceWorkflowDto`, `WorkflowService`, `IdempotencyInterceptor`, a `@Post(':id/workflow')` route, and a small additive `GlobalExceptionFilter` passthrough. **No change to the `jobs` schema, no RLS policy change to existing tables, no `app.module.ts` change.** [Source: src/jobs/jobs.service.ts; src/common/enums/error-code.enum.ts:11-12; supabase/migrations/20260621000002_create_jobs.sql]

### The 6-step state machine (the heart of this story)

Canonical order: `on_my_way → arrived → in_progress → photos_uploaded → signature_captured → completed`. A freshly-created job has `current_step = null` (the column is nullable with **no default** — verified in the `jobs` migration), so the **first** valid advance is `on_my_way` (from `null`). Note `in_progress` is **both** a workflow step name AND a job status — do not conflate them:
- `current_step` is the *step* string (`on_my_way`, `arrived`, `in_progress`, …).
- `status` is the *lifecycle* (`scheduled`, `in_progress`, `completed`, `cancelled`).
- Submitting the `on_my_way` **step** transitions `status` `scheduled → in_progress`. Submitting the `completed` **step** transitions `status` → `completed`. All other steps leave `status` unchanged at `in_progress`.

Transition rule: the requested step must be the **immediate successor** of `current_step`, with **one** exception — when `require_completion_photo = false`, `photos_uploaded` may be skipped (i.e. `signature_captured` is allowed directly after `in_progress`). When `require_completion_photo = true`, the skip is rejected (422). Out-of-order, backward, or repeated steps → 422 `INVALID_WORKFLOW_STEP` with the current `currentStep` in the body. [Source: epics.md#Story 3.5 AC lines 597-627; epics.md#FR-10 line 37; supabase/migrations/20260621000002_create_jobs.sql:19 `current_step TEXT` nullable, line 18 `status` CHECK]

### AR-10 atomicity — `advance_workflow_step` mirrors `create_job_with_log`/`update_job_with_log`

The `current_step`/`status` UPDATE and the `activity_logs` INSERT MUST be **one** `supabase.rpc()` transaction — never two sequential `.from()` calls. This is the same precedent as Stories 3.1/3.4. Copy the migration header, `SECURITY DEFINER`, `SET search_path = public`, and `RETURNS SETOF jobs` shape verbatim from `20260621000004_rpc_update_job_with_log.sql`. **The architecture's RPC sketch (architecture.md:1104-1114) is illustrative and incomplete** — it omits `tenant_id`, the status transition, the `activity_logs.tenant_id` NOT-NULL column, and the TOCTOU compare-and-set. Implement the full version specified in Task 2. [Source: architecture.md:1087-1117 (AR-10); supabase/migrations/20260621000003_rpc_create_job_with_log.sql; ...000004_rpc_update_job_with_log.sql]

### CRITICAL: `updated_at` has NO trigger — the RPC must set it explicitly

`jobs.updated_at` is `TIMESTAMPTZ NOT NULL DEFAULT now()` but there is **no `BEFORE UPDATE` trigger**. Every `UPDATE jobs` in the RPC must include `updated_at = now()` or the timestamp goes stale. (Same gotcha that bit Story 3.4.) [Source: supabase/migrations/20260621000002_create_jobs.sql:25-27 — no trigger]

### CRITICAL: validation lives in the service, but the authoritative guards live in the RPC (TOCTOU)

The epic says `WorkflowService.validateStep()` enforces ordering (service layer) — do that for fast, friendly errors and to produce the `{ currentStep }` body. **But** a concurrent advance (two offline-sync replays, or two devices) could move `current_step` between the service's read and the RPC's write. So the RPC ALSO re-guards inside `SELECT … FOR UPDATE`: (1) terminal-status check, and (2) a **compare-and-set** `IF current_step IS DISTINCT FROM p_expected_current_step THEN RAISE PT409`. The service passes the `current_step` it read as `p_expected_current_step`; if the row moved, the stale write loses → 409. This guarantees a step is never double-applied and the log never duplicates. The `FOR UPDATE` lock also serializes concurrent advances on the same job. [Source: 3-4 Dev Notes "scheduled-only guard inside the RPC"; architecture.md AR-10 (PostgREST runs each RPC in one transaction)]

### Mapping the RPC raise to HTTP 409 — same PostgREST contract as Story 3.4

The RPC raises `ERRCODE = 'PT409'` for a terminal status OR a compare-and-set conflict. PostgREST surfaces a `PTxyz` SQLSTATE such that the error body's `code` field carries the SQLSTATE → supabase-js exposes `error.code === 'PT409'` (Context7-verified contract, proven live for `update_job_with_log` in Story 3.4). The service matches on `error.code === 'PT409'` → **409 `JOB_NOT_MODIFIABLE`**, everything else → 500. **Re-confirm the exact code via the MCP task** before wiring tests (don't assume — but it is the identical contract already proven). [Source: 3-4 Dev Agent Record "PostgREST contract (Context7-verified)"; src/jobs/jobs.service.ts:414-452 (`update_job_with_log` PT409 mapping precedent)]

### Idempotency: an INTERCEPTOR, not a Guard (the architecture's "IdempotencyGuard" name is superseded)

The architecture/epic call it `IdempotencyGuard`, but a **NestJS Guard cannot do what idempotency requires** — a guard's `canActivate` may only return `boolean | Promise<boolean> | Observable<boolean>`; returning `false` makes the framework auto-throw `ForbiddenException` (403). A guard can **only allow/deny or throw** — it **cannot emit a cached 200 response body** (verified against NestJS docs `content/guards.md`). The correct NestJS primitive is an **Interceptor**: the documented cache-interceptor "Stream overriding" pattern returns `of(cachedBody)` to short-circuit the handler (the handler — and thus the RPC — never runs) and persists the response after success via `.pipe(tap(...))` (verified against `content/interceptors.md`). So implement `IdempotencyInterceptor` applied via `@UseInterceptors(IdempotencyInterceptor)`; functionally identical to the spec's intent, just the right tool. **Both behaviors doc-confirmed via Context7 `/nestjs/docs.nestjs.com` (guards return boolean-only; interceptors do stream overriding with `of()`/`tap()`).** [Source: epics.md#Story 3.5 line 626; architecture.md:1121-1129; NestJS docs guards + interceptors (Context7-verified)]

Interceptor specifics:
- **Header is lower-cased by Fastify** → read `req.headers['x-idempotency-key']`.
- **Scope by `(key, tenant_id)`** (AR-9) using `createAdmin()` (bypasses RLS; app-layer tenant scoping is the gate — consistent with the whole codebase). `req.user` is already populated by the global `JwtAuthGuard`, which runs **before** interceptors.
- **24h window enforced in the lookup** (`created_at > now() - 24h`) since the `pg_cron` cleanup is Story 4.2 — without the filter, an un-pruned key would replay forever.
- **`tap` caches only successes** — a thrown error never emits through `tap`, so a failed advance is retryable.
- **Swallow `23505`** on insert (a concurrent duplicate already cached it); never let the cache write fail the request.
- **Malformed key → 422** (reject non-UUID-v4 to keep the store clean) — a deliberate decision; document it.

### `GlobalExceptionFilter` must forward the `currentStep` extra field (the one shared-infra change)

The filter today sends only `{ statusCode, error_code, message, stack? }` and **drops** any other keys on the thrown exception's response object (verified at src/common/filters/global-exception.filter.ts:42-47). NestJS explicitly supports passing an **object** as the `HttpException` response argument to "customize the entire JSON response body" with arbitrary fields, and a custom `ExceptionFilter` may shape the JSON however it likes (the docs' own example adds `timestamp`/`path`) — so a top-level `currentStep` is idiomatic and doc-backed (verified via Context7 `content/exception-filters.md`). AC#5/#6/#7 need `currentStep` in the 422 body, so the service throws `HttpException({ error_code, message, currentStep }, 422)` and the filter must spread the extra keys into the payload (top-level, matching the epic AC's literal `{ "currentStep": "on_my_way" }`). Make it **additive and backward-compatible** (existing exceptions carry no extra keys → output unchanged) and add a filter-spec test. This is the only file outside the jobs module + common/interceptors that this story changes — keep the patch surgical. [Source: src/common/filters/global-exception.filter.ts:24-47; epics.md#Story 3.5 AC line 613 `{ "currentStep": "on_my_way" }`; NestJS docs exception-filters (Context7-verified)]

### Technician assignee-only access (derived security requirement)

The epic AC for 3.5 tests an Owner → 403 but does not explicitly test a non-assignee technician. However FR-10 ("Technician-only") + the established `getJobDetail` rule (a technician may only access jobs assigned to them) make assignee-only access a **correctness requirement**: a technician must not advance a colleague's job. Implement it exactly like `getJobDetail` (jobs.service.ts:584-591) — resolve **404 first** (not-found/cross-tenant), **then 403** (in-tenant but not the assignee). Both the owner case (RolesGuard, before the service) and the non-assignee case return `403 FORBIDDEN`. [Source: epics.md#FR-10 line 37; epics.md#FR-8 line 33; src/jobs/jobs.service.ts:584-591]

### Reuse `toResponse` — do not re-implement the snake→camel mapping

`JobsService.toResponse(row: JobRow): JobResponse` (jobs.service.ts:717-737) already maps every column. `WorkflowService` returns the same `JobResponse` shape, so reuse it: make `toResponse` `public` on `JobsService` and inject `JobsService` into `WorkflowService` (both live in `JobsModule`). `JobRow`/`JobResponse`/`JobResponse` are already `export`ed from jobs.service.ts. Re-deriving the mapping risks drift (e.g. forgetting `requireCompletionPhoto`). [Source: src/jobs/jobs.service.ts:26-44 (`JobResponse`), 92-110 (`JobRow`), 717-737 (`toResponse`)]

### Status-code map (consistent with the jobs module)

- `ParseUUIDPipe` malformed `:id` → **400** (AC#13). [src/jobs/jobs.controller.ts]
- Business `BadRequestException` (no-tenant) → **400 `VALIDATION_ERROR`** (AC#14).
- DTO validation failure (missing/invalid `step`) → **422** via global `ValidationPipe` (`errorHttpStatusCode: 422`) (AC#16). Invalid step *transition* → **422 `INVALID_WORKFLOW_STEP`** thrown in the service (AC#5, #6, #7).
- Missing/invalid JWT → **401 `UNAUTHORIZED`** (global `JwtAuthGuard`) (AC#15).
- Owner on technician-only route → **403 `FORBIDDEN`** (`RolesGuard`) (AC#10); non-assignee technician → **403** (service gate) (AC#11).
- Not-found / cross-tenant job → **404 `RESOURCE_NOT_FOUND`** (AC#12).
- Terminal-status job / concurrent-advance conflict → **409 `JOB_NOT_MODIFIABLE`** (AC#17, #18).
- Idempotency hit → **200** with the cached body (AC#8). [Source: src/common/enums/error-code.enum.ts; src/common/filters/global-exception.filter.ts:50-68]

### Scope boundaries

- **Advancing ONE job's workflow step only.** No attachment upload (Story 3.6 — the `photos_uploaded` *auto*-advance from a photo webhook is 3.6's job; this story only handles an *explicit* `photos_uploaded` step submission).
- The `idempotency_log` table + `IdempotencyInterceptor` are **built here** and applied to **this** endpoint only. Story 3.6 reuses the interceptor on the attachments endpoint; Story 4.2 adds the `pg_cron` 24h cleanup and broadens guard coverage. Do NOT build the cron here.
- No conflict-tolerant offline replay semantics (out-of-order replays returning a non-422 reconciliation) — that is Story 4.3. Here, an out-of-order step is a plain 422.
- Technician-only route; owner gets 403 (RolesGuard).
- Two new migrations (`idempotency_log`, `advance_workflow_step`); no change to existing table schemas or RLS policies.

### Testing standards

- **Unit** (`src/jobs/workflow.service.spec.ts`, `src/common/interceptors/idempotency.interceptor.spec.ts`, extend `global-exception.filter.spec.ts`): mock the `createAdmin()` return (`from`/`rpc`); inject a mocked `JobsService` (`{ toResponse: jest.fn(...) }`) into `WorkflowService`. Assert: `validateStep` truth table, the rpc param mapping (`p_step`, `p_new_status`, `p_expected_current_step`), every status branch, and that the rpc is **not** called on a validation/ownership/terminal failure. For the interceptor, drive `CallHandler` with `{ handle: () => of(payload) }` and assert short-circuit vs passthrough vs insert.
- **E2E** (`test/jobs.e2e-spec.ts`): extend `mockAdmin` to dispatch `jobs` fetch + `idempotency_log` (default miss) + `rpc('advance_workflow_step')`; add `assignedTechJwt()` (`sub === TECH_ID`). Assert the 200 happy path body, 422 transition + `currentStep`, 403 owner & non-assignee, 404 missing, 400 malformed/no-tenant, 401 no-auth, 422 bad enum, 409 terminal.
- **Live MCP** (Task 10, project `pnlvreaijzslfymlnoti`): the only place the transaction atomicity, the `step_*` log trail, the `PT409` raise, the compare-and-set, and the `idempotency_log` `UNIQUE` are proven against the real DB — the unit/e2e mocks cannot. Record the confirmed `PT409` code; clean up all seed rows.
- **Lint baseline (accepted, do not fight):** spec/e2e `@typescript-eslint/unbound-method` + `no-unsafe-*` on `JSON.parse(response.body)`; the `admin.rpc(...)` destructure carries the accepted `no-unsafe-assignment` baseline (same as `createJob`/`updateJob`/`auth.service.ts:268`). Run `bunx eslint --fix` on **touched files only** — never `bun run lint` (whole-repo reformat trap from 3.4).
- No real-DB integration test in CI (CI has no DB — AR-20/J1/E2 infra gap). All app logic is unit-testable with mocks; the live RPC/interceptor check is a manual MCP gate during dev.

### Project Structure Notes

- **New:** `supabase/migrations/20260621000005_create_idempotency_log.sql`, `supabase/migrations/20260621000006_rpc_advance_workflow_step.sql`, `src/jobs/enums/workflow-step.enum.ts`, `src/jobs/dto/advance-workflow.dto.ts`, `src/jobs/workflow.service.ts`, `src/common/interceptors/idempotency.interceptor.ts`, `src/jobs/workflow.service.spec.ts`, `src/common/interceptors/idempotency.interceptor.spec.ts`.
- **Modified:** `src/jobs/jobs.controller.ts` (+`@Post(':id/workflow')`, inject `WorkflowService`, imports), `src/jobs/jobs.module.ts` (+`WorkflowService`, `IdempotencyInterceptor` providers), `src/jobs/jobs.service.ts` (`toResponse` → `public`), `src/common/filters/global-exception.filter.ts` (forward extra fields), `src/common/filters/global-exception.filter.spec.ts` (+passthrough test), `test/jobs.e2e-spec.ts` (+workflow describe), `_bmad-output/implementation-artifacts/deferred-work.md` (gaps).
- Naming: service `WorkflowService`; method `advanceWorkflowStep`; DTO `AdvanceWorkflowDto`; enum `WorkflowStep`; RPC `advance_workflow_step`; table `idempotency_log`; interceptor `IdempotencyInterceptor` (file `idempotency.interceptor.ts`).

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 3.5 (lines 591-627)] — the 6 epic ACs + implementation notes (idempotency_log columns, `advance_workflow_step` RPC, `IdempotencyGuard`, `validateStep` + photo-skip rule)
- [Source: _bmad-output/planning-artifacts/epics.md#FR-10 (line 37)] — step order, `on_my_way → in_progress` & `completed → completed` status transitions, `photos_uploaded` skippable, `idempotency_key`, each step appends a log
- [Source: _bmad-output/planning-artifacts/epics.md#FR-17 (line 51)] — 24h dedup window; keys in `idempotency_log`; expired via pg_cron (the cron itself is Story 4.2, line 747)
- [Source: _bmad-output/planning-artifacts/epics.md#FR-11 (line 39)] — activity-log event types; each workflow step appends an entry
- [Source: _bmad-output/planning-artifacts/architecture.md:1087-1117 (AR-10)] — Activity Log Atomicity; the (illustrative, incomplete) `advance_workflow_step` sketch to supersede
- [Source: _bmad-output/planning-artifacts/architecture.md:1121-1129] — Idempotency pattern (header, `(key, tenant_id)` scope, hit/miss behavior) — realized as an Interceptor
- [Source: _bmad-output/planning-artifacts/architecture.md:407-421 (3.3)] — `idempotency_log` table decision + rationale (24h window too long for in-memory cache)
- [Source: _bmad-output/planning-artifacts/architecture.md:1062-1064] — `INVALID_WORKFLOW_STEP`/`JOB_NOT_MODIFIABLE` in the Jobs error group
- [Source: supabase/migrations/20260621000002_create_jobs.sql:18-27, 41-50] — `jobs.status` CHECK, `current_step` nullable/no-default, `updated_at` has **no trigger**, `activity_logs` requires `tenant_id`+`actor_id` (NOT NULL), `activity_logs.metadata` JSONB
- [Source: supabase/migrations/20260621000004_rpc_update_job_with_log.sql] — RPC header/style, `SECURITY DEFINER`, `SET search_path = public`, `RETURNS SETOF jobs`, `FOR UPDATE` lock, `PT409` raise + tenant-scoped re-select to mirror
- [Source: src/jobs/jobs.service.ts:546-591] — `getJobDetail`: no-tenant 400, fetch + 500-before-404 guard order, technician ownership 403-after-404 gate to mirror
- [Source: src/jobs/jobs.service.ts:414-465] — `updateJob`: `PT409`→409 mapping, `RETURNS SETOF` empty→404, error-mapping order to mirror
- [Source: src/jobs/jobs.service.ts:717-737] — `toResponse` mapper to reuse (make public)
- [Source: src/jobs/jobs.controller.ts:91-116] — `@Patch(':id')` + `ParseUUIDPipe` + `@Roles` + `@ApiResponse` conventions to mirror for `@Post(':id/workflow')`
- [Source: src/common/interceptors/logging.interceptor.ts] — existing `NestInterceptor` file/Logger style to mirror for `IdempotencyInterceptor`
- [Source: src/common/filters/global-exception.filter.ts:24-47] — current error-shaping (drops extra keys) — patch to forward them
- [Source: src/common/guards/roles.guard.ts; src/common/guards/jwt-auth.guard.ts] — `@Roles`/`RolesGuard` (403) and global `JwtAuthGuard` (401) behavior
- [Source: test/jobs.e2e-spec.ts:21-134] — e2e bootstrap, `overrideProvider(SupabaseClientFactory)`, JWT minting, `mockAdmin`/`singleChain` patterns to extend
- [Source: NestJS docs — interceptors (Context7 `/nestjs/docs.nestjs.com`)] — Stream overriding via `of()` (short-circuit handler) + `tap()` (post-success side effect); the basis for `IdempotencyInterceptor`
- [Source: live Supabase schema, project pnlvreaijzslfymlnoti — list_migrations/execute_sql] — `idempotency_log` table and `advance_workflow_step` RPC confirmed **absent**; both built by this story
- [Source: 3-4-edit-reassign-cancel-job.md] — PostgREST `PTxyz`→`error.code` contract (Context7-verified), `FOR UPDATE` TOCTOU guard, `updated_at`-no-trigger, lint-scope-discipline learnings
- [Source: project-context.md] — Supabase MCP for all DB work; migrations committed AND applied via MCP; never two sequential calls for an atomic write (AR-10); never bypass RLS in tests (proper JWT)

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m]

### Debug Log References

- Build clean (`bun run build`). Full regression: unit **181/181** (13 suites), e2e **135 pass / 2 skip** (8 suites). No regressions.
- New unit suites: `workflow.service.spec.ts` (24 tests incl. the 12-case `validateStep` truth table), `idempotency.interceptor.spec.ts` (6 tests). Extended `global-exception.filter.spec.ts` (+2). `jobs.e2e-spec.ts` +14 `POST /api/v1/jobs/:id/workflow` tests.
- **Live verification (Supabase MCP, project `pnlvreaijzslfymlnoti`):** seeded a throwaway tenant/technician/customer/scheduled-job, walked the full chain via `advance_workflow_step` — activity trail came out exactly `step_on_my_way,step_arrived,step_in_progress,step_signature_captured,step_completed` (photos_uploaded validly skipped with `require_completion_photo=false`), final job `status=completed / current_step=completed`. A terminal-status advance raises **SQLSTATE `PT409`**; a stale `p_expected_current_step` (compare-and-set conflict) also raises **`PT409`** (both captured via `GET STACKED DIAGNOSTICS`). `idempotency_log` insert + 24h re-select works; a duplicate `(key, tenant_id)` raises **`23505`** (the code the interceptor swallows). Seed fully deleted — DB confirmed back to 0 tenants / 0 jobs / 0 customers / 0 activity_logs / 0 idempotency_log (4 pre-existing owners untouched).
- **PostgREST contract (Context7-verified, reused from 3.4):** a `PTxyz` SQLSTATE sets the error body's `code` field to the SQLSTATE → supabase-js surfaces `error.code === 'PT409'`. The service matches on that.
- **NestJS primitive choice (Context7-verified):** guards (`content/guards.md`) return boolean-only and auto-throw on `false` — cannot emit a cached body; interceptors (`content/interceptors.md`) do "Stream overriding" via `of()` + post-success `tap()`. Hence `IdempotencyInterceptor`, not a guard. Custom error fields via the `ExceptionFilter` are idiomatic (`content/exception-filters.md`).
- **Lint:** production files clean except the accepted `admin.rpc(...)` destructure `no-unsafe-assignment` baseline — now 3 occurrences (`createJob`, `updateJob`, new `advanceWorkflowStep` `workflow.service.ts:177`), identical to `auth.service.ts:268`. The 7 `no-unsafe-enum-comparison` errors in `global-exception.filter.ts` are pre-existing (the `httpStatusToErrorCode` switch, unchanged by this story). spec/e2e at the accepted `no-unsafe-*`/`unbound-method` baseline (`JSON.parse(response.body)`). Scoped `bunx eslint --fix` on touched files only (never `bun run lint`).

### Completion Notes List

- Added `POST /api/v1/jobs/:id/workflow` (technician-only, assignee-gated) to advance a job through the 6 ordered steps `on_my_way → arrived → in_progress → photos_uploaded → signature_captured → completed`. Backed by the new `advance_workflow_step` RPC (atomic `current_step`+`status` UPDATE + `step_*` activity-log insert, AR-10).
- **State machine** in `WorkflowService.validateStep()` — immediate-successor rule + `photos_uploaded` skip allowed only when `require_completion_photo = false`. `on_my_way` transitions `status scheduled→in_progress`; `completed` transitions `→completed`; other steps leave status unchanged.
- **TOCTOU-safe** RPC: `SELECT … FOR UPDATE` re-guards terminal status (→`PT409`) and does a **compare-and-set** on `p_expected_current_step` (concurrent advance → `PT409`). `updated_at = now()` set explicitly (no trigger). Both `PT409` cases map to **409 `JOB_NOT_MODIFIABLE`**.
- **Idempotency** as an `IdempotencyInterceptor` (not a guard): `X-Idempotency-Key` (UUID v4) scoped by `(key, tenant_id)`, 24h lookup window; cache hit replays the stored body via `of()` (handler/RPC never run), miss persists the success via `tap()`, `23505` swallowed, malformed key → 422. New `idempotency_log` table (`pg_cron` cleanup deferred to Story 4.2 — W1).
- **`GlobalExceptionFilter`** now forwards extra structured fields (additive, backward-compatible) so the 422 `INVALID_WORKFLOW_STEP` body carries `currentStep`.
- Status map: no-tenant→400; bad/missing `step`→422 (DTO); out-of-order/illegal-skip→422 `INVALID_WORKFLOW_STEP` (+`currentStep`); owner & non-assignee→403; missing/cross-tenant→404; malformed id→400; terminal/concurrent→409; idempotent replay→200 cached.
- `toResponse` made public on `JobsService` and reused (no mapping drift). Deferred: W1 (pg_cron), W2 (live-RPC-only verification gap), W3 (read-through idempotency concurrency window), W4 (read-then-RPC is RPC-re-guarded, documented as non-bug).

### File List

- `supabase/migrations/20260621000005_create_idempotency_log.sql` (new — idempotency_log table + RLS; **scope column + UNIQUE(key,tenant_id,scope)** added in code review; applied via Supabase MCP)
- `supabase/migrations/20260621000006_rpc_advance_workflow_step.sql` (new — atomic step-advance RPC w/ TOCTOU compare-and-set; applied via Supabase MCP)
- `src/jobs/enums/workflow-step.enum.ts` (new — `WorkflowStep` enum)
- `src/jobs/dto/advance-workflow.dto.ts` (new — `AdvanceWorkflowDto`)
- `src/jobs/workflow.service.ts` (new — `WorkflowService`: `validateStep` + `advanceWorkflowStep`)
- `src/common/interceptors/idempotency.interceptor.ts` (new — `IdempotencyInterceptor`)
- `src/jobs/jobs.service.ts` (modified — `toResponse` made public; `JobRow` exported)
- `src/jobs/jobs.controller.ts` (modified — `@Post(':id/workflow')` handler; inject `WorkflowService`; imports)
- `src/jobs/jobs.module.ts` (modified — register `WorkflowService` + `IdempotencyInterceptor`)
- `src/common/filters/global-exception.filter.ts` (modified — forward extra error fields, e.g. `currentStep`)
- `src/jobs/workflow.service.spec.ts` (new — 24 unit tests)
- `src/common/interceptors/idempotency.interceptor.spec.ts` (new — 6 unit tests)
- `src/common/filters/global-exception.filter.spec.ts` (modified — +2 passthrough tests)
- `test/jobs.e2e-spec.ts` (modified — +14 `POST /api/v1/jobs/:id/workflow` e2e tests; extended `mockAdmin`)
- `_bmad-output/implementation-artifacts/deferred-work.md` (modified — W1–W4)

### Change Log

| Date       | Change                                  |
|------------|-----------------------------------------|
| 2026-06-21 | Story 3.5 created (ready-for-dev) — comprehensive context engine analysis. Key decisions: new `advance_workflow_step` RPC (atomic `current_step`+`status` UPDATE + `step_*` log, AR-10) supersedes the incomplete architecture sketch (adds tenant scoping, status transition, `activity_logs.tenant_id`, and a `SELECT … FOR UPDATE` **compare-and-set** on `p_expected_current_step` for TOCTOU safety; `updated_at = now()` explicit — no trigger); the 6-step state machine validated in `WorkflowService.validateStep()` (immediate-successor rule + `photos_uploaded` skip only when `require_completion_photo = false`); idempotency realized as an **`IdempotencyInterceptor`** (NOT a Guard — a guard cannot emit a cached 200 body; Context7-verified NestJS `of()`/`tap()` pattern), scoping by `(key, tenant_id)` with a 24h lookup window (pg_cron cleanup deferred to Story 4.2); `GlobalExceptionFilter` patched (additive) to forward the `currentStep` extra field for the 422 body; assignee-only technician access (404-before-403, mirrors `getJobDetail`); `PT409`→409 mapping reuses the proven `update_job_with_log` PostgREST contract; `toResponse` reused (made public). Two new migrations; no existing-schema/RLS change. |
| 2026-06-21 | Code review (adversarial, 3 layers): 1 decision + 3 patches applied, 5 deferred, 7 dismissed. **D1** — idempotency key now scoped `(key, tenant_id, scope)` where `scope="METHOD:/concrete/path"` (IETF/Stripe-aligned), closing the cross-resource wrong-body replay; migration `…000005` amended (empty table, re-applied via MCP), verified live. **P1** — `GlobalExceptionFilter` strips Nest's default `error` label (was leaking `'Unprocessable Entity'` into every validation body). **P2** — `validateStep` rejects a corrupt non-null `current_step` instead of treating it as a fresh job. **P3** — interceptor logs lookup errors (fail open) and `.catch()`es the fire-and-forget insert. +4 unit tests. Unit 185/185, e2e 135 pass/2 skip, build clean, prod lint at accepted baseline. Status → done. |
| 2026-06-21 | Story 3.5 implemented: `POST /api/v1/jobs/:id/workflow` (technician-only, assignee-gated) advancing the 6-step workflow via the new `advance_workflow_step` RPC. TOCTOU-safe `FOR UPDATE` terminal-status + compare-and-set guards (both → `PT409` → 409 `JOB_NOT_MODIFIABLE`); explicit `updated_at=now()`. `WorkflowService.validateStep` enforces step ordering + the `require_completion_photo=false` photos skip. Idempotency via `IdempotencyInterceptor` (`X-Idempotency-Key` UUID v4, `(key,tenant_id)` scope, 24h window, `of()` replay / `tap()` persist, `23505` swallow, malformed→422) on the new `idempotency_log` table. `GlobalExceptionFilter` forwards `currentStep` on the 422 INVALID_WORKFLOW_STEP body. +30 unit (24 workflow + 6 interceptor) / +2 filter / +14 e2e. Unit 181/181, e2e 135 pass/2 skip, build clean, prod lint at accepted baseline. Both migrations written to `supabase/migrations/` AND applied via MCP; full step chain + PT409 (terminal & compare-and-set) + idempotency_log UNIQUE verified live then seed cleaned up. W1–W4 deferred. Status → review. |
