---
baseline_commit: c3eea59b04b6b98ccc85a9285c0718d49789629f
---

# Story 2.3: Customer Detail with Job History

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an owner,
I want to view a customer's full profile and their complete job history,
so that I can review their service history before creating a new job.

## Acceptance Criteria

1. **Given** an existing Customer in the Owner's Tenant, **when** `GET /api/v1/customers/:id` is called, **then** HTTP 200 with the full Customer profile (`id`, `name`, `countryCode`, `phoneNumber`, `address`, `city`, `createdVia`, `createdAt`, `tenantId`) plus a paginated `jobHistory` (newest first), each job entry showing `jobNumber`, `scheduledStart`, `status`, `serviceType`.

2. **Given** a `customerId` belonging to a different Tenant, **when** `GET /api/v1/customers/:id` is called, **then** HTTP 404 with `error_code: "RESOURCE_NOT_FOUND"` (tenant-scoped query returns empty — **404, not 403**).

3. **Given** a `customerId` that does not exist at all, **when** `GET /api/v1/customers/:id` is called, **then** HTTP 404 with `error_code: "RESOURCE_NOT_FOUND"`.

4. **Given** a Customer with no jobs, **when** `GET /api/v1/customers/:id` is called, **then** HTTP 200 with `jobHistory.data: []` (not an error).

5. **Given** a Customer with more than 20 jobs, **when** `GET /api/v1/customers/:id` is called, **then** the first 20 jobs are returned with a `jobHistory.nextCursor` for the next page. *(Behavior shape established now; live job rows arrive in Epic 3 — see Dev Notes.)*

6. **Given** a non-UUID `:id` path param, **when** `GET /api/v1/customers/:id` is called, **then** HTTP 400 (via `ParseUUIDPipe`) — malformed id is a client error, not a 404.

7. **Given** a Technician JWT, **when** `GET /api/v1/customers/:id` is called, **then** HTTP 403 with `error_code: "FORBIDDEN"` (owner-only, consistent with the rest of Epic 2).

8. **Given** an Owner JWT whose `tenantId` is `null`, **when** `GET /api/v1/customers/:id` is called, **then** HTTP 400 with `error_code: "VALIDATION_ERROR"` (company setup required — consistent with Stories 2.1/2.2).

9. **Given** no `Authorization` header, **when** `GET /api/v1/customers/:id` is called, **then** HTTP 401 with `error_code: "UNAUTHORIZED"`.

## Tasks / Subtasks

