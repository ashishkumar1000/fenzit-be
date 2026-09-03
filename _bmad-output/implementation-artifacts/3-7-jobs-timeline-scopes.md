# Story 3.7: Jobs Timeline Scopes

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an owner,
I want jobs grouped by where they sit on the timeline (today / upcoming / overdue / history),
so that past-dated and future jobs are never invisible and every dashboard number is actionable.

## Background (why this story exists)

Today `GET /jobs` only ever shows one IST day window (`jobs.service.ts:503-520`), while the
dashboard's `jobStatusCounts` counts all jobs ever. Net effect (verified against live data):
a tenant with 4 scheduled jobs shows "4" on the dashboard but only 1 job in the Jobs tab — the
other 3 sit on past dates and are unreachable from the UI. This story makes the backend model
the full job timeline instead of one day slice.

**Deliberate design decisions (do not "fix" these):**
- **No `overdue` DB status.** Overdue is derived (`scheduled_start` past + not finished). A
  stored status that flips by itself at midnight is a bug factory.
- **No auto-cancel/auto-complete of past jobs.** A missed booking is a business event the
  owner must act on (reschedule / complete late / cancel).
- **Breaking change is intentional.** App is pre-launch, no live users. We reshape the profile
  counts outright instead of additive-then-remove cruft. Deploy order: BE merges/deploys first,
  FE story (fenzo-app 1-5) lands immediately after. FE screens that read `jobStatusCounts`
  will type-error until the FE story ships — acceptable, state it in the handoff.
- **Scope buckets are mutually exclusive by day.** `upcoming` starts at the start of
  *tomorrow* IST, so a job scheduled today appears ONLY in Today (never double-counted in the
  Upcoming tile/list).

## Acceptance Criteria

1. **Given** the migration is applied, **when** the `jobs` table is inspected, **then** it has a
   nullable `completed_at TIMESTAMPTZ` column, every existing row with `status='completed'` has
   `completed_at` backfilled from its `updated_at`, and all other rows have `completed_at IS NULL`.

2. **Given** the `advance_workflow_step` RPC is called with `p_new_status='completed'`, **when**
   the job UPDATE runs, **then** `completed_at` is set to `now()` on that same UPDATE; given any
   other step advance (e.g. `on_my_way` → `in_progress`), **then** `completed_at` is left
   untouched. Existing PT409 guards and the activity_logs INSERT are unchanged.

3. **Given** `GET /api/v1/jobs` with **no** `scope` param, **when** called, **then** filters,
   sort, cursor and error behaviour are identical to Story 3.2 (IST day window,
   `created_at DESC, id DESC` sort, `jobs-list` cursor scope) — the ONLY shape change is each
   row additionally carrying `completedAt` (per AC#10). Existing `date`, `status`,
   `technicianId`, `cursor`, `limit` params all keep working — zero behavioural regression for
   the current FE.

4. **Given** `?scope=upcoming`, **when** called, **then** only this tenant's jobs with
   `scheduled_start >= start of TOMORROW IST` **and** `status='scheduled'` are returned, sorted
   `scheduled_start ASC, id ASC` (soonest first), paginated by a keyset cursor on
   `(scheduled_start, id)` under a new cursor scope. Today-scheduled jobs are excluded here —
   they belong to Today only (no double-count between the Today and Upcoming tiles). A
   future-dated job advanced early to `in_progress` appears in no scope list — same accepted
   gap as AC #9; do NOT widen the status predicate to include `in_progress` (it would break
   the mutually-exclusive bucket contract).

5. **Given** `?scope=overdue`, **when** called, **then** only jobs with
   `scheduled_start < start of today IST` **and** `status IN ('scheduled','in_progress')` are
   returned (catches both stale `scheduled` and stale `in_progress`), sorted
   `scheduled_start ASC, id ASC` (oldest problem first), same `(scheduled_start, id)` cursor.

6. **Given** `?scope=history`, **when** called, **then** only jobs with
   `status IN ('completed','cancelled')` are returned, sorted `scheduled_start DESC, id DESC`
   (most recent planned date first — uniform key; `completed_at` is returned per row for
   display but is NOT the sort key, because cancelled rows have it NULL and a mixed keyset
   would be unsound). The repeatable `status` filter narrows it to completed-only or
   cancelled-only (this is how the FE History chips will work).

