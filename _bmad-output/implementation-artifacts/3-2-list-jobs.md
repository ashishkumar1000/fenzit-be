---
baseline_commit: ccedc27875bfe2f262ded87cdb604d9cc85469ed
---

# Story 3.2: List Jobs

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an owner or technician,
I want to list jobs filtered by date, status, and technician,
so that I can see all relevant jobs for a given day at a glance.

## Acceptance Criteria

1. **Given** an authenticated Owner with no filters, **when** `GET /api/v1/jobs` is called, **then** HTTP 200 with a cursor-paginated payload `{ data, nextCursor, hasMore }` (page size 50) containing only this Tenant's jobs whose `scheduled_start` falls within **today in IST (UTC+5:30)**. Each `data` entry is the full job object (same shape `POST /api/v1/jobs` returns).

2. **Given** `?status=scheduled&status=in_progress` (repeatable param), **when** `GET /api/v1/jobs` is called, **then** only jobs whose `status` is `scheduled` **or** `in_progress` are returned.

3. **Given** `?date=2026-06-20`, **when** `GET /api/v1/jobs` is called, **then** only jobs whose `scheduled_start` falls within **June 20 2026 in IST** are returned (overrides the default "today").

4. **Given** `?technicianId={uuid}` with an **Owner** JWT, **when** `GET /api/v1/jobs` is called, **then** only jobs assigned to that technician are returned.

5. **Given** an authenticated **Technician** calling with `?technicianId={otherTechId}`, **when** `GET /api/v1/jobs` is called, **then** only the **authenticated technician's own** jobs are returned (the `technicianId` query param is silently ignored — service forces `technician_id = user.userId`).

6. **Given** no jobs match the applied filters, **when** `GET /api/v1/jobs` is called, **then** HTTP 200 with `{ data: [], nextCursor: null, hasMore: false }` (**not** 404).

7. **Given** a `cursor` from a previous paginated response, **when** `GET /api/v1/jobs?cursor={nextCursor}` is called, **then** the next page is returned in correct keyset order with **no duplicates or gaps** (sort `created_at DESC, id DESC` per AR cursor convention).

8. **Given** a malformed `cursor` (not valid base64url JSON with `id`+`createdAt`), **when** `GET /api/v1/jobs?cursor=garbage` is called, **then** HTTP 400 with `error_code: "VALIDATION_ERROR"` (via the existing `decodeCursor` util).

9. **Given** a malformed `technicianId` (not a UUID) **or** a malformed `date` (not `YYYY-MM-DD`), **when** `GET /api/v1/jobs` is called, **then** HTTP 422 with `error_code: "VALIDATION_ERROR"`.

10. **Given** no `Authorization` header, **when** `GET /api/v1/jobs` is called, **then** HTTP 401 with `error_code: "UNAUTHORIZED"`.

