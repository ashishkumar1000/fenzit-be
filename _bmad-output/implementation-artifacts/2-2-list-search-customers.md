---
baseline_commit: c3eea59b04b6b98ccc85a9285c0718d49789629f
---

# Story 2.2: List & Search Customers

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an owner,
I want to list all my customers and filter them by name or phone,
so that I can quickly find a customer when creating or reviewing jobs.

## Acceptance Criteria

1. **Given** an Owner with existing customers, **when** `GET /api/v1/customers` is called without filters, **then** HTTP 200 with a cursor-paginated payload `{ data, nextCursor, hasMore }` (page size 50), each `data` entry containing `id`, `name`, `countryCode`, `phoneNumber`, `city`, `jobCount`, `lastJobDate`.

2. **Given** `?q=priya`, **when** `GET /api/v1/customers` is called, **then** only customers whose `name` **or** `phoneNumber` contains "priya" (case-insensitive) are returned.

3. **Given** `?q=9833` (partial phone), **when** `GET /api/v1/customers` is called, **then** customers whose `phoneNumber` contains "9833" are returned.

4. **Given** a Tenant with no customers (or none matching `q`), **when** `GET /api/v1/customers` is called, **then** HTTP 200 with `{ data: [], nextCursor: null, hasMore: false }` (not 404).

5. **Given** a `cursor` from a previous paginated response, **when** `GET /api/v1/customers?cursor={nextCursor}` is called, **then** the next page is returned in correct order with no duplicates or gaps.

6. **Given** a Technician JWT, **when** `GET /api/v1/customers` is called, **then** HTTP 403 with `error_code: "FORBIDDEN"`.

7. **Given** an Owner JWT whose `tenantId` is `null`, **when** `GET /api/v1/customers` is called, **then** HTTP 400 with `error_code: "VALIDATION_ERROR"` (company setup required) — consistent with Story 2.1.

8. **Given** a malformed `cursor` (not valid base64url JSON with `id`+`createdAt`), **when** `GET /api/v1/customers?cursor=garbage` is called, **then** HTTP 400 with `error_code: "VALIDATION_ERROR"` (via the existing `decodeCursor` util).

9. **Given** no `Authorization` header, **when** `GET /api/v1/customers` is called, **then** HTTP 401 with `error_code: "UNAUTHORIZED"`.

## Tasks / Subtasks