7. **Given** `?scope=upcoming` **together with** `?date=…` (same for overdue/history + date),
   **when** called, **then** HTTP 422 with `error_code: "VALIDATION_ERROR"`. Given an unknown
   `scope` value, **then** HTTP 422 as well. `scope='today'` + `date` remains legal (today is
   the default scope; `date` re-anchors its window).
   **Status filter in non-today scopes**: intersected with the scope's forced status set with
   NO special-casing — `?scope=upcoming&status=completed` and `?scope=overdue&status=completed`
   legitimately return an empty page (the scope predicates already pre-narrow status; the FE
   never sends such combinations). `technicianId`/tech-forcing semantics are unchanged in all
   scopes.

8. **Given** any of the new cursor scopes, **when** a cursor from a *different* scope or
   endpoint is replayed, **then** HTTP 400 `VALIDATION_ERROR` via `decodeCursor` scope check
   (a `jobs-list` cursor must not page an `upcoming` query — their keyed timestamps mean
   different columns).

9. **Given** `GET /api/v1/users/me` (owner or technician, company set up), **when** called,
   **then** the response's `jobStatusCounts` is **replaced** by
   `jobCounts: { today, upcoming, overdue, completed, cancelled }` (camelCase, integers) where:
   - `today` = `scheduled_start` inside today's IST window AND `status IN ('scheduled','in_progress')`
   - `upcoming` = `scheduled_start >= start of tomorrow IST` AND `status='scheduled'`
   - `overdue` = `scheduled_start < start of today IST` AND `status IN ('scheduled','in_progress')`
   - `completed` / `cancelled` = all-time counts by status
   These THREE day-buckets (today/upcoming/overdue) are mutually exclusive (AC #4's tomorrow
   boundary), so their sum + completed + cancelled = all jobs. Known gap, accepted for this
   story: a FUTURE-dated job
   advanced to `in_progress` early matches none of today/upcoming/overdue — it disappears from
   the action tiles (it still shows in the technician's day views). Do not invent a fifth
   bucket for it.
   Note: the `today`/`overdue` tile counts deliberately exclude finished jobs (actionable
   counts), while the Jobs-tab Today list still shows all statuses via chips — tiles are action
   counts, lists are full views. Pre-tenant profiles return all zeros under `jobCounts`.

10. **Given** any endpoint returning a job (`create`, `get detail`, list in every scope,
    profile `jobs` page), **when** called, **then** each `JobResponse` includes
    `completedAt: string | null` (ISO 8601). Two job-returning endpoints deliberately do NOT
    gain the field in this story: the technician delta-sync payload (explicit column list —
    follow-up) and the customer-detail job history rows (a 5-column slim mapper,
    `customers.service.ts:471,505-511` — follow-up).

11. **Given** the whole change, **when** `bun run lint` and the test suite run, **then** they
    pass with new unit tests covering every AC above (DTO validation in the DTO spec file,
    per-scope filters/sort/cursor, profile counts), updated existing assertions that pin the
    old response shape (`jobs.service.spec.ts:364-382` full-object `toEqual`; also
    `users.service.spec.ts:304,426,500` which pin `result.jobStatusCounts` with `toEqual`), and
    the list endpoint's e2e suite extended for the scopes (Story 3-2 precedent,
    `test/jobs.e2e-spec.ts`). Backfill behaviour is verified in Task 1's
    `apply_migration` + `execute_sql` check, NOT in the Jest suite (no test harness applies
    migrations — specs mock `SupabaseClientFactory`).

## Tasks / Subtasks