11. **Given** an Owner JWT whose `tenantId` is `null` (company not yet set up), **when** `GET /api/v1/jobs` is called, **then** HTTP 400 with `error_code: "VALIDATION_ERROR"` — consistent with Story 2.2 (AC#7) and Story 3.1 (AC#9).

## Tasks / Subtasks

- [x] **Task 1 — `ListJobsQueryDto`** (AC: #2, #3, #4, #8, #9)
  - [x] New file `src/jobs/dto/list-jobs-query.dto.ts`.
  - [x] `date?` — `@IsOptional()` `@Transform(trim)` `@Matches(/^\d{4}-\d{2}-\d{2}$/)` (calendar date only; a full ISO datetime is rejected → AC#9). `@ApiPropertyOptional({ example: '2026-06-20' })`.
  - [x] `status?` — repeatable enum. `@Transform(toArray)` coerces single value → array (Fastify passes one value as a string, multiple as an array), then `@IsOptional()` `@IsArray()` `@IsEnum(JobStatus, { each: true })`. `@ApiPropertyOptional({ enum: JobStatus, isArray: true })`.
  - [x] `technicianId?` — `@IsOptional()` `@IsUUID()` (default version — **never `'4'`**). `@ApiPropertyOptional({ format: 'uuid' })`.
  - [x] `cursor?` — `@IsOptional()` `@Transform(trim)` `@IsString()` `@MaxLength(512)`. `@ApiPropertyOptional()`.
  - [x] No `limit`/page-size param — page size fixed at 50.
- [x] **Task 2 — `listJobs` service method** (AC: #1, #3, #5, #6, #7, #11)
  - [x] Added `listJobs(user, query): Promise<PaginatedResponse<JobResponse>>` to `src/jobs/jobs.service.ts`. Reuses existing `JobResponse`/`JobRow`/`toResponse`.
  - [x] Added module-level `const PAGE_SIZE = 50;`.
  - [x] `if (!user.tenantId)` → `BadRequestException` `VALIDATION_ERROR` (AC#11).
  - [x] IST day window via `getIstDayRange`; `.gte('scheduled_start', range.start.toISOString()).lt('scheduled_start', range.end.toISOString())`.
  - [x] Keyset query: `from('jobs').select(<17-col literal>).eq('tenant_id', …)`, date-range, optional `.in('status', …)`, technician scoping, optional cursor `.or()`, `.order('created_at',{ascending:false}).order('id',{ascending:false}).limit(PAGE_SIZE + 1)`. **Select must be a single string literal** (concatenation collapses the postgrest-js literal type → `GenericStringError[]`).
  - [x] Cursor `.or()` — identical keyset shape to `listCustomers`; `decodeCursor` throws 400 on malformed.
  - [x] `error` → `InternalServerErrorException` `INTERNAL_SERVER_ERROR`.
  - [x] `hasMore`/`pageRows`/`nextCursor` derivation via `encodeCursor(last.id, last.created_at)`.
  - [x] Returns `new PaginatedResponse(pageRows.map((r) => this.toResponse(r)), nextCursor)`.
- [x] **Task 3 — role-scoped technician filter** (AC: #4, #5)
  - [x] `user.role === Role.TECHNICIAN` → force `.eq('technician_id', user.userId)`, ignore `query.technicianId` (AC#5).
  - [x] Else (Owner) → apply `.eq('technician_id', query.technicianId)` when provided (AC#4); else no filter (AC#1).
- [x] **Task 4 — controller `GET` handler** (AC: #1, #10)
  - [x] Added `@Get()` with `@Roles(Role.OWNER, Role.TECHNICIAN)`, `@HttpCode(OK)`, `@ApiOperation`, `@ApiResponse` (200/400/401/422).
  - [x] `listJobs(@CurrentUser() user, @Query() query: ListJobsQueryDto)`.
  - [x] Imported `Get`, `Query`.
- [x] **Task 5 — Unit tests** (AC: #1, #3, #5, #6, #7, #11) — `src/jobs/jobs.service.spec.ts`
  - [x] Chainable list-builder mock (`select/eq/gte/lt/in/or/order` → builder, `.limit()` resolves); captures filter args.
  - [x] 9 tests: (a) owner no-filter maps to `JobResponse` + `.gte`/`.lt`; (b) `nextCursor` set at 51 rows, decodes to 50th row; (c) empty page; (d) technician self-scope, foreign id ignored; (e) owner technicianId; (f) status `.in()`; (g) `date=2026-06-20` IST boundaries; (h) no-tenant → 400; (i) DB error → 500.
- [x] **Task 6 — E2E tests** (AC: #1–#11) — `test/jobs.e2e-spec.ts`
  - [x] `GET /api/v1/jobs` describe block with a `.limit()`-terminal builder mock.
  - [x] 12 tests covering AC1–AC11 (list+shape, status repeatable, date, owner technicianId, technician self-scope, empty array, valid cursor, malformed cursor 400, malformed technicianId 422, malformed date 422, 401, no-tenant 400).
- [x] **Task 7 — Verify** (AC: all)
  - [x] `bun run build` clean.
  - [x] Full regression: unit **120/120**, e2e **97 pass / 2 skip** — no regressions.
  - [x] `bunx eslint` — production DTO/controller clean; `jobs.service.ts` carries only the pre-existing accepted `no-unsafe-assignment` baseline (createJob RPC destructure, matches `auth.service.ts:268`); spec/e2e carry only accepted `no-unsafe-*`/`unbound-method` baseline.
  - [x] No migration / schema / RLS change. Live-schema read-only sanity query (17 cols + IST range + `status IN` + keyset order) ran clean via Supabase MCP.

### Review Findings (code-review 2026-06-21)

- [x] [Review][Patch] **HIGH — `date` accepts impossible-but-well-formed values → 500 crash / silent wrong-day** [src/jobs/dto/list-jobs-query.dto.ts:24, src/jobs/jobs.service.ts:239] — `@Matches(/^\d{4}-\d{2}-\d{2}$/)` validates shape only. `?date=2026-13-01` (or `2026-00-00`) → `new Date('2026-13-01T06:30:00.000Z')` is `Invalid Date` → `getIstDayRange` yields NaN bounds → `range.start.toISOString()` throws a raw `RangeError` → GlobalExceptionFilter `else` branch → **500 INTERNAL_SERVER_ERROR** (should be 422). Separately, `?date=2026-02-30` / `2026-04-31` roll over (→ Mar 2 / May 1) and **silently return the wrong day's jobs** with a 200. Fix: validate a real calendar date (custom validator, or a service guard that throws 422 when `Number.isNaN(range.start.getTime())`), and add unit + e2e coverage for both the impossible-month (422) and rollover-date cases. Sources: blind + edge (empirically verified).
- [x] [Review][Patch] **MED — keyset sort order and cursor tie-breaker are never asserted (vacuous test for AC#7)** [src/jobs/jobs.service.spec.ts, test/jobs.e2e-spec.ts] — `.order()` is a chainable stub that no test inspects, and the cursor test only asserts `.or()` was called with a string *containing* `created_at.lt.<ts>`. A regression that flipped `ascending:false`→`true`, dropped an `.order()`, or removed the `and(created_at.eq.<ts>,id.lt.<id>)` tie-breaker would still pass green — yet those are exactly the properties that make pagination ordered + gapless. Fix: assert both `.order('created_at',{ascending:false})` and `.order('id',{ascending:false})`, and assert the full keyset `.or()` predicate string (including the `and(...)` tie-break). Sources: blind + edge + auditor.
- [x] [Review][Patch] **MED — no exactly-50-row boundary test (off-by-one trap)** [src/jobs/jobs.service.spec.ts] — `hasMore`/slice is tested at 51 rows and 0 rows, but not at exactly `PAGE_SIZE` (50), the boundary where `hasMore` must be `false` and `nextCursor` must be `null`. Add a 50-row unit test. Source: blind.
- [x] [Review][Patch] **LOW — full `JobResponse` shape not asserted on the list path (AC#1)** [src/jobs/jobs.service.spec.ts / test/jobs.e2e-spec.ts] — list tests assert only `jobNumber`/`technicianId`; a camelCase mapping regression in `toResponse` on the list path (e.g. `scheduledStart`, `currentStep`, `requireCompletionPhoto`, `notesForTechnician`, `updatedAt`) would go undetected. Add one assertion of the complete mapped shape. Source: auditor.
- [x] [Review][Defer] **MED — sort/keyset not index-backed; NFR p95 < 300ms at risk** [supabase/migrations/20260621000002_create_jobs.sql:32] — deferred, needs a migration (out of this no-migration story). The only index is `idx_jobs_tenant_id_scheduled_start`, which supports the `scheduled_start` filter but NOT the `created_at DESC, id DESC` sort/keyset; Postgres sorts the day-window rows in memory each page. Day-window cardinality likely keeps this acceptable in Phase 1; consider a `(tenant_id, created_at DESC, id DESC)` index in a perf pass. Logged in deferred-work.md.

## Dev Notes

### This is a pure ADD to the existing jobs module — no migration

The `jobs` table, `JobsModule`, `JobsService`, `JobsController`, `JobResponse`/`JobRow`/`toResponse`, and all three enums already exist and are wired (Story 3.1, done). This story ADDS a `GET` list endpoint to the same controller/service. **No new migration, no schema change, no RLS change, no `app.module.ts` change.** [Source: src/jobs/jobs.service.ts, src/jobs/jobs.controller.ts, src/jobs/jobs.module.ts]

### Mirror Story 2.2 `listCustomers` almost exactly — it is the canonical list pattern

Story 2.2 established the **first and only** cursor-paginated list pattern (`GET /api/v1/customers`, done + reviewed). Stories 3.2/3.3/4.1 follow it. Copy its structure; only the table, filters, and item mapping change. [Source: src/customers/customers.service.ts:248-311]

Reuse, do **not** reinvent:
- `PaginatedResponse<T>` — `{ data, nextCursor, hasMore }`; `hasMore` derived from `nextCursor !== null`. [Source: src/common/dto/paginated-response.dto.ts]
- `encodeCursor(id, createdAt)` / `decodeCursor(cursor)` — base64url JSON `{ id, createdAt }`. `decodeCursor` already throws `BadRequestException` `VALIDATION_ERROR` on malformed input — satisfies **AC#8 for free** (just call it). It also hardened the `id`/`createdAt` fields against PostgREST filter-injection in the 2.2 review, so the cursor `.or()` interpolation is safe. [Source: src/common/utils/cursor.util.ts]
- `getIstDayRange(utcNow?)` — pure util returning `{ start: Date, end: Date }` (UTC instants bounding one IST calendar day). [Source: src/common/utils/ist-day-range.util.ts]
- `JobResponse` interface + `toResponse(row: JobRow)` mapper — already in `jobs.service.ts`. The list returns the **same** job shape as create. [Source: src/jobs/jobs.service.ts:19-57, 218-238]
- No-tenant guard + `createAdmin()` client — mirror `createJob` / `listCustomers`. [Source: src/jobs/jobs.service.ts:70-77]

### Sort order = `created_at DESC, id DESC` (NOT scheduled_start) — architecture mandate

AR cursor convention: *"Cursor encoding: base64(JSON.stringify({ id, createdAt })). Sort order: `created_at DESC, id DESC` (id is tie-breaker). Consistent across **all** list endpoints."* So even though jobs are **filtered** by `scheduled_start` (the day window), they are **sorted/paginated** by `created_at DESC, id DESC` — identical to `listCustomers`. This keeps the cursor util and keyset filter string reusable verbatim. Do not sort by `scheduled_start`. [Source: _bmad-output/planning-artifacts/architecture.md:1041]

### Query construction (verified pattern from 2.2)

```ts
const admin = this.supabaseClientFactory.createAdmin();
const range = /* IST day range — see below */;

let qb = admin
  .from('jobs')
  .select(
    'id, job_number, tenant_id, customer_id, technician_id, service_location, ' +
    'service_type, scheduled_start, scheduled_end, status, current_step, ' +
    'priority, require_completion_photo, description, notes_for_technician, ' +
    'created_at, updated_at',
  )
  .eq('tenant_id', user.tenantId)
  .gte('scheduled_start', range.start.toISOString())
  .lt('scheduled_start', range.end.toISOString());

if (query.status?.length) {
  qb = qb.in('status', query.status); // AC#2
}

// AC#4 / AC#5 — role-scoped technician filter
if (user.role === Role.TECHNICIAN) {
  qb = qb.eq('technician_id', user.userId);      // forced; query.technicianId ignored
} else if (query.technicianId) {
  qb = qb.eq('technician_id', query.technicianId);
}

if (query.cursor) {
  const c = decodeCursor(query.cursor); // throws 400 on malformed
  qb = qb.or(
    `created_at.lt.${c.createdAt},and(created_at.eq.${c.createdAt},id.lt.${c.id})`,
  );
}

const { data, error } = await qb
  .order('created_at', { ascending: false })
  .order('id', { ascending: false })
  .limit(PAGE_SIZE + 1);
```

**Verified facts (do not re-guess — confirmed during Story 2.2 against postgrest-js / PostgREST docs):**
- Each `.eq` / `.gte` / `.lt` / `.in` / `.or` appends a separate top-level query param; PostgREST **ANDs** all top-level params. So `tenant_id` scoping and the technician filter are never weakened by the cursor OR-group — tenant isolation holds. [Source: 2-2-list-search-customers.md#Dev Notes, postgrest-js semantics]
- The query builder is **awaited directly** (terminal `.limit()`), no `.single()` — we want an array. `data` may be `null`; coalesce to `[]`. [Source: src/customers/customers.service.ts:280-293]
- The cursor's `createdAt` field is a generic timestamp slot — here it carries each row's `created_at` value. The field name is historical (from 2.2); reuse it as-is.

### IST day range for the `date` param (AC#3) — reuse `getIstDayRange`, do not modify it

`getIstDayRange(utcNow)` returns the IST calendar day **containing** `utcNow`. To get the range for an explicit `date=YYYY-MM-DD`, pass an instant that is unambiguously inside that IST day — **noon IST** of that date:

```ts
import { getIstDayRange } from '../common/utils/ist-day-range.util';

const range = query.date
  ? getIstDayRange(new Date(`${query.date}T06:30:00.000Z`)) // 06:30Z = 12:00 IST on that date
  : getIstDayRange(); // defaults to new Date() → today in IST
```

`06:30:00Z` = 12:00 noon IST, comfortably away from both midnight boundaries, so DST-free IST always resolves to the intended calendar day. The `@Matches(/^\d{4}-\d{2}-\d{2}$/)` DTO guard guarantees `query.date` is a clean date before interpolation. Do **not** add a new util — the existing one + this noon-IST trick covers AC#1 (today) and AC#3 (explicit date). [Source: src/common/utils/ist-day-range.util.ts, src/common/utils/ist-day-range.util.spec.ts]

Note: app code may call `new Date()` / `Date.now()` freely — the no-`new Date()` rule applies only to BMAD **workflow scripts**, not application source.

### Both roles allowed (unlike POST) — `@Roles(Role.OWNER, Role.TECHNICIAN)`

`POST /api/v1/jobs` is owner-only. `GET /api/v1/jobs` allows **both** owner and technician (`RolesGuard.includes(user.role)` passes if the role is in the list). There is **no 403 case** in this story. A technician's results are narrowed in the service layer to their own jobs (AC#5), never via a 403. [Source: src/common/guards/roles.guard.ts, src/common/decorators/roles.decorator.ts]

### Repeatable `status` query param — coerce to array

Fastify/qs delivers a repeated query key as: a single string when given once (`?status=scheduled`), an array when given 2+ times (`?status=scheduled&status=in_progress`). Normalize in the DTO `@Transform` so the service always sees `string[] | undefined`:

```ts
@Transform(({ value }) =>
  value === undefined ? undefined : Array.isArray(value) ? value : [value],
)
@IsOptional()
@IsArray()
@IsEnum(JobStatus, { each: true })
status?: JobStatus[];
```

An invalid enum value in the array → 422 (handled by the global `ValidationPipe { errorHttpStatusCode: 422 }`). [Source: src/main.ts ValidationPipe config; pattern mirrors create-job DTO enum validation]

### Validation status-code map (already established, do not change)

- DTO/ValidationPipe failures (bad enum, bad UUID, bad date format, bad cursor type) → **422** `VALIDATION_ERROR` (pipe `errorHttpStatusCode: 422`).
- Business `BadRequestException` (no-tenant) → **400** `VALIDATION_ERROR`.
- Malformed cursor → **400** `VALIDATION_ERROR` (thrown inside `decodeCursor`, runs in the service after the pipe — so it is 400, not 422). This matches Story 2.2 AC#8 exactly. [Source: 2-2-list-search-customers.md#AC8, src/common/utils/cursor.util.ts]

### Scope boundaries

- **List only.** No job detail with technician/customer/activity-log/attachments — that is Story 3.3.
- No mutation, no new migration, no new module, no RLS change.
- Page size fixed at 50 — no client-controllable limit.
- The list returns job entities only (the `JobResponse` shape). Do **not** join customer/technician/activity rows (3.3 does that).
- `current_step` is `null` for all freshly-created jobs (advanced in Story 3.5) — just pass it through `toResponse`.

### Testing standards

- **Unit** (`src/jobs/jobs.service.spec.ts`): the existing file uses a `singleChain`-style mock for the create path (terminal `.single()`). The list path needs a **different** builder whose terminal is `.limit()` (awaited → `{ data, error }`) and whose intermediate methods (`select`, `eq`, `gte`, `lt`, `in`, `or`, `order`) all return the builder. Capture `.in`/`.eq`/`.or` args with `jest.fn()` to assert filter application. Mirror the `listCustomers` unit tests in `customers.service.spec.ts`.
- **E2E** (`test/jobs.e2e-spec.ts`): the existing `mockAdmin` helper builds POST-path chains terminating in `.single()` (customers/users) + `rpc`. Add a separate GET-path `from('jobs')` chain terminating in `.limit()`. Keep the existing `ownerJwt`/`techJwt` helpers and the `ValidationPipe { whitelist, transform, errorHttpStatusCode: 422 }` already configured in `beforeAll`.
- **Lint baseline (accepted, do not fight):** in spec/e2e files, `@typescript-eslint/unbound-method` on jest mocks and `no-unsafe-member-access` on `JSON.parse(response.body)` are accepted (match `customers.*.spec.ts`, `skills.*.spec.ts`). In `jobs.service.ts`, the `data as JobRow[]` cast carries the same accepted `no-unsafe-assignment` baseline as `auth.service.ts:268` / `listCustomers`. Production code should otherwise lint clean.
- No real-DB integration test is in scope (CI has no DB — same infra gap noted as AR-20 / J1 in deferred-work.md). The day-range/keyset logic is fully unit-testable with mocks.

### Project Structure Notes

- **New file:** `src/jobs/dto/list-jobs-query.dto.ts`.
- **Modified:** `src/jobs/jobs.service.ts` (+`listJobs`, +`PAGE_SIZE`, imports for `getIstDayRange`/`encodeCursor`/`decodeCursor`/`PaginatedResponse`/`Role`), `src/jobs/jobs.controller.ts` (+`@Get()` handler), `src/jobs/jobs.service.spec.ts` (+list unit tests), `test/jobs.e2e-spec.ts` (+GET describe block).
- **No** `app.module.ts` change (module registered in 3.1). **No** migration. **No** `jobs.module.ts` change.
- Naming: `ListJobsQueryDto` mirrors `ListCustomersQueryDto`. Service method `listJobs` mirrors `listCustomers`.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 3.2: List Jobs] — the 6 epic ACs + implementation notes
- [Source: _bmad-output/planning-artifacts/epics.md#FR-7] — list jobs intent, query params, owner-vs-technician visibility, page size 50
- [Source: _bmad-output/planning-artifacts/epics.md#NFR-3] — list endpoints p95 < 300ms (keyset + `idx_jobs_tenant_id_scheduled_start` index supports this)
- [Source: _bmad-output/planning-artifacts/architecture.md:1041] — cursor encoding + `created_at DESC, id DESC` sort, consistent across all list endpoints
- [Source: _bmad-output/planning-artifacts/architecture.md:743-744] — IST `date=today` filter via `ist-day-range.util.ts`, used in `jobs.service.ts` list query
- [Source: src/customers/customers.service.ts:248-311] — `listCustomers`, the canonical list pattern to mirror
- [Source: src/jobs/jobs.service.ts] — `JobResponse`/`JobRow`/`toResponse`, no-tenant guard, `createAdmin` (Story 3.1 patterns)
- [Source: src/common/utils/cursor.util.ts] — `encodeCursor`/`decodeCursor` + malformed-cursor 400 + injection hardening
- [Source: src/common/utils/ist-day-range.util.ts] — IST day window util
- [Source: src/common/dto/paginated-response.dto.ts] — `{ data, nextCursor, hasMore }` envelope
- [Source: 2-2-list-search-customers.md] — verified postgrest-js facts (chained filters AND, await `.limit()`, cursor reuse), lint baseline, test mock shapes
- [Source: supabase/migrations/20260621000002_create_jobs.sql] — `jobs` columns, status CHECK enum, `idx_jobs_tenant_id_scheduled_start`

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m]

### Debug Log References

- Unit: `jobs.service.spec.ts` 23/23 (+9 for `listJobs`). E2E: `jobs.e2e-spec.ts` 25/25 (+12 GET tests).
- Full regression: unit 120/120 (11 suites), e2e 97 pass + 2 skip (8 suites). No regressions.
- Build error caught + fixed: a concatenated/`const` select column string collapses postgrest-js's literal type to `GenericStringError[]` (TS2352 on the `as JobRow[]` cast). Fix: pass the 17-column select as a single inline string literal (same technique `listCustomers` uses).
- Lint autofix removed 10 unnecessary `as ListJobsQueryDto` casts in the unit spec (all DTO fields optional → object literals are assignable), which left the import unused — removed it.

### Completion Notes List

- Added `GET /api/v1/jobs` (owner **and** technician, cursor-paginated, page size 50) to the existing jobs module — **no new migration**.
- Filters: IST day window (`date`, default today), repeatable `status` (`.in()`), role-scoped `technicianId`. Technicians are forced to `technician_id = userId` and the `technicianId` query param is silently ignored for them (AC#5) — there is **no 403** in this story.
- **Sort/paginate by `created_at DESC, id DESC`** (AR cursor convention) while **filtering** by `scheduled_start` — keeps `encodeCursor`/`decodeCursor` and the keyset `.or()` string reusable verbatim from `listCustomers`.
- `date` param reuses `getIstDayRange` by anchoring on noon IST (`${date}T06:30:00.000Z`) — no new util added.
- Reused `PaginatedResponse`, `encodeCursor`/`decodeCursor` (malformed cursor → 400 for free), `getIstDayRange`, and the existing `JobResponse`/`JobRow`/`toResponse` — list returns the same job shape as create.
- 400-vs-422 split holds: DTO failures (bad enum/UUID/date format) → 422; no-tenant + malformed cursor → 400.
- Verified the live `jobs` schema accepts the exact list query (17 columns, IST range, `status IN`, keyset order) via a read-only Supabase MCP query.

### File List

- `src/jobs/dto/list-jobs-query.dto.ts` (new)
- `src/jobs/jobs.service.ts` (modified — `listJobs`, `PAGE_SIZE`, imports for `Role`/`PaginatedResponse`/cursor utils/`getIstDayRange`/`ListJobsQueryDto`)
- `src/jobs/jobs.controller.ts` (modified — `@Get()` handler, `Get`/`Query` imports)
- `src/jobs/jobs.service.spec.ts` (modified — +9 `listJobs` unit tests)
- `test/jobs.e2e-spec.ts` (modified — +12 `GET /api/v1/jobs` e2e tests)

### Change Log

| Date       | Change                                  |
|------------|-----------------------------------------|
| 2026-06-21 | Story 3.2 created (ready-for-dev) — comprehensive context engine analysis. |
| 2026-06-21 | Story 3.2 implemented: `GET /api/v1/jobs` (owner+technician, cursor-paginated, IST date / status / technician filters). +9 unit, +12 e2e. Unit 120/120, e2e 97 pass/2 skip, build clean, lint at accepted baseline. Status → review. |
| 2026-06-21 | Code review (3 adversarial layers): 4 patch, 1 defer, 8 dismissed. Fixes — HIGH: `date` now validated as a real calendar date (`IsCalendarDateConstraint`) so `2026-13-01` → 422 (was 500) and `2026-02-30` → 422 (was silent wrong-day); MED: assert keyset sort order + full cursor tie-break predicate, add exactly-50-row boundary test; LOW: assert full `JobResponse` shape. +1 unit, +2 e2e. Unit 121/121, e2e 99 pass/2 skip, build clean. Deferred: sort/keyset index (NFR perf) → deferred-work.md L1. Status → done. |
