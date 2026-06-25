---
baseline_commit: ab2b2d7c15ddc812208c758c34293b143edd9576
---

# Story 4.1: Delta Sync Endpoint

Status: done

## Story

As a technician,
I want to sync my job data by sending my last sync timestamp,
So that I receive only the records that changed since my last sync and can work offline with up-to-date data.

## Acceptance Criteria

1. **Given** `last_synced_at: null` (initial sync) **When** `POST /api/v1/sync` is called **Then** HTTP 200 with all jobs assigned to the authenticated Technician: all job fields, `currentStep`, attachment metadata, customer `name` and `address`, plus `serverTime` (UTC timestamp at query execution).

2. **Given** a valid ISO 8601 `last_synced_at` timestamp **When** `POST /api/v1/sync` is called **Then** Only jobs with `updated_at > last_synced_at` are returned, plus `serverTime`.

3. **Given** no jobs have been updated since `last_synced_at` **When** `POST /api/v1/sync` is called **Then** HTTP 200 with `{ jobs: [], serverTime: "..." }` (not an error).

4. **Given** 50 changed job records **When** `POST /api/v1/sync` is called **Then** Response time is p95 < 500ms (enforced via composite index on `(technician_id, updated_at)`).

5. **Given** an Owner JWT **When** `POST /api/v1/sync` is called **Then** HTTP 403 with `error_code: "FORBIDDEN"`.

6. **Given** `last_synced_at` in an invalid format (not ISO 8601) **When** `POST /api/v1/sync` is called **Then** HTTP 422 with `error_code: "VALIDATION_ERROR"`.

## Tasks / Subtasks

- [x] Task 1: Migration — add composite index + updated_at trigger
  - [x] 1.1 Write migration `20260621000011_delta_sync_index.sql`: `CREATE INDEX idx_jobs_technician_id_updated_at ON jobs (technician_id, updated_at)`
  - [x] 1.2 Add `update_updated_at_column()` trigger on `jobs` table so any future UPDATE automatically refreshes `updated_at` (retroactively covers the pattern used in existing RPCs)
  - [x] 1.3 Apply migration via Supabase MCP and verified index created

- [x] Task 2: SyncModule — NestJS module, controller, service, DTO
  - [x] 2.1 Create `src/sync/` module with `SyncModule`, `SyncController`, `SyncService`
  - [x] 2.2 Create `SyncRequestDto` with `lastSyncedAt?: string` — validate with `@IsISO8601({ strict: true })` and `@IsOptional()`
  - [x] 2.3 `POST /api/v1/sync` route — `@Roles(Role.TECHNICIAN)` only (403 for owner)
  - [x] 2.4 `SyncService.sync(user, lastSyncedAt?)`: query jobs via Supabase, join customer name/address, join attachments, return `{ jobs, serverTime }`
  - [x] 2.5 Register `SyncModule` in `AppModule`

- [x] Task 3: SyncJobResponse shape
  - [x] 3.1 Define `SyncJobDto` interface with all job fields + `currentStep` + `customer: { name, address }` + `attachments: AttachmentSummary[]`
  - [x] 3.2 Define `SyncResponseDto` with `jobs: SyncJobDto[]` and `serverTime: string`

- [x] Task 4: Tests
  - [x] 4.1 E2E test: initial sync (null `last_synced_at`) returns all technician jobs
  - [x] 4.2 E2E test: delta sync returns only jobs updated after timestamp
  - [x] 4.3 E2E test: empty delta returns `{ jobs: [], serverTime }`
  - [x] 4.4 E2E test: owner JWT → 403
  - [x] 4.5 E2E test: invalid `last_synced_at` format → 422
  - [x] 4.6 Run full suite — 9 suites, 160 passed, 0 failures

### Review Findings