- [x] **Task 1 — `ListCustomersQueryDto`** (AC: #2, #8)
  - [x] `src/customers/dto/list-customers-query.dto.ts` — optional `q` and optional `cursor`, both `@IsOptional()` `@IsString()` `@Transform(trim)`; `@MaxLength(100)` on `q`. Documented with `@ApiPropertyOptional`.
  - [x] No `limit`/page-size param — page size fixed at 50.
- [x] **Task 2 — list item shape + service method** (AC: #1, #2, #3, #4, #5, #7)
  - [x] Added `CustomerListItem` interface + `PAGE_SIZE = 50` (and a typed `CustomerListRow` for the DB select) to `customers.service.ts`
  - [x] `listCustomers(owner, query): Promise<PaginatedResponse<CustomerListItem>>`
  - [x] `if (!owner.tenantId)` → `BadRequestException` `VALIDATION_ERROR`
  - [x] Keyset query: `.eq('tenant_id', …)`, optional sanitized search `.or()`, optional cursor `.or()`, `.order('created_at',{ascending:false})`, `.order('id',{ascending:false})`, `.limit(PAGE_SIZE + 1)`
  - [x] Fetch `PAGE_SIZE + 1`; trim extra, `nextCursor = encodeCursor(last.id, last.created_at)` when `hasMore`, else `null`
  - [x] Map rows → `CustomerListItem` with `jobCount: 0`, `lastJobDate: null`
  - [x] Returns `new PaginatedResponse(items, nextCursor)`
- [x] **Task 3 — sanitize `q`** (AC: #2, #3 — security/correctness)
  - [x] Private `sanitizeSearchTerm(q)`: strips PostgREST structural chars `, ( ) . : *` + backslash, escapes `%`/`_`; empty result → no search filter. Unit-tested with `a,b)c%_d`.
- [x] **Task 4 — controller `GET` handler** (AC: #1, #6, #9)
  - [x] `@Get()` on `customers.controller.ts`: `@Roles(Role.OWNER)`, `@HttpCode(HttpStatus.OK)`, `@ApiOperation`, `@ApiResponse` (200/400/401/403)
  - [x] `listCustomers(@CurrentUser() user, @Query() query: ListCustomersQueryDto)`
- [x] **Task 5 — Unit tests** (AC: #1–#5, #7)
  - [x] `customers.service.spec.ts` +9 tests: mapped list (jobCount 0/lastJobDate null), empty page, nextCursor set on `PAGE_SIZE+1`, search `.or()` string asserted, sanitization asserted, cursor `.or()` asserted, malformed cursor → 400, no-tenant → 400, DB error → 500.
- [x] **Task 6 — E2E tests** (AC: #1–#9)
  - [x] `test/customers.e2e-spec.ts` +8 `GET` tests: 200 list + shape, 200 empty, 200 `q` (asserts `.or()`), 200 cursor (asserts keyset `.or()`), 400 malformed cursor, 403 technician, 400 no-tenant, 401 no JWT.
  - [x] Chainable builder mock (`from().select().eq().or().order().order().limit()` → `{data,error}`), no `.single()`.
- [x] **Task 7 — Verify** (AC: all)
  - [x] `bun run build` clean
  - [x] `bun run test` (74/74) + e2e (`62 passed, 2 skipped`) green, no regressions
  - [x] eslint: `customers.service.ts` fully clean (typed DB rows — cleaner than `skills.service.ts` baseline); spec/e2e carry only the accepted `no-unsafe`/`unbound-method` baseline patterns

### Review Findings (code review 2026-06-21)

- [x] [Review][Patch] Forged cursor can inject PostgREST filter syntax into the `.or()` string — FIXED: `decodeCursor` now requires `id` to match a UUID regex and `createdAt` to match an ISO-timestamp charset (`[0-9T:.+\-Z ]`, excludes `,()`+letters) and `Date.parse` valid; throws the existing 400 otherwise. New `cursor.util.spec.ts` + service/e2e tests assert forged/injection cursors → 400. (source: blind, High)
- [x] [Review][Patch] AC#5 "no duplicates or gaps across pages" only asserted at `.or()`-string level — FIXED: added unit test with 51 rows sharing a `created_at` tie at the boundary; asserts page=50, `hasMore`, and `nextCursor` decodes to the 50th returned row's `id`/`createdAt`. (sources: edge+auditor, Med)
- [x] [Review][Patch] AC#3 partial-phone search never tested with digits — FIXED: added `q=9833` unit + e2e tests asserting the `phone_number.ilike` filter. (sources: edge+auditor, Low)
- [x] [Review][Patch] `sanitizeSearchTerm` over-strips `.` and `:` — FIXED: strip set narrowed to `, ( ) *` (+ backslash); `.`/`:` preserved. Unit test updated to assert a `St. John`-style term survives. (source: blind, Low)
- [x] [Review][Patch] `cursor` query param has no `@MaxLength` — FIXED: added `@MaxLength(512)`. (source: blind, Low)

## Dev Notes

### Builds directly on Story 2.1 (done)

The `customers` table, `CustomersModule`, `CustomersService`, `CustomersController`, and `CreateCustomerDto` already exist and are wired. This story ADDS a `GET` list endpoint to the same controller/service — no new module, no new migration. [Source: src/customers/customers.service.ts, src/customers/customers.controller.ts]

Reuse, do not reinvent:
- `PaginatedResponse<T>` — `{ data, nextCursor, hasMore }`, `hasMore` derived from `nextCursor !== null`. [Source: src/common/dto/paginated-response.dto.ts]
- `encodeCursor(id, createdAt)` / `decodeCursor(cursor)` — base64url JSON `{ id, createdAt }`; `decodeCursor` already throws `BadRequestException` `VALIDATION_ERROR` on malformed input (satisfies AC#8 for free — just call it). [Source: src/common/utils/cursor.util.ts]
- Owner-only + no-tenant guard, `createAdmin()` client, snake→camel mapping — all mirror `createCustomer`. [Source: src/customers/customers.service.ts:34-74]

### This is the FIRST cursor-paginated endpoint in the codebase

No prior list endpoint uses cursors (skills list returns a plain array). Establish the pattern cleanly here; Stories 2.3, 3.2, 4.1 will follow it.

### Query construction (verified against supabase-js / PostgREST docs 2026-06-21)

Sort: `created_at DESC, id DESC` (id is the tiebreaker for stable keyset paging). Page size 50; fetch 51 to detect `hasMore`.

```ts
const admin = this.supabaseClientFactory.createAdmin();
let qb = admin
  .from('customers')
  .select('id, name, country_code, phone_number, city, created_at')
  .eq('tenant_id', owner.tenantId);

const term = query.q ? this.sanitizeSearchTerm(query.q) : '';
if (term) {
  // NOTE: inside .or() the wildcard is '*', NOT '%'. PostgREST translates '*' → '%'.
  qb = qb.or(`name.ilike.*${term}*,phone_number.ilike.*${term}*`);
}

if (query.cursor) {
  const c = decodeCursor(query.cursor); // throws 400 on malformed
  // keyset: rows strictly "after" the cursor under (created_at DESC, id DESC)
  qb = qb.or(`created_at.lt.${c.createdAt},and(created_at.eq.${c.createdAt},id.lt.${c.id})`);
}

const { data, error } = await qb
  .order('created_at', { ascending: false })
  .order('id', { ascending: false })
  .limit(PAGE_SIZE + 1);
```

**Verified facts (do not re-guess):**
- **Chained `.or()` calls AND together.** Each `.or()` appends a separate `or=(...)` query param; PostgREST combines multiple top-level params with AND. So `eq(tenant_id)` AND `or(search)` AND `or(cursor)` is correct — tenant scoping is never weakened by the search/cursor OR-groups. (Source: postgrest-js `or()` impl + PostgREST query semantics.)
- **`ilike` wildcard inside `.or()` is `*`.** The standalone `.ilike(col, '%x%')` method uses `%`, but inside the `.or()` filter STRING you must use `*` (PostgREST converts it). Using `%` inside `.or()` will not match as intended.
- The query builder is **awaited directly** (no `.single()` — we want an array). On error, map to `InternalServerErrorException` `INTERNAL_SERVER_ERROR` (mirror `createCustomer`’s generic branch).

### ⚠️ `.or()` is UNSANITIZED — `q` must be escaped (security + correctness)

postgrest-js `.or(filters)` appends the raw string to the URL with **no sanitization** (confirmed in source). A `q` containing PostgREST-structural characters (`,` `(` `)` `.` `:` `*`) can break the filter or inject extra OR conditions; `%`/`_` are LIKE metacharacters that distort matching. The tenant `eq` still ANDs, so this is not a cross-tenant leak, but it IS a correctness/robustness bug and must be closed now.

`sanitizeSearchTerm(q)` must:
- escape LIKE metacharacters `%` and `_` (prefix with `\`) so they match literally,
- remove/strip PostgREST-structural chars: `,` `(` `)` `.` `:` `*` and backslash that isn't part of an escape,
- return the cleaned term (already trimmed by the DTO). If empty after cleaning, the caller skips the search `.or()` entirely.

Add a focused unit test feeding `q` like `a,b)c%_` and asserting the resulting `.or()` argument is well-formed (no stray structural chars, `%`/`_` escaped).

### Phone is split (carried over from 2.1)

`customers` has `country_code` + `phone_number`, not a single `phone`. The epic’s "search on phone" → search `phone_number` (the digits without dial code). The list item returns `countryCode` + `phoneNumber` separately (consistent with the create response), NOT a combined E.164 string. [Source: supabase/migrations/20260621000001_create_customers_table.sql]

### `jobCount` / `lastJobDate` are placeholders this story

The `jobs` table does not exist until Epic 3. Return `jobCount: 0` and `lastJobDate: null` for every row — the epic explicitly establishes the response SHAPE now and backfills the values in Epic 3. Do NOT add a `jobs` join or reference. [Source: epics.md#Story 2.2 Implementation Notes]

### CustomerListItem shape

```ts
export interface CustomerListItem {
  id: string;
  name: string;
  countryCode: string;
  phoneNumber: string;
  city: string | null;
  jobCount: number;        // 0 until Epic 3
  lastJobDate: string | null; // null until Epic 3
}
```

### Scope boundaries

- List/search only. No customer detail + job history (that is Story 2.3).
- No mutation. No new migration. No `jobs` references.
- Page size is fixed at 50 — no client-controllable limit.

### Testing standards

- Unit: extend `customers.service.spec.ts`. Build a chainable mock where `from().select().eq()` returns a builder whose `.or()` returns itself, `.order()` returns itself, and `.limit()` resolves to `{ data, error }`. Capture `.or()` args to assert the search + cursor filter strings exactly.
- E2E: extend `test/customers.e2e-spec.ts`. The `whitelist:true, errorHttpStatusCode:422` ValidationPipe is already configured in `beforeAll`. The GET builder mock differs from the POST one (terminal is `.limit()` awaited, not `.single()`).
- Lint baseline: e2e/spec `no-unsafe-member-access` on `JSON.parse` and `unbound-method` on jest mocks are accepted (match `skills.*.spec.ts`).
- `IsUUID('4')` trap is irrelevant here (no UUID body fields).

### Project Structure Notes

- New file: `src/customers/dto/list-customers-query.dto.ts`.
- Modified: `src/customers/customers.service.ts` (+`listCustomers`, `CustomerListItem`, `sanitizeSearchTerm`, `PAGE_SIZE`), `src/customers/customers.controller.ts` (+`@Get()`), `src/customers/customers.service.spec.ts`, `test/customers.e2e-spec.ts`.
- No `app.module.ts` change (module already registered in 2.1).

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 2.2: List & Search Customers] — ACs + cursor encoding/sort spec
- [Source: _bmad-output/planning-artifacts/epics.md#FR-14] — list/search intent, page size 50
- [Source: _bmad-output/planning-artifacts/epics.md#NFR-3] — list endpoints p95 < 300ms (keyset paging + indexed sort supports this)
- [Source: src/common/utils/cursor.util.ts] — encode/decode + malformed-cursor 400
- [Source: src/common/dto/paginated-response.dto.ts] — response envelope
- [Source: src/customers/customers.service.ts] — Story 2.1 patterns to mirror (owner guard, createAdmin, mapping)
- [Source: 2-1-create-customer.md] — split-phone decision, lint baseline, createAdmin rationale
- [Source: postgrest-js docs via Context7, 2026-06-21] — chained `.or()` AND semantics, `ilike` `*` wildcard inside `.or()`, `.or()` is unsanitized

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m]

### Debug Log References

- Unit: `customers.service.spec.ts` 15/15 (9 new for `listCustomers`). E2E: `customers.e2e-spec.ts` 18/18 (8 new GET tests).
- Full regression: unit 74/74 (9 suites), e2e 62 passed + 2 skipped (7 suites). No regressions.
- `customers.service.ts` lints fully clean (typed `CustomerListRow` removes the `no-unsafe-assignment` warnings that `skills.service.ts` still carries).

### Completion Notes List

- Added `GET /api/v1/customers` (owner-only, cursor-paginated, page size 50) to the existing customers module — no new migration.
- **First cursor-paginated endpoint in the codebase.** Reuses `PaginatedResponse`, `encodeCursor`/`decodeCursor`. Keyset paging on `(created_at DESC, id DESC)`, fetch `PAGE_SIZE+1` to derive `hasMore`/`nextCursor`. `decodeCursor` gives AC#8 (malformed cursor → 400) for free.
- Search: `q` matches `name` OR `phone_number` (case-insensitive). Verified supabase-js specifics via Context7 before coding: chained `.or()` calls AND together (tenant scope preserved), and the ilike wildcard inside `.or()` is `*` not `%`.
- **Security:** `.or()` is unsanitized, so `sanitizeSearchTerm` strips PostgREST structural chars (`, ( ) . : *`, backslash) and escapes `%`/`_`. Unit test asserts `a,b)c%_d` → `abc\%\_d`.
- `jobCount: 0` / `lastJobDate: null` placeholders (jobs table arrives in Epic 3) — response shape established now.
- Scope held: list/search only, no detail/job-history (2.3), no mutations, no `jobs` references.

### File List

- `src/customers/dto/list-customers-query.dto.ts` (new)
- `src/customers/customers.service.ts` (modified — `listCustomers`, `sanitizeSearchTerm`, `CustomerListItem`, `CustomerListRow`, `PAGE_SIZE`)
- `src/customers/customers.controller.ts` (modified — `@Get()` handler)
- `src/customers/customers.service.spec.ts` (modified — +9 unit tests, +3 from review)
- `test/customers.e2e-spec.ts` (modified — +8 e2e tests, +2 from review)
- `src/common/utils/cursor.util.ts` (modified in review — UUID/ISO validation in `decodeCursor`)
- `src/common/utils/cursor.util.spec.ts` (new in review — `decodeCursor` validation/injection tests)

## Change Log

| Date       | Change                                                                 |
|------------|------------------------------------------------------------------------|
| 2026-06-21 | Story 2.2 implemented: `GET /api/v1/customers` (owner-only, cursor-paginated, name/phone search with sanitization). +9 unit, +8 e2e tests. Unit 74/74, e2e 62 pass/2 skip. Status → review. |
| 2026-06-21 | Code review (3 adversarial layers): 5 patches applied — hardened `decodeCursor` (UUID+ISO validation, closes cursor filter-injection), AC#5 keyset round-trip test, AC#3 phone-digit test, sanitizer no longer over-strips `.`/`:`, `cursor` `@MaxLength`. Added `cursor.util.spec.ts`. Unit 83/83, e2e 64 pass/2 skip. Status → done. |
