---
baseline_commit: c26eacc6fe7e9eda21e2465cca8441ae7295a23e
---

# Story 2.4: Populate Customer Detail Job History

Status: done

> Gap found during frontend planning (2026-09-01): `GET /api/v1/customers/:id` still returns the Epic-2 placeholder `jobHistory: new PaginatedResponse([], null)` (customers.service.ts:426) even though the jobs table has existed since Story 3.1. The FE Customer Detail screen (fenzo-app Story 2.1) depends on this.

## Story

As an owner,
I want a customer's detail response to include their real, paginated job history,
so that the mobile Customer Detail screen can show their service record.

## Acceptance Criteria

1. **Given** an existing customer with jobs, **when** `GET /api/v1/customers/:id` is called, **then** `jobHistory` contains real rows sorted `scheduled_start DESC`, page size 20, in the standard `PaginatedResponse` envelope.
2. Each `JobHistoryItem` gains an `id: string` field (the job uuid) alongside the existing `jobNumber`, `scheduledStart`, `status`, `serviceType` — clients need it to navigate to job detail. (Additive change; no field removed.)
3. **Given** `?cursor=<opaque>` query param on the same endpoint, **then** the next history page is returned (keyset on `scheduled_start DESC, id DESC` via the existing `encodeCursor`/`decodeCursor` utils — reuse, adapting the cursor payload to `{ id, scheduledStart }` or keep `{ id, createdAt }` keyed on scheduled_start; record the choice); malformed cursor → 400 (existing decodeCursor behaviour).
4. **Given** a customer with zero jobs, **then** `jobHistory: { data: [], nextCursor: null, hasMore: false }` — unchanged empty behaviour.
5. Existing ACs of Story 2.3 (404 cross-tenant, 403 technician) unchanged; unit + e2e specs updated; the placeholder comment at customers.service.ts:90-92 and :425-427 removed.

## Tasks / Subtasks

- [x] Add `JOB_HISTORY_PAGE_SIZE = 20` const; extend `getCustomerDetail(owner, customerId, cursor?)`; add `cursor` to a new `GetCustomerDetailQueryDto` (`@IsOptional @IsString @MaxLength(512)`), wire through the controller `@Query()`.
- [x] History query: `admin.from('jobs').select('id, job_number, scheduled_start, status, service_type').eq('tenant_id', owner.tenantId).eq('customer_id', customerId)` + keyset predicate + `.order('scheduled_start', {ascending:false}).order('id',{ascending:false}).limit(21)`; map snake→camel; build envelope with `encodeCursor`.
- [x] Add `id` to `JobHistoryItem`; update Swagger annotations.
- [x] Index check: confirm an index serves `(tenant_id, customer_id, scheduled_start DESC)`; if only `idx_jobs_tenant_id_scheduled_start` exists, add `idx_jobs_customer_history` migration (tenant_id, customer_id, scheduled_start DESC, id DESC).
- [x] Unit tests (customers.service.spec) + e2e (customers.e2e-spec): first page, second page via cursor, empty history, cross-tenant 404 unchanged.

## Dev Notes

- Follow the exact keyset pattern from jobs.service.ts#listJobs (or-predicate + limit N+1 + slice) — do not invent a new pagination style.
- Guard-order invariant (Epic 2 retro): genuine DB error → 500 FIRST, then empty → 404/empty-envelope.
- createAdmin() is the established client; keep the explicit tenant_id filters (defense-in-depth).
- Downstream consumer: fenzo-app Story 2.1 (`workspace/core/frontend/fenzo-app/_bmad-output/implementation-artifacts/2-1-customer-detail-with-job-history.md`) and the contract entry in fenzo-app `_bmad-output/planning-artifacts/api-contracts.md` §13 — update §13 when this merges.

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5 (bmad-dev-story workflow)

### Debug Log References

None — no failing runs or debug sessions required.

### Completion Notes List