- [x] **Task 1 — response shapes** (AC: #1, #4, #5)
  - [x] Added `JobHistoryItem` + `CustomerDetailResponse` (`extends CustomerResponse` + `jobHistory: PaginatedResponse<JobHistoryItem>`) and a typed `CustomerRow` to `customers.service.ts`.
  - [x] `JOB_HISTORY_PAGE_SIZE` const deferred to Epic 3 (would be unused now → lint error); documented as a NOTE with the page-20 / `scheduled_start DESC` spec instead.
- [x] **Task 2 — service `getCustomerDetail()`** (AC: #1, #2, #3, #4, #5, #8)
  - [x] `getCustomerDetail(owner, customerId): Promise<CustomerDetailResponse>`
  - [x] `if (!owner.tenantId)` → `BadRequestException` `VALIDATION_ERROR`
  - [x] `createAdmin().from('customers').select(CUSTOMER_COLUMNS).eq('id', …).eq('tenant_id', …).single<CustomerRow>()`
  - [x] Guard order corrected: genuine DB error (`code !== 'PGRST116'`) → 500 FIRST, then `!data` → `NotFoundException` `RESOURCE_NOT_FOUND` (covers AC#2 cross-tenant AND AC#3 missing — both 404). *(A unit test caught the original wrong ordering where a 500-class error was masked as 404.)*
  - [x] Response reuses `toResponse(data)` + attaches empty `PaginatedResponse<JobHistoryItem>([], null)`.
- [x] **Task 3 — controller `GET /:id` handler** (AC: #1, #6, #7, #9)
  - [x] `@Get(':id')` with `@Roles(Role.OWNER)`, `@HttpCode(200)`, `@ApiOperation`, `@ApiResponse` (200/400/401/403/404)
  - [x] `@Param('id', ParseUUIDPipe) id` (AC#6 — invalid UUID → 400)
  - [x] Declared BELOW the parameterless `@Get()` list route (comment added to prevent reordering).
- [x] **Task 4 — Unit tests** (AC: #1, #2, #3, #4, #8)
  - [x] `customers.service.spec.ts` +5 tests: full profile + empty `jobHistory`; PGRST116 → 404; other-tenant empty → 404; non-PGRST116 → 500; no-tenant → 400 (createAdmin not called).
- [x] **Task 5 — E2E tests** (AC: #1–#9)
  - [x] `test/customers.e2e-spec.ts` +7 `GET /:id` tests: 200 profile + empty `jobHistory`, 404 not-found, 404 cross-tenant, 400 non-UUID, 403 technician, 400 no-tenant, 401 no JWT. Mock `from().select().eq().eq().single()`.
- [x] **Task 6 — Verify** (AC: all)
  - [x] `bun run build` clean
  - [x] `bun run test` (88/88) + e2e (`71 passed, 2 skipped`) green, no regressions
  - [x] eslint: `customers.service.ts`/`controller.ts` clean; spec/e2e carry only the accepted baseline patterns

### Review Findings (code review 2026-06-21)

- [x] [Review][Patch] Post-fetch tenant assertion (defense-in-depth on the service-role read path) — FIXED: guard is now `if (!data || data.tenant_id !== owner.tenantId)` → 404, so a dropped `.eq('tenant_id')` filter could never leak another tenant's row. Unit test added (row with wrong tenant → 404). (source: blind, Low)
- [x] [Review][Patch] `{ data: null, error: null }` branch of `.single()` untested — FIXED: added `mockSingle({ data: null, error: null })` → 404 unit test, locking the (error,data) matrix cell against the reorder bug. (source: edge, Low)
- [x] [Review][Patch] Technician + non-UUID precedence untested — FIXED: added e2e test asserting Technician JWT + `not-a-uuid` → 403 (RolesGuard before ParseUUIDPipe). (source: edge, Low)

### Builds on Stories 2.1 + 2.2 (both done)

`customers` table, module, service, controller, `CustomerResponse`/`toResponse` mapping, and the owner-only + no-tenant guards all exist. This story ADDS a `GET /:id` detail endpoint — no new module, no new migration. [Source: src/customers/customers.service.ts, src/customers/customers.controller.ts]

### 404-not-403 is the key semantic (AC#2)

Cross-tenant access must look identical to "not found" — never reveal that a resource exists in another tenant. Because the query filters `.eq('tenant_id', owner.tenantId).eq('id', customerId)`, a customer in another tenant yields zero rows → `PGRST116` → `NotFoundException` (404). Do NOT add a separate 403 branch for cross-tenant. This matches the epic AC ("RLS returns empty — not a 403") and the established `createAdmin()` + app-layer tenant filter pattern. [Source: src/skills/skills.service.ts:111-131 — the `PGRST116` → 404 precedent in `deleteSkill`]

### `.single()` + PGRST116 handling (reuse the Skills precedent)

`.single()` returns `error.code === 'PGRST116'` when zero rows match. `SkillsService.deleteSkill` already establishes the pattern: treat `PGRST116` as "not found" → 404, and any OTHER error code as a real failure → 500. Mirror it exactly. Guard `!data` as well so a null row never reaches the mapper. [Source: src/skills/skills.service.ts:111-131]

### jobHistory is a placeholder shape this story (jobs table arrives in Epic 3)

The `jobs` table does not exist until Epic 3. Return `jobHistory` as an **empty** `PaginatedResponse<JobHistoryItem>` (`{ data: [], nextCursor: null, hasMore: false }`). This establishes the response CONTRACT now; Epic 3 (Story 3.x) backfills the real query. This mirrors how Story 2.2 returns `jobCount: 0`/`lastJobDate: null` placeholders. Do NOT create or join a `jobs` table here. AC#5 (>20 jobs → nextCursor) is therefore shape-only this story — note it explicitly; do not fake job rows.

- When Epic 3 wires the real query: job history sorts `scheduled_start DESC`, page size 20, keyset cursor `{ id, scheduledStart }` (job id is a UUID, scheduled_start is a timestamptz — both pass the hardened `decodeCursor` validation added in Story 2.2). The `jobHistory` envelope and `JobHistoryItem` fields (`jobNumber`, `scheduledStart`, `status`, `serviceType`) are fixed now so Epic 3 only fills `data`.
- Do NOT add a job-history `cursor` query param in this story — there is nothing to page yet, and an accepted-but-ignored param is misleading. Epic 3 adds it alongside the real query.

### Reuse, do not reinvent

- `PaginatedResponse<T>` for the `jobHistory` envelope. [Source: src/common/dto/paginated-response.dto.ts]
- The customer snake→camel mapping already in `toResponse()` — extract/share it rather than duplicating the field list. [Source: src/customers/customers.service.ts:193-215]
- `CUSTOMER_COLUMNS` select constant (already includes every profile field). [Source: src/customers/customers.service.ts:47-48]
- `ParseUUIDPipe` from `@nestjs/common` for `:id` (Story 2.1's controller already imports it elsewhere; Skills controller uses it on `Delete(':id')`). Use the default version (`all`), NOT `'4'` — the Epic-1 retro flagged that `IsUUID('4')`/`ParseUUIDPipe({version:'4'})` rejects test UUIDs with version nibble `0`. [Source: epic-1-retro-2026-06-20.md]

### Route ordering pitfall (must-handle)

In `customers.controller.ts` the order must be: `@Post()`, then `@Get()` (list), then `@Get(':id')`. Fastify/Nest route matching is declaration-ordered for the same path prefix; if `:id` is declared before the parameterless `@Get()`, a bare `GET /customers` could be captured by the `:id` route. Keep `:id` last.

### Phone is split (carried from 2.1)

The detail response returns `countryCode` + `phoneNumber` separately (same as create/list), never a combined E.164 string. [Source: supabase/migrations/20260621000001_create_customers_table.sql]

### CustomerDetailResponse shape

```ts
export interface JobHistoryItem {
  jobNumber: string;
  scheduledStart: string;
  status: string;
  serviceType: string;
}

export interface CustomerDetailResponse {
  id: string;
  name: string;
  countryCode: string;
  phoneNumber: string;
  address: string | null;
  city: string | null;
  createdVia: 'manual' | 'job_creation';
  createdAt: string;
  tenantId: string;
  jobHistory: PaginatedResponse<JobHistoryItem>;
}
```

### Scope boundaries

- Single-customer detail only. No edit/delete. No new migration. No `jobs` table/join (Epic 3).
- Owner-only (`@Roles(Role.OWNER)`).
- Don't broaden the list endpoint or touch 2.1/2.2 behavior.

### Testing standards

- Unit: extend `customers.service.spec.ts`. Mock chain for detail is `from().select().eq().eq().single()` (two `.eq()`). Reuse the existing `mockInsert`-style chainable approach but terminal is `.single()`.
- E2E: extend `test/customers.e2e-spec.ts`. For `ParseUUIDPipe` tests, a non-UUID `:id` returns 400 BEFORE the handler/service — no mock needed. For service-reaching tests use a valid UUID like `00000000-0000-4000-8000-000000000001`.
- `error_code` assertions: 404 → `RESOURCE_NOT_FOUND`, 403 → `FORBIDDEN`, 401 → `UNAUTHORIZED`, 400 (no-tenant) → `VALIDATION_ERROR`.
- Lint baseline: spec/e2e `no-unsafe-member-access` on `JSON.parse` + `unbound-method` on jest mocks are accepted (match `skills.*.spec.ts`); keep production `customers.service.ts` lint-clean (type the DB row like the 2.2 `CustomerListRow`).

### Project Structure Notes

- Modified: `src/customers/customers.service.ts` (+`getCustomerDetail`, `JobHistoryItem`, `CustomerDetailResponse`, `JOB_HISTORY_PAGE_SIZE`), `src/customers/customers.controller.ts` (+`@Get(':id')`), `src/customers/customers.service.spec.ts`, `test/customers.e2e-spec.ts`.
- No new files, no `app.module.ts` change, no migration.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 2.3: Customer Detail with Job History] — ACs, job-history pagination (page 20, scheduled_start DESC), jobs-deferred note
- [Source: _bmad-output/planning-artifacts/epics.md#FR-15] — customer detail + job history
- [Source: src/skills/skills.service.ts:111-131] — `PGRST116` → 404 precedent
- [Source: src/customers/customers.service.ts] — `toResponse` mapping, `CUSTOMER_COLUMNS`, owner/no-tenant guard to mirror
- [Source: src/common/dto/paginated-response.dto.ts] — `jobHistory` envelope
- [Source: 2-1-create-customer.md, 2-2-list-search-customers.md] — split-phone, createAdmin rationale, lint baseline, cursor-hardening (for Epic 3 job-history paging)
- [Source: epic-1-retro-2026-06-20.md] — `ParseUUIDPipe`/`IsUUID('4')` version-nibble trap

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m]

### Debug Log References

- Unit: `customers.service.spec.ts` 23/23 (5 new for `getCustomerDetail`). E2E: `customers.e2e-spec.ts` 25/25 (7 new GET /:id).
- A unit test caught a guard-ordering bug: the initial `(PGRST116 || !data)` check masked a non-PGRST116 DB error as 404. Reordered to check genuine errors → 500 first, then `!data` → 404. Re-verified green.
- Full regression: unit 88/88 (10 suites), e2e 71 passed + 2 skipped (7 suites). No regressions.

### Completion Notes List

- Added `GET /api/v1/customers/:id` (owner-only) returning the full customer profile + a `jobHistory` paginated envelope.
- **404-not-403:** tenant-scoped `.eq('id').eq('tenant_id')` + `.single()`; PGRST116/empty → 404 `RESOURCE_NOT_FOUND`, so a cross-tenant id is indistinguishable from not-found (never 403). Reused the Skills `PGRST116` precedent.
- `jobHistory` is an empty `PaginatedResponse<JobHistoryItem>` — the jobs table arrives in Epic 3. Contract/shape (`jobNumber`, `scheduledStart`, `status`, `serviceType`; page 20, `scheduled_start DESC`) is fixed now via a NOTE so Epic 3 only fills `data`. No `jobs` table/join created.
- `@Param('id', ParseUUIDPipe)` → non-UUID id is a 400 before the handler (AC#6). Used default version (not `'4'`) per the Epic-1 retro trap.
- `@Get(':id')` declared below the list `@Get()` (catch-all shadowing guard) with a comment.
- Production files lint-clean (typed `CustomerRow`); scope held — no migration, no module change.

### File List

- `src/customers/customers.service.ts` (modified — `getCustomerDetail`, `JobHistoryItem`, `CustomerDetailResponse`, `CustomerRow`)
- `src/customers/customers.controller.ts` (modified — `@Get(':id')` handler)
- `src/customers/customers.service.spec.ts` (modified — +5 unit tests, +2 from review)
- `test/customers.e2e-spec.ts` (modified — +7 e2e tests, +1 from review)

## Change Log

| Date       | Change                                                                 |
|------------|------------------------------------------------------------------------|
| 2026-06-21 | Story 2.3 implemented: `GET /api/v1/customers/:id` (owner-only, full profile + empty jobHistory envelope, 404-not-403 cross-tenant). +5 unit, +7 e2e. Unit 88/88, e2e 71 pass/2 skip. Status → review. |
| 2026-06-21 | Code review (3 adversarial layers): 0 AC violations; 3 Low patches applied — post-fetch tenant assertion (defense-in-depth), `{data:null,error:null}` 404 test, technician+non-UUID→403 test. Unit 90/90, e2e 72 pass/2 skip. Status → done. |