- [ ] **Task 1 — Migration: `completed_at`** (AC: #1)
  - [ ] New file `supabase/migrations/20260903000002_add_jobs_completed_at.sql`:
    `ALTER TABLE jobs ADD COLUMN completed_at TIMESTAMPTZ;` then
    `UPDATE jobs SET completed_at = updated_at WHERE status = 'completed';`
    (backfill best-effort from `updated_at` — no completed-at event exists historically).
  - [ ] Apply it via Supabase MCP (`apply_migration`), verify with `execute_sql`
    (column exists, backfill count matches completed-row count, RLS policy untouched).
  - [ ] No new index: scopes ride on the existing `idx_jobs_tenant_id_scheduled_start`
    (`20260621000002_create_jobs.sql:32`). History's status filter post-scans the same index —
    fine at pre-launch scale; a `(tenant_id, status, scheduled_start)` index is deferred.

- [ ] **Task 2 — RPC: stamp `completed_at`** (AC: #2)
  - [ ] New migration `supabase/migrations/20260903000003_rpc_advance_workflow_step_completed_at.sql`
      that re-issues `CREATE OR REPLACE FUNCTION advance_workflow_step` with the UPDATE changed
      to also set `completed_at = CASE WHEN p_new_status = 'completed' THEN now() ELSE
      completed_at END` — never edit an applied migration in place (append-only history).
  - [ ] Apply via MCP; confirm a simulated advance sets it only on completion.
  - [ ] Note: `update_job_with_log` RPC only ever sets `status='cancelled'`
      (`20260621000004_rpc_update_job_with_log.sql:52`) — no other completed_at write path exists
      (verified: no app-level `.update()` on `jobs` anywhere in `src/`; sync is read-only).

- [ ] **Task 3 — Cursor scopes** (AC: #4, #5, #8)
  - [ ] `src/common/utils/cursor.util.ts`: extend `CursorScope` with
      `'jobs-upcoming' | 'jobs-overdue' | 'jobs-history'`. Keep the payload field name
      `createdAt` (it is a generic keyed timestamp; the scope tag carries the semantics — the
      `customer-history` scope already reuses it for `scheduled_start`) — add a one-line doc
      comment. No changes to `encodeCursor`/`decodeCursor` logic; scope-mismatch → 400 is
      already implemented (`cursor.util.ts:100-105`).

- [ ] **Task 4 — DTO: `scope` param** (AC: #7)
  - [ ] `src/jobs/dto/list-jobs-query.dto.ts`: add `scope?` — `@IsOptional()` `@Transform(trim)`
      `@IsEnum(JobListScope)` where `JobListScope` is a real runtime enum in a new
      `src/jobs/enums/job-list-scope.enum.ts` (matching `job-status.enum.ts` style):
      `export enum JobListScope { TODAY = 'today', UPCOMING = 'upcoming', OVERDUE = 'overdue',
      HISTORY = 'history' }` — a TS type union will NOT work: `@IsEnum` needs a runtime value
      (`Object.keys(entity)`). Swagger doc per existing params.
  - [ ] Cross-field rule: `scope` present AND `scope !== 'today'` AND `date` present → 422.
      Implement with a file-local `@ValidatorConstraint` (same pattern as
      `IsCalendarDateConstraint`, `list-jobs-query.dto.ts:35-56`) so it lands as a 422 via the
      global ValidationPipe, not a service-level 400. Attachment point: put
      `@Validate(ScopeDateExclusivityConstraint)` on the `scope` property; its `validate()`
      reads `args.object.date`; `@IsOptional()` on `scope` already makes it a no-op when scope
      is absent (so a plain `?date=` without scope still passes).
  - [ ] Update the swagger summary in `src/jobs/jobs.controller.ts:62-64` ("List jobs filtered
      by date (IST day), status, and technician") to mention the new
      `scope=today|upcoming|overdue|history` param.
  - [ ] Unit tests for the DTO go in the existing `src/jobs/dto/list-jobs-query.dto.spec.ts`.

- [ ] **Task 4b — e2e** (AC: #11; Story 3-2 precedent)
  - [ ] Extend `test/jobs.e2e-spec.ts` with scope coverage (default = today regression,
      upcoming/overdue/history filters + sorts, scope+date 422, cursor cross-scope 400). The
      existing `listChain` mock (`:351-358` stubs only `select/eq/gte/lt/in/or/order`) needs
      stubs for any new builder methods used.

- [ ] **Task 5 — Service: per-scope listing** (AC: #3, #4, #5, #6, #7, #8)
  - [ ] `listJobs` in `src/jobs/jobs.service.ts`: branch on `query.scope ?? 'today'`. Keep the
      existing day-window code path untouched for `today` (including its `jobs-list` cursor).
  - [ ] `upcoming`: `.gte('scheduled_start', tomorrowRange.start.toISOString())` (tomorrow's
      range = `getIstDayRange()` shifted by +24h, or equivalently `range.end` of today — pick
      one, comment it; do NOT hand-roll IST math) + `.eq('status', 'scheduled')`.
  - [ ] `overdue`: `.lt('scheduled_start', todayRange.start.toISOString())` +
      **`.in('status', ['scheduled','in_progress'])`** — do NOT use a chained
      `.not.in(...)`: `not` is a 3-arg method on postgrest-js (`not(column, operator, value)`),
      and `.not.in(...)` is a property access on a function object → TypeError at runtime.
      The `.in` form is equivalent given the status CHECK constraint
      (`20260621000002_create_jobs.sql:18-19`).
  - [ ] `history`: base predicate `.in('status', ['completed','cancelled'])`, then the
      caller's `query.status` filter applies as an intersection (reuse the existing
      `query.status` branch). Same intersect- semantics apply to upcoming/overdue (AC #7) —
      no special-casing.
  - [ ] New scopes sort `scheduled_start` + `id` per AC and paginate with a cursor minted from
      `encodeCursor(last.id, last.scheduled_start, <matching new scope>)`; decode feeds
      `.or(`scheduled_start.lt.${c.createdAt},and(scheduled_start.eq.${c.createdAt},id.lt.${c.id})`)`
      for DESC scopes and the mirrored `gt` variant for ASC scopes (upcoming/overdue are ASC).
      Cursor-scope mismatch → 400 via existing `decodeCursor`.
  - [ ] Technician scoping (force own id) and owner `technicianId` filter apply in every scope —
      keep the existing branch (`jobs.service.ts:529-533`) common to all paths.

- [ ] **Task 6 — JobResponse: `completedAt`** (AC: #10)
  - [ ] Add `completed_at: string | null` to `JobRow` (`jobs.service.ts:104-122`), add the
      column to **THREE** explicit select lists: `JOB_DETAIL_COLUMNS`
      (`jobs.service.ts:167` — note the name; `JOB_COLUMNS` proper only exists in
      `users.service.ts:29`), the inline list query select (`jobs.service.ts:516`), AND
      `src/users/users.service.ts:29-30` `JOB_COLUMNS` (the profile endpoint has its own
      deliberately-separate literal — missing it makes `row.completed_at` `undefined` for
      profile rows, the `as JobRow[]` cast hides it from TS, and JSON.stringify drops the key).
  - [ ] Map `completedAt: row.completed_at` in `toResponse` (`jobs.service.ts:783`).
  - [ ] Do NOT touch `src/sync/sync.service.ts` or the customer job-history mapper
      (`src/customers/customers.service.ts:505-511`) — both follow-ups, documented in AC #10.

- [ ] **Task 7 — Profile: `jobCounts` reshape** (AC: #9)
  - [ ] `src/users/users.service.ts`: replace `JobStatusCounts` import/usage with a new
      `JobCounts` interface `{ today, upcoming, overdue, completed, cancelled }`; update
      `EMPTY_JOB_STATUS_COUNTS` → `EMPTY_JOB_COUNTS` (`users.service.ts:135-140`), both
      `UserProfileResponse` interfaces (`:79`, `:87`), the pre-tenant early returns
      (`:195`, `:205`), and the owner/technician payloads.
  - [ ] Rewrite `getJobStatusCounts` (`users.service.ts:435-479`) as `getJobCounts`: five
      `head:true, count:'exact'` queries in `Promise.all`, reusing `getIstDayRange()` for the
      boundaries (today window; tomorrow start for upcoming; today start for overdue) — owner:
      tenant-wide; technician: `technician_id`-scoped. Same error handling pattern
      (`InternalServerErrorException` on any count error). NOTE: `users.service.spec.ts:183-227`
      `jobsTableHandler` dispatches on `.eq('status', …)` and is thenable-only — this rewrite
      needs a real mock rework (builders with `.gte/.lt` + five queries), not a tweak.
  - [ ] Update the swagger summary text in `src/users/users.controller.ts:33-39` ("status
      counts" → `jobCounts`).
  - [ ] Frontend impact for the handoff (fenzo-app 1-5 consumes this; four files read the old
      shape): `src/services/resources/users.ts:47,106`, `src/services/resources/index.ts:39`,
      `src/screens/HomeScreen.tsx:102-113,155`, `src/components/HomeHeader.tsx:5,62-63,77-83,113-135`.

- [ ] **Task 8 — Unit tests** (AC: #11, all ACs)
  - [ ] `src/jobs/dto/list-jobs-query.dto.spec.ts`: scope enum validation; scope+date 422
      (including `scope='today'` + `date` being legal); unknown scope → 422.
  - [ ] `jobs.service.spec.ts`: one describe block per scope asserting the Supabase query
      builder calls (eq/gte/lt/in/order) and sort/cursor key; `.in(['scheduled','in_progress'])`
      for overdue; scope-tagged cursor rejection; `completedAt` mapping (including the
      undefined-when-column-missing trap via the users.service select list). Update the
      existing full-object assertions (`:364-382`) for the added `completedAt`.
  - [ ] `users.service.spec.ts`: `jobCounts` shape per role + pre-tenant zeros + count-query
      wiring (mock rework per Task 7). Update the assertions pinning the old field name:
      `:304`, `:426`, `:500` (`result.jobStatusCounts` `toEqual`).
  - [ ] `bun run lint` + `bun run test` green.

## Dev Notes

- **Existing patterns to reuse (never reinvent):**
  - `getIstDayRange()` (`src/common/utils/ist-day-range.util.ts`) — the ONLY IST arithmetic.
    Do not hand-roll UTC+5:30 math in new code. The overdue boundary is exactly
    `getIstDayRange().start` and today's window is `[start, end)` — so upcoming's
    "start of tomorrow" is simply `range.end` (same function, zero new math), and a job can
    never be in two buckets at once.
  - Cursor mechanics: copy the structure of `listProfileJobs` (`users.service.ts:385-433`) —
    it is the freshest example of keyset pagination in this codebase (page+1 fetch, slice,
    `nextCursor` only when `hasMore`). The customer-history list
    (`customers.service.ts:478-486`) is the precedent for a `scheduled_start`-keyed keyset.
  - DTO cross-field validation: mirror the `IsCalendarDateConstraint` block
    (`list-jobs-query.dto.ts:35-56`) for the scope+date exclusivity validator.
  - `trim` transformer + `@Transform(toArray)` already exist in the DTO — reuse for `scope`.
- **IST day boundary is a *day* boundary, not a time-of-day one** (decided with the user): a
  job scheduled today at 09:00 that is still `scheduled` at 21:00 is NOT overdue — it is a
  Today item. Overdue starts the moment the calendar day (IST) has passed. Same-day jobs are
  never Upcoming either (tomorrow boundary) — a job is in exactly one timeline bucket.
- **`toResponse` is shared by job endpoints that use it** (create/get detail/list/profile
  jobs) — but NOT by sync or customer job history, which have their own mappers (Task 6
  documents the deliberate exclusions). Verify with one spec assertion per covered route.
- **Testing standards** (`_bmad-output/planning-artifacts/architecture.md` §Testing Patterns):
  Jest unit specs with mocked `SupabaseClientFactory`; the RLS isolation spec
  (`test/integration/rls-isolation.integration.spec.ts`) is unaffected (no RLS/policy change),
  but run it once after applying migrations as cheap insurance.
- **Performance**: every scope is a `(tenant_id, scheduled_start)` index range scan; p95 < 300ms
  NFR (`architecture.md` §Performance) holds by construction. No caching layer.

### Project Structure Notes

- New files: `supabase/migrations/20260903000002_add_jobs_completed_at.sql`,
  `supabase/migrations/20260903000003_rpc_advance_workflow_step_completed_at.sql`. Everything
  else edits existing files in place.
- Naming: camelCase in TS/responses (`completedAt`, `jobCounts`), snake_case in DB/RPC.
- `baseline_commit` at story creation: HEAD of `fenzit-be` main.

### References

- [Source: fenzit-be/src/jobs/jobs.service.ts:491-572] current listJobs (day window, sort, cursor)
- [Source: fenzit-be/src/jobs/jobs.service.ts:104-122,167,516,783] JobRow/select lists/toResponse
- [Source: fenzit-be/src/jobs/dto/list-jobs-query.dto.ts:35-56] IsCalendarDate cross-field pattern
- [Source: fenzit-be/src/jobs/dto/list-jobs-query.dto.spec.ts] DTO spec home for scope tests
- [Source: fenzit-be/src/common/utils/cursor.util.ts:100-105] scope-mismatch 400 (already built)
- [Source: fenzit-be/src/common/utils/ist-day-range.util.ts] IST day range
- [Source: fenzit-be/src/users/users.service.ts:29-30,79-88,135-140,195,205,385-433,435-479] profile + JOB_COLUMNS + counts
- [Source: fenzit-be/src/users/users.controller.ts:33-39] swagger summary to update
- [Source: fenzit-be/src/customers/customers.service.ts:471,505-511] job-history mapper (excluded)
- [Source: fenzit-be/src/sync/sync.service.ts:29-34] sync column list (excluded)
- [Source: fenzit-be/supabase/migrations/20260621000002_create_jobs.sql:18-19,32] status CHECK + index
- [Source: fenzit-be/supabase/migrations/20260621000004_rpc_update_job_with_log.sql:50-53] cancel-only status write
- [Source: fenzit-be/supabase/migrations/20260621000006_rpc_advance_workflow_step.sql] completion path
- [Source: fenzit-be/test/jobs.e2e-spec.ts:351-358] e2e listChain stub (Task 4b)
- [Source: fenzit-be/_bmad-output/implementation-artifacts/3-2-list-jobs.md] original list-jobs ACs (regression baseline)
- [Source: fenzit-be/project-context.md] Supabase MCP rules for migrations
- [Source: fenzit-be/_bmad-output/planning-artifacts/architecture.md] error-code/filter/testing conventions

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List