- `getCustomerDetail` now takes an optional `cursor` and calls a new private `getJobHistory` that queries `jobs` filtered by `tenant_id`+`customer_id`, keyset-paginated on `(scheduled_start DESC, id DESC)` — same or-predicate + limit N+1 + slice pattern as `jobs.service.ts#listJobs`.
- Reused the generic `{id, createdAt}` cursor.util shape rather than adding a second cursor codec: `createdAt` holds the `scheduled_start` value for this endpoint (per the Dev Notes' recorded choice).
- Added `id` to `JobHistoryItem` (additive) and a new `GetCustomerDetailQueryDto` (`cursor`, optional, `@MaxLength(512)`) wired through the controller's `@Query()`.
- Verified via Supabase MCP that no existing index served `(tenant_id, customer_id, scheduled_start)` — only `idx_jobs_tenant_id_scheduled_start (tenant_id, scheduled_start)` existed — so added migration `20260903000001_jobs_customer_history_index.sql` creating `idx_jobs_customer_history (tenant_id, customer_id, scheduled_start DESC, id DESC)`, applied and verified live via `mcp__supabase__apply_migration` / `execute_sql`.
- Removed the Epic-2 placeholder comment and empty-envelope return; a customer with zero jobs still returns `{data: [], nextCursor: null, hasMore: false}` (unchanged shape, now via the real query returning zero rows rather than a hardcoded empty envelope).
- Unit tests (`customers.service.spec.ts`): rewrote the `getCustomerDetail` mock to route `admin.from(table)` by table name (`customers` vs `jobs`) since the method now queries both; added first-page, 21-row/hasMore+nextCursor, cursor-keyset-predicate, malformed-cursor (400), and job-history-DB-error (500) cases alongside the existing 404/500/400 customer-fetch cases (all still pass).
- E2E tests (`customers.e2e-spec.ts`): same table-routing fix to `mockDetail`, plus a real-job-history-in-response case and a malformed-cursor-on-`GET /customers/:id` case.
- Full regression run: 243/243 unit tests pass; e2e 169/179 pass with the same 8 pre-existing failures present on the `c26eacc` baseline (4 in `GET /api/v1/customers` list — a `.in()` missing from that describe block's own mock builder — and 4 in `sync.e2e-spec.ts`), confirmed via `git stash` diff against baseline; none are new and none are in this story's scope. `tsc --noEmit` and `eslint` on the touched files show the same pre-existing, unrelated errors (a `cloudflare-worker` type error and this test file's established `JSON.parse(...).foo`-as-`any` pattern) — no new categories introduced.
- Not done here (cross-repo, per repo rules): the Dev Notes' pointer to update fenzo-app's `api-contracts.md` §13 — that's a separate commit in the `fenzo-app` repo once this merges.

**Review patches applied (2026-09-03):**

- All 10 patch findings + the decision finding resolved. Headline change: `cursor.util.ts` now carries a `CursorScope` discriminator in the payload; all four paginated endpoints (customers-list, customer-history, jobs-list, profile-jobs) mint with their own scope and reject mismatched/legacy cursors with 400, with the specific rejection reason logged (`Logger('Cursor')`) while the client body stays generic. Note this is a breaking change for any in-flight cursors minted before this change (they carry no scope and get 400) — acceptable pre-launch.
- `getJobHistory` now takes the admin client from `getCustomerDetail` (one `createAdmin()` per request, not two), decodes/encodes with the `customer-history` scope, and its 500 message reads 'Failed to fetch customer job history'.
- 404-before-400 ordering pinned: comment at the call site + unit test (missing customer + malformed cursor → 404).
- `trim`/`trimToUndefined` extracted to `src/common/utils/trim.transformer.ts`; both DTOs' cursor fields use `trimToUndefined` (verified no behaviour change — an empty `?cursor=` already returned the first page because `if (cursor)` treats `''` as falsy; now pinned by tests in both specs).
- Swagger: added `dto/customer-detail-response.dto.ts` (`JobHistoryItemDto`, `CustomerDetailResponseDto` with `@ApiProperty`); detail endpoint's 200 carries `type:`, its 400 description mentions malformed/foreign cursors.
- Test upgrades: `mockDetail` (unit + e2e) now captures eq/order/or args; added scoping assertions (tenant_id + customer_id eq, scheduled_start/id DESC order), an exactly-20 boundary test, a genuine second-page round-trip test (unit + e2e), a scope-mismatch 400 test, an empty-cursor→first-page test (unit + e2e), a 404-before-400 test; 21-row fixture corrected to newest-first; all manual cursor fixtures across specs gained the matching `scope` field.
- Regression after patches: `src/` unit 252/252 pass (baseline 243 + 9 new). E2e customers+jobs+users: 108 pass / 6 fail — byte-identical failure set on the unpatched baseline (verified via `git stash`): the 4 known customers-list `.in()` mock-builder failures and 2 jobs storage-webhook failures, none in this story's scope and none new. Full `bun test`: 269 pass / 1 fail — the live-DB `rls-isolation.integration.spec.ts` timeout, identical on baseline (needs `TEST_OWNER_A_USER_ID` env). `tsc --noEmit`: only the pre-existing cloudflare-worker `MessageBatch` error.
- Live DB verification (Supabase MCP, post-patch): confirmed `idx_jobs_customer_history (tenant_id, customer_id, scheduled_start DESC, id DESC)` exists live and matches the migration; column types match the cursor validation (uuid ids, timestamptz timestamps); ran the exact keyset predicate the service builds against real data — a cursor from the newest job returns exactly the older job (no gap/duplicate), and the tie-break arm `and(scheduled_start.eq, id.lt)` matches correctly; planner uses `idx_jobs_customer_history` for the query shape (verified with `enable_seqscan=off` — the table only holds 3 rows so the default plan is a seq scan, which is expected pre-launch). Not exercised live: the PostgREST `.or()` string over HTTP (needs the service-role key; same established pattern as `listJobs`).

### File List

- `src/customers/customers.controller.ts` — modified (wire `GetCustomerDetailQueryDto` cursor through `@Query()`; review patch: `type:` on the 200 + cursor in the 400 description)
- `src/customers/customers.service.ts` — modified (`getJobHistory`, `JOB_HISTORY_PAGE_SIZE`, `JobHistoryItem.id`, `JobHistoryRow`; review patches: admin passed in, cursor scopes, 500 message, 404-ordering comment)
- `src/customers/dto/get-customer-detail-query.dto.ts` — added (review patch: shared `trimToUndefined` transform)
- `src/customers/dto/customer-detail-response.dto.ts` — added (review patch: Swagger-facing response DTOs)
- `src/customers/dto/list-customers-query.dto.ts` — modified (review patch: shared trim transformer, `trimToUndefined` on cursor)
- `src/common/utils/trim.transformer.ts` — added (review patch: shared `trim`/`trimToUndefined`)
- `src/common/utils/cursor.util.ts` — modified (review patch: `CursorScope` discriminator + rejection logging)
- `src/common/utils/cursor.util.spec.ts` — modified (scope round-trip/mismatch/legacy tests)
- `src/jobs/jobs.service.ts` — modified (review patch: `jobs-list` cursor scope)
- `src/users/users.service.ts` — modified (review patch: `profile-jobs` cursor scope)
- `src/customers/customers.service.spec.ts` — modified (job-history test coverage; review patches: eq/order assertions, second-page round-trip, exactly-20, scope mismatch, empty-cursor, 404-before-400, DESC fixture)
- `src/jobs/jobs.service.spec.ts` — modified (review patch: scope on manual cursor fixture)
- `src/users/users.service.spec.ts` — modified (review patch: scope on encodeCursor fixture)
- `test/customers.e2e-spec.ts` — modified (job-history test coverage; review patches: second-page round-trip, empty-cursor, orArgs capture, scope on AC5 fixture)
- `test/jobs.e2e-spec.ts` — modified (review patch: scope on AC7 fixture)
- `supabase/migrations/20260903000001_jobs_customer_history_index.sql` — added, applied live via Supabase MCP

## Change Log

- 2026-09-03 — Implemented real, paginated `jobHistory` on `GET /api/v1/customers/:id`, replacing the Epic-2 placeholder; added `idx_jobs_customer_history` index; added test coverage. Status → review.
- 2026-09-03 — Code review completed: decision finding resolved with a `CursorScope` discriminator + rejection logging in the shared cursor payload; all 10 patches applied (admin reuse, 500 message, shared trim transformers, Swagger DTOs, 404-ordering pin) and the test suite upgraded to assert scoping, sort order, the 20-row boundary, and genuine second-page round-trips. Two pre-existing items deferred (see `deferred-work.md` CR2.4-D1/D2). Regression clean vs baseline. Status → done.

### Review Findings

**Decision needed:**

- [x] [Review][Decision] Cross-endpoint cursor confusion — a `listJobs` cursor (keyed on `created_at`) decodes cleanly against the customer-detail endpoint and silently filters `scheduled_start` on the wrong timestamp value → plausible-but-wrong rows with HTTP 200 (and vice versa). `decodeCursor` validates shape only, not scope. Fix requires a choice: add a scope/`type` discriminator to the shared cursor payload, add a per-endpoint codec, or accept as-is. [Sources: blind-hunter+edge-case context; src/common/utils/cursor.util.ts] **Resolved (owner decision): scope discriminator in the shared payload + rejection logging.** Added `CursorScope` union to cursor.util — every endpoint mints cursors with its own scope (`customers-list`, `customer-history`, `jobs-list`, `profile-jobs`) and rejects a mismatched/legacy cursor with 400; the client-facing body stays generic ('Invalid cursor') while the specific reason (bad base64, bad JSON, missing fields, bad field format, scope mismatch with expected vs carried scope) is logged via `new Logger('Cursor')`.

**Patches:**

- [x] [Review][Patch] getJobHistory 500 carries the wrong message — throws `message: 'Failed to fetch customer'` for a job-history DB failure while the log line right above says "Failed to fetch customer job history" [src/customers/customers.service.ts:472]
- [x] [Review][Patch] Empty/whitespace `?cursor=` returns 400 instead of the first page — `trim` yields `''`, which passes `@IsOptional` and reaches `decodeCursor`, which throws; map `''` → `undefined` in the transform (same latent issue in `ListCustomersQueryDto`) [src/customers/dto/get-customer-detail-query.dto.ts:12] — verified this was a false alarm at the service layer (`if (cursor)` treats `''` as falsy → first page), but made it explicit anyway: shared `trimToUndefined` transform on both DTOs' cursor fields + tests pinning empty-cursor → first page in both the unit and e2e specs. No behaviour change.
- [x] [Review][Patch] No genuine "second page via cursor" test in either spec despite the task being checked — the keyset test only asserts the `.or()` predicate; no test passes a valid cursor and asserts the returned rows are the next page [test/customers.e2e-spec.ts:481, src/customers/customers.service.spec.ts:525] — added a true round-trip (page 1: 21 rows → nextCursor → page 2 with that cursor asserts the probe row is returned, hasMore=false) in both specs.
- [x] [Review][Patch] Job-history tenant/customer scoping asserted by no test — mocks discard `.eq()` args, so dropping/typoing `tenant_id`/`customer_id` filters (the only isolation on an RLS-bypassing admin client) ships fully green; capture and assert eq args like the `jobsEqArgs` pattern [src/customers/customers.service.ts:453-454] — `mockDetail` now captures eq args; new test asserts `['tenant_id', 'tenant-uuid']` and `['customer_id', CUSTOMER_ID]`.
- [x] [Review][Patch] Sort order never asserted — `.order` is a no-op mock in both specs, so deleting/flipping the sort passes the suite while breaking AC#1 ordering and keyset correctness; also the 21-row test feeds rows in ascending order and encodes those semantics [src/customers/customers.service.ts:464] — `mockDetail` captures order args; new test asserts `scheduled_start DESC` + `id DESC`; 21-row fixture corrected to newest-first.
- [x] [Review][Patch] Exactly-20-rows boundary unpinned — no test covers `hasMore = rows.length > 20` at exactly 20 rows (the classic off-by-one in the limit-N+1 pattern) [src/customers/customers.service.ts:477] — added exactly-20 test (hasMore=false, nextCursor=null, limit still 21).
- [x] [Review][Patch] Swagger task marked done but response shape undocumented — `JobHistoryItem` is still a plain interface (no `@ApiProperty`), the 200 response has no `type:`, and the detail endpoint's 400 description doesn't mention the now-possible malformed-cursor 400 (the list endpoint's does) [src/customers/customers.service.ts:63, src/customers/customers.controller.ts:78] — added `dto/customer-detail-response.dto.ts` (`JobHistoryItemDto` + `CustomerDetailResponseDto`, both `@ApiProperty`-decorated), wired `type:` on the 200, and the 400 description now mentions malformed/foreign cursors. The service keeps returning its own interfaces — the DTO is Swagger-facing and structurally identical.
- [x] [Review][Patch] Second `createAdmin()` client per request — `getCustomerDetail` already creates one; pass it into `getJobHistory` instead of constructing a second [src/customers/customers.service.ts:448]
- [x] [Review][Patch] 404-before-400 ordering untested/undocumented — customer fetch + 404 check runs before the cursor decodes, so malformed cursor + missing customer → 404, not 400; defensible but unpinned — add a test or comment so a refactor can't silently change it [src/customers/customers.service.ts:426] — pinned with both a unit test (PGRST116 + malformed cursor → NotFoundException) and an ordering-invariant comment at the call site.
- [x] [Review][Patch] `trim` transform helper duplicated — identical inline copy now exists in `get-customer-detail-query.dto.ts` and `list-customers-query.dto.ts`; extract to a shared transformer [src/customers/dto/get-customer-detail-query.dto.ts:5] — extracted to `src/common/utils/trim.transformer.ts` (`trim` + `trimToUndefined`); both DTOs now import from there.

**Deferred (pre-existing):**

- [x] [Review][Defer] `decodeCursor` accepts semantically-invalid timestamps — Bun's `Date.parse('2026-02-30T00:00:00Z')` rolls over (no NaN) and `'1'` parses, so a crafted cursor passes charset+parse validation and can push an invalid timestamp into the PostgREST predicate → 500 instead of 400; injection-safe, wrong status code only; pre-existing shared util — deferred, pre-existing [src/common/utils/cursor.util.ts:20]
- [x] [Review][Defer] Index migration uses plain `CREATE INDEX` (no `CONCURRENTLY`) — takes a lock on `jobs` while building; harmless pre-launch, preventive habit once there is real traffic (delta-sync migration has the same gap) — deferred, pre-existing [supabase/migrations/20260903000001_jobs_customer_history_index.sql:3]