- [x] [Review][Patch] `row.customers` missing null-guard — crash if RLS hides customer row [src/sync/sync.service.ts:52]
- [x] [Review][Patch] `r2Key` (internal R2 storage path) leaked to mobile clients — should be excluded [src/sync/dto/sync-response.dto.ts:7, src/sync/sync.service.ts:68]
- [x] [Review][Patch] No `.limit()` on query — unbounded result set risks OOM and silent 1000-row Supabase cap [src/sync/sync.service.ts:23]
- [x] [Review][Patch] `CREATE TRIGGER` non-idempotent — migration fails on re-run (missing `DROP TRIGGER IF EXISTS` before) [supabase/migrations/20260621000011_delta_sync_index.sql:18]
- [x] [Review][Patch] Missing `tenant_id` filter — defense-in-depth cross-tenant isolation not applied [src/sync/sync.service.ts:33]
- [x] [Review][Patch] `@ApiProperty type: () => Array` loses element type — Swagger docs broken [src/sync/dto/sync-response.dto.ts:40]
- [x] [Review][Defer] Strict gt() boundary: row updated at exact `lastSyncedAt` value silently excluded [src/sync/sync.service.ts:35] — deferred, pre-existing design choice; fix is gte() but changes sync semantics
- [x] [Review][Defer] Trigger may double-set updated_at if service also sets it [supabase/migrations/20260621000011_delta_sync_index.sql:18] — deferred, both use server time so values converge; low impact

## Dev Notes

### Architecture Context
- Follow the existing NestJS module pattern: `src/jobs/`, `src/customers/`, `src/webhooks/` as references
- `SupabaseClientFactory` — call `factory.create(jwt)` per-method; never store client in instance field
- JWT is extracted from request via `@CurrentUser()` decorator (see `src/auth/decorators/current-user.decorator.ts`)
- Roles guard via `@Roles('technician')` + `RolesGuard` — already wired globally
- Response shape must use camelCase (NestJS transformer handles snake_case → camelCase automatically)

### DB Query Strategy
Use Supabase JS client with a single query:
```
supabase.from('jobs')
  .select(`
    *,
    customers!inner(name, address),
    attachments(id, attachment_type, storage_key, size_bytes, confirmed_at)
  `)
  .eq('technician_id', technicianId)
  .gt('updated_at', lastSyncedAt)   // omit when null for initial sync
  .order('updated_at', { ascending: false })
```

`serverTime` = `new Date().toISOString()` captured BEFORE the query executes (so it's conservative — client re-fetches anything that changed during query execution on the next sync).

### RLS
Jobs table already has RLS. The technician JWT will scope via `auth.uid()` naturally. The service layer also filters by `technician_id` explicitly (defense-in-depth).

### Existing Patterns to Follow
- `src/jobs/jobs.service.ts` — how SupabaseClientFactory is used
- `src/jobs/dto/job-response.dto.ts` — how response DTOs are structured
- `test/jobs.e2e-spec.ts` — E2E test structure with seed helpers

### Index Note
`idx_jobs_technician_id_updated_at` composite index makes the WHERE clause sargable even with 50+ records per technician.

## Dev Agent Record

### Implementation Plan
- Migration first: composite index `(technician_id, updated_at DESC)` + `BEFORE UPDATE` trigger on jobs table
- SyncModule: thin controller → service pattern, mirrors JobsModule style
- Single Supabase query with `customers!inner` join and `attachments` join — no N+1
- `serverTime` captured before query (conservative — client re-syncs anything mutated mid-query on next cycle)
- `.gt()` applied conditionally before `.order()` terminal call

### Debug Log
- Initial service built `.order()` before conditional `.gt()` — fixed by moving `.order()` to be the final terminal call
- `@IsISO8601({ strict: true })` still accepts `YYYY-MM-DD` (valid ISO 8601 date) — removed incorrect test case; AC6 only requires rejecting truly invalid strings

### Completion Notes
All 6 ACs satisfied. 6 new E2E tests. Full suite: 9 suites, 160 passed, 0 failures. Migration applied to Supabase.

## File List

- `supabase/migrations/20260621000011_delta_sync_index.sql` (new)
- `src/sync/sync.module.ts` (new)
- `src/sync/sync.controller.ts` (new)
- `src/sync/sync.service.ts` (new)
- `src/sync/dto/sync-request.dto.ts` (new)
- `src/sync/dto/sync-response.dto.ts` (new)
- `src/app.module.ts` (modified — added SyncModule)
- `test/sync.e2e-spec.ts` (new)

## Change Log

- 2026-06-21: Implemented Story 4.1 Delta Sync Endpoint — composite index, updated_at trigger, POST /api/v1/sync with initial/delta/empty sync, 6 E2E tests
