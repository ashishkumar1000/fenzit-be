---
baseline_commit: ccedc27875bfe2f262ded87cdb604d9cc85469ed
---

# Story 3.1: Create Job

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an owner,
I want to create a job for a customer and assign it to a technician,
so that the technician knows what to do, where, and when.

## Acceptance Criteria

1. **Given** valid required fields `customerId`, `serviceLocation`, `serviceType`, `scheduledStart`, `technicianId`, **when** `POST /api/v1/jobs` is called by an Owner, **then** HTTP 201 with the full job object including system-assigned `jobNumber` (`JB-2026-NNNN`), `status: "scheduled"`, `currentStep: null`, all echoed fields, `tenantId`, `createdAt`, `updatedAt`, and a `job_created` activity log entry persisted.

2. **Given** a `newCustomer` object whose `(countryCode, phoneNumber)` matches an existing Customer in the caller's Tenant, **when** `POST /api/v1/jobs` is called, **then** the existing Customer is **linked** (no duplicate created) and the job is created normally referencing that customer's `id`.

3. **Given** a `newCustomer` object whose `(countryCode, phoneNumber)` matches no existing Customer in the Tenant, **when** `POST /api/v1/jobs` is called, **then** a new Customer is auto-created with `createdVia: "job_creation"`, then the job is created referencing the new customer's `id`.

4. **Given** a `technicianId` that does not belong to the caller's Tenant (or is not a `technician`-role user), **when** `POST /api/v1/jobs` is called, **then** HTTP 404 with `error_code: "RESOURCE_NOT_FOUND"`.

5. **Given** a `customerId` that does not belong to the caller's Tenant, **when** `POST /api/v1/jobs` is called, **then** HTTP 404 with `error_code: "RESOURCE_NOT_FOUND"` (RLS-equivalent semantic; cross-tenant reference is treated as not-found, never 403).

6. **Given** a missing required field (e.g., `scheduledStart`), an invalid `serviceType` (not in enum), a malformed `scheduledStart` (not ISO 8601), a malformed UUID, OR neither/both of `customerId` and `newCustomer` supplied, **when** `POST /api/v1/jobs` is called, **then** HTTP 422 with `error_code: "VALIDATION_ERROR"`.

7. **Given** a Technician JWT, **when** `POST /api/v1/jobs` is called, **then** HTTP 403 with `error_code: "FORBIDDEN"`.

8. **Given** no `Authorization` header, **when** `POST /api/v1/jobs` is called, **then** HTTP 401 with `error_code: "UNAUTHORIZED"`.

9. **Given** an Owner JWT whose `tenantId` is `null` (company not yet set up), **when** `POST /api/v1/jobs` is called, **then** HTTP 400 with `error_code: "VALIDATION_ERROR"` and a message indicating company setup is required.

10. **Given** two jobs created by the same Tenant in the same IST calendar year, **when** their job numbers are assigned, **then** the numbers are strictly sequential with no gaps or duplicates (`JB-2026-0001`, `JB-2026-0002`), even under concurrent creation; a job created in the next IST calendar year restarts at `JB-2027-0001`.

## Tasks / Subtasks

- [x] **Task 1 — Database migrations: tables, RPCs, RLS, index** (AC: #1, #3, #4, #5, #10)
  - [x] FIRST: run Supabase MCP `list_tables` (project `pnlvreaijzslfymlnoti`) to confirm `jobs`, `activity_logs`, `job_sequences` do NOT exist and that `customers`, `users`, `tenants` are present with the columns referenced below.
  - [x] Create `supabase/migrations/20260621000002_create_jobs.sql` — `jobs` + `activity_logs` + `job_sequences` tables, RLS policies, and the `idx_jobs_tenant_id_scheduled_start` index (exact SQL in Dev Notes → "Migration SQL").
  - [x] Create `supabase/migrations/20260621000003_rpc_create_job_with_log.sql` — `increment_job_counter` and `create_job_with_log` RPCs (exact SQL in Dev Notes → "RPC SQL").
  - [x] Timestamp prefixes MUST sort AFTER the latest existing migration `20260621000001_create_customers_table.sql`.
  - [x] Apply BOTH migrations via Supabase MCP (`mcp__supabase__apply_migration`) against project `pnlvreaijzslfymlnoti` and verify each runs clean. Re-run `list_tables` (verbose) to confirm tables, FKs, CHECK constraints, and RLS are present.
- [x] **Task 2 — Job domain enums** (AC: #1, #6)
  - [x] `src/jobs/enums/service-type.enum.ts` — `ServiceType`: `ac_service | ac_installation | pest_control | plumbing | electrical | other`
  - [x] `src/jobs/enums/job-status.enum.ts` — `JobStatus`: `scheduled | in_progress | completed | cancelled`
  - [x] `src/jobs/enums/job-priority.enum.ts` — `JobPriority`: `normal | urgent`
  - [x] Enum string values MUST exactly match the DB CHECK constraint values in the migration.
- [x] **Task 3 — DTOs** (AC: #1, #6)
  - [x] `src/jobs/dto/new-customer.dto.ts` — `NewCustomerDto`: `name`, `countryCode`, `phoneNumber`, optional `address`, `city` — validators identical to `CreateCustomerDto` (`@Transform(trim)`, `@Matches(/^\+\d{1,4}$/)`, `@Matches(/^\d{6,15}$/)`). NOTE: the `trim` helper in `create-customer.dto.ts:11` is a file-local `const`, NOT exported — redefine the same one-liner at the top of `new-customer.dto.ts`.
  - [x] `src/jobs/dto/create-job.dto.ts` — `CreateJobDto` (full field list + validators in Dev Notes → "CreateJobDto"). Both `customerId` and `newCustomer` are `@IsOptional()`; the XOR rule is enforced in the service (AC #6).
- [x] **Task 4 — `CustomersService.findOrCreateByPhone()`** (AC: #2, #3)
  - [x] Add a new public method to `src/customers/customers.service.ts` (do NOT modify `createCustomer`): `findOrCreateByPhone(owner: RequestUser, input: NewCustomerInput): Promise<CustomerResponse>` — SELECT by `(tenant_id, country_code, phone_number)`; if found return it; else INSERT with `created_via: 'job_creation'`. Exact logic + `.single()` guard-ordering in Dev Notes.
  - [x] Export the `NewCustomerInput` shape (or reuse `NewCustomerDto`) so `JobsService` can call it.
- [x] **Task 5 — `JobsService.createJob()`** (AC: #1–#6, #9, #10)
  - [x] `src/jobs/jobs.service.ts` — orchestration described in Dev Notes → "JobsService.createJob flow". Inject `SupabaseClientFactory` and `CustomersService`.
  - [x] Resolve `customerId`: if `newCustomer` given → `customersService.findOrCreateByPhone(...)`; if `customerId` given → validate it belongs to the tenant (404 if not).
  - [x] Validate `technicianId` belongs to the tenant AND has `role = 'technician'` (404 if not).
  - [x] Compute IST creation year, call `create_job_with_log` RPC via `createAdmin()`, map snake_case row → camelCase `JobResponse`.
- [x] **Task 6 — `JobsController`** (AC: #1, #7, #8)
  - [x] `src/jobs/jobs.controller.ts` — `@Controller('jobs')`, `@ApiTags('Jobs')`, `@ApiBearerAuth()`; `@Post()` handler with `@Roles(Role.OWNER)`, `@HttpCode(HttpStatus.CREATED)`, full `@ApiResponse` set (201/400/403/404/422). Inject `@CurrentUser()` + `@Body()`.
- [x] **Task 7 — `JobsModule` + wiring** (AC: all)
  - [x] `src/jobs/jobs.module.ts` — `imports: [SupabaseModule, CustomersModule]`, declare controller + service, `exports: [JobsService]` (Stories 3.2–3.6 consume it).
  - [x] Register `JobsModule` in `src/app.module.ts` imports array (after `CustomersModule`).
- [x] **Task 8 — Unit tests** (AC: #1–#6, #9, #10)
  - [x] `src/jobs/jobs.service.spec.ts` — mock `SupabaseClientFactory.createAdmin()` and `CustomersService`. Cover: success (RPC returns job row → camelCase map, job_created assertion via RPC params), newCustomer-dedup link path, newCustomer-create path (`created_via: 'job_creation'`), technician-not-in-tenant → 404, customer-not-in-tenant → 404, XOR violation (neither/both) → 422, no-tenant owner → 400, RPC error → 500.
  - [x] `src/customers/customers.service.spec.ts` — add tests for `findOrCreateByPhone`: existing match returns it (no insert), no match inserts with `created_via: 'job_creation'`, generic error → 500.
- [x] **Task 9 — E2E tests** (AC: #1–#9)
  - [x] `test/jobs.e2e-spec.ts` — mirror `test/customers.e2e-spec.ts` harness (provider override of `SupabaseClientFactory` with `{ create, createAdmin }`, JWT helpers, `setGlobalPrefix('api/v1')`, `ValidationPipe({ errorHttpStatusCode: 422 })`). Mock the `.rpc()` + lookup `.from()` chains.
  - [x] Cover: 201 success (asserts `jobNumber` shape, `status: scheduled`, `currentStep: null`, `tenantId`), 404 bad technician, 404 bad customer, 422 invalid serviceType, 422 missing scheduledStart, 422 neither customerId nor newCustomer, 422 both supplied, 403 technician, 401 no JWT, 400 owner `tenantId: null`. Assert `error_code` on EVERY non-2xx case (Epic 2 review lesson).
- [x] **Task 10 — Verify** (AC: all)
  - [x] `bun run build` clean (0 TS errors).
  - [x] `bun run test` (unit) and the e2e suite green — no regressions vs Epic 2 baseline (unit 90/90; e2e 72 pass / 2 skip).
  - [x] `bunx eslint` on new files — only the codebase's accepted spec/e2e baseline warnings (`unbound-method`, `no-unsafe-member-access` on `JSON.parse`) may remain; `src/` production files clean.

### Review Findings (code review 2026-06-21)

Adversarial review (Blind Hunter + Edge Case Hunter + Acceptance Auditor). Auditor verdict: all 10 ACs implemented correctly and all Dev Notes constraints honored; findings are robustness + test-coverage gaps. No High-severity AC violations.

**Patches (to fix):**

- [x] [Review][Patch] RPC FK violation (`23503`) from a raced customer/technician delete is masked as a generic 500 — should be 404 RESOURCE_NOT_FOUND [src/jobs/jobs.service.ts:~155] (sources: blind+edge)
- [x] [Review][Patch] `findOrCreateByPhone` 23505 race re-read recurses unboundedly (no retry cap) — bound to a single retry then fail [src/customers/customers.service.ts:~243] (sources: blind+edge+auditor)
- [x] [Review][Patch] `scheduledEnd` before `scheduledStart` is accepted and persisted — add cross-field guard → 422 VALIDATION_ERROR [src/jobs/dto/create-job.dto.ts] (sources: blind+edge; beyond stated AC6 but a clear data-integrity gap feeding Story 3.2 date queries)
- [x] [Review][Patch] No unit assertion that optional fields (`priority`, `requireCompletionPhoto`, `scheduledEnd`, `description`, `notesForTechnician`) are passed through to the RPC — a dropped `?? false` would pass current tests [src/jobs/jobs.service.spec.ts] (source: edge)
- [x] [Review][Patch] AC6 lists "malformed UUID" and "malformed ISO date" but no e2e exercises them — add the two cases [test/jobs.e2e-spec.ts] (source: auditor)

**Deferred (logged to deferred-work.md):**

- [x] [Review][Defer] AC1 activity-log persistence & AC10 sequencing/race/rollover are verified only by the manual rollback-DB block, not a committed test (the RPC is mocked everywhere) — needs a real-DB integration test; CI has no DB (matches the existing AR-20 skipped-test infra gap) [src/jobs/jobs.service.spec.ts, test/jobs.e2e-spec.ts]
- [x] [Review][Defer] Job-number year (`p_year`) is computed app-side and trusted by the RPC — compute it inside the RPC from `now() AT TIME ZONE 'Asia/Kolkata'` to remove client-clock trust (Phase-1 single-instance hardening) [src/jobs/jobs.service.ts:~140, 20260621000003_rpc_create_job_with_log.sql]
- [x] [Review][Defer] `lpad(seq,4,'0')` silently widens `JB-YYYY-NNNN` to 5 digits past 9,999 jobs/tenant/year — document or cap the width (unlikely in Phase 1) [supabase/migrations/20260621000003_rpc_create_job_with_log.sql]

**Dismissed (6):** RLS policies ineffective under `createAdmin` (known/accepted C1, documented as defense-in-depth) · `newCustomer` address/city ignored on dedup-link (intended link-wins semantics) · `customerId: null` + `newCustomer` treated as newCustomer-only (explicit null == absent is a defensible convention) · `metadata` not written for `job_created` (column is nullable, not needed) · "success tests assert against the mock" (covered by the deferred integration test) · `crypto.randomUUID()` global (confirmed consistent with existing `createCustomer`).

## Dev Notes

### ⚠️ Architecture decision: follow the established service + `createAdmin()` pattern — do NOT introduce the repository abstraction

`architecture.md` (§1.1, AR-2) prescribes an abstract `BaseRepository<T>` / `JobRepository` + `SupabaseJobRepository` with `{ provide: JobRepository, useClass: ... }` wiring and "zero Supabase imports in services." **The actual Epic 1 & 2 codebase never adopted this** — every module (`auth`, `skills`, `customers`) uses a plain service that injects `SupabaseClientFactory` and calls `createAdmin()` directly. Story 2.1 dev notes and the Epic 2 retro explicitly ruled: *"do not switch to the repository/JWT-client pattern unilaterally — stay consistent with the codebase."* **Story 3.1 follows the established pattern: `JobsService` + `SupabaseClientFactory.createAdmin()`.** Do not create `jobs.repository.ts` / `supabase-jobs.repository.ts`. The RLS-vs-repository reconciliation remains deferred project-wide (C1). [Source: src/customers/customers.service.ts; _bmad-output/implementation-artifacts/2-1-create-customer.md#Why createAdmin(); epic-2-retro-2026-06-21.md#Key Insights]

### ⚠️ `createAdmin()` bypasses RLS — tenant isolation is enforced in the app layer + RPC params

`createAdmin()` uses the service-role key and **bypasses RLS entirely** (Epic 2 retro action #4, deferred item C1). Therefore:
- The `create_job_with_log` RPC runs under the service role with RLS off. It MUST set `tenant_id = p_tenant_id` explicitly on BOTH the `jobs` and `activity_logs` inserts (it does — see RPC SQL).
- `customerId` and `technicianId` are NOT protected by RLS on the write path. The service MUST validate each belongs to `owner.tenantId` **before** calling the RPC, returning `404 RESOURCE_NOT_FOUND` on mismatch (AC #4, #5). Never rely on the FK alone — a valid cross-tenant `customerId`/`technicianId` would otherwise leak into a job. Add the `customers_tenant_isolation` / `jobs` RLS policies anyway as defense-in-depth (consistent with every other table).

### ⚠️ Phone is split `(countryCode, phoneNumber)`, NOT single E.164 (epic FR-6/FR-13 text is stale)

Epic text says `new_customer` carries a single `phone`. **Stale.** Migration `20260620000002` split phone everywhere into `country_code` (FK → `country_codes.dial_code`) + `phone_number`, and `customers` uses `UNIQUE(tenant_id, country_code, phone_number)` (`customers_tenant_phone_unique`). `NewCustomerDto` MUST mirror `CreateCustomerDto`'s split-phone fields, and the dedup lookup MUST match on `(tenant_id, country_code, phone_number)`. Do NOT introduce a single `phone` field. [Source: src/customers/dto/create-customer.dto.ts; supabase/migrations/20260621000001_create_customers_table.sql]

### ⚠️ Request body is camelCase (reconcile stale snake_case epic naming)

Epic ACs use `new_customer`/`scheduled_start`. The entire API uses camelCase request bodies (`countryCode`, `phoneNumber`, `createdVia`). Story 3.1 body fields are camelCase: `customerId`, `newCustomer`, `serviceLocation`, `serviceType`, `scheduledStart`, `scheduledEnd`, `technicianId`, `requireCompletionPhoto`, `notesForTechnician`. DB columns stay snake_case; map at the service boundary.

### CreateJobDto

`src/jobs/dto/create-job.dto.ts` — both `customerId` and `newCustomer` optional at the DTO layer; XOR enforced in the service (AC #6). Reuse the trim transform helper used by `CreateCustomerDto`.

```ts
export class CreateJobDto {
  @ApiPropertyOptional({ description: 'Existing customer UUID. Mutually exclusive with newCustomer.' })
  @IsOptional()
  @IsUUID()                       // default version 'all' — NOT '4' (Epic 1 IsUUID('4') trap)
  customerId?: string;

  @ApiPropertyOptional({ type: () => NewCustomerDto, description: 'Inline customer to find-or-create. Mutually exclusive with customerId.' })
  @IsOptional()
  @ValidateNested()
  @Type(() => NewCustomerDto)
  newCustomer?: NewCustomerDto;

  @ApiProperty({ example: '12 MG Road, Bengaluru' })
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(500)
  serviceLocation: string;

  @ApiProperty({ enum: ServiceType })
  @IsEnum(ServiceType)
  serviceType: ServiceType;

  @ApiProperty({ example: '2026-06-22T09:30:00Z' })
  @IsISO8601()                    // accepts ISO 8601; invalid → 422
  scheduledStart: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  technicianId: string;

  @ApiPropertyOptional({ example: '2026-06-22T11:00:00Z' })
  @IsOptional() @IsISO8601()
  scheduledEnd?: string;

  @ApiPropertyOptional()
  @IsOptional() @Transform(trim) @IsString() @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ enum: JobPriority, default: JobPriority.NORMAL })
  @IsOptional() @IsEnum(JobPriority)
  priority?: JobPriority;

  @ApiPropertyOptional({ default: false })
  @IsOptional() @IsBoolean()
  requireCompletionPhoto?: boolean;

  @ApiPropertyOptional()
  @IsOptional() @Transform(trim) @IsString() @MaxLength(2000)
  notesForTechnician?: string;
}
```

Note: with `ValidationPipe({ whitelist: true, transform: true })`, `@ValidateNested()` + `@Type()` is required or `newCustomer` is stripped/unvalidated. The XOR check (neither or both → `VALIDATION_ERROR` 422) lives in the service, not the DTO.

### JobsService.createJob flow

```
createJob(owner: RequestUser, dto: CreateJobDto): Promise<JobResponse>
 1. if (!owner.tenantId) → BadRequestException { VALIDATION_ERROR, "Company setup required..." }   // AC #9 (400)
 2. XOR guard: if (!dto.customerId === !dto.newCustomer) →                                          // AC #6 (422)
       BadRequestException { VALIDATION_ERROR, "Provide exactly one of customerId or newCustomer" }
       (ensure this throws 422 — see "422 vs 400" note below)
 3. const admin = supabaseClientFactory.createAdmin()
 4. Resolve customer id:
      - if dto.newCustomer → customer = await customersService.findOrCreateByPhone(owner, dto.newCustomer); customerId = customer.id
      - else → validate existing: SELECT id FROM customers WHERE id = dto.customerId AND tenant_id = owner.tenantId
               (.single(); guard order below) → if not found → NotFoundException { RESOURCE_NOT_FOUND }   // AC #5
 5. Validate technician: SELECT id FROM users WHERE id = dto.technicianId AND tenant_id = owner.tenantId AND role = 'technician'
      (.single(); guard order below) → if not found → NotFoundException { RESOURCE_NOT_FOUND }            // AC #4
 6. const istYear = <current IST calendar year>   // see "IST year" below
 7. const { data, error } = await admin.rpc('create_job_with_log', {
        p_tenant_id: owner.tenantId, p_customer_id: customerId, p_technician_id: dto.technicianId,
        p_service_location: dto.serviceLocation, p_service_type: dto.serviceType,
        p_scheduled_start: dto.scheduledStart, p_scheduled_end: dto.scheduledEnd ?? null,
        p_description: dto.description ?? null, p_priority: dto.priority ?? 'normal',
        p_require_completion_photo: dto.requireCompletionPhoto ?? false,
        p_notes_for_technician: dto.notesForTechnician ?? null,
        p_actor_id: owner.userId, p_year: istYear,
     })
 8. if (error) → logger.error(...) → InternalServerErrorException { INTERNAL_SERVER_ERROR }
 9. const rows = data as JobRow[] | null; if (!rows?.length) → log + InternalServerErrorException   // RETURNS SETOF jobs ⇒ array
10. return toResponse(rows[0])   // snake_case → camelCase
```

**`.single()` guard-ordering invariant (Epic 2 retro #3 — non-obvious, document it as a code comment):** when checking a `.single()` lookup, test genuine DB error FIRST, then empty data:
```ts
if (error && error.code !== 'PGRST116') {           // real DB failure → 500, NOT 404
  this.logger.error(...); throw new InternalServerErrorException(...);
}
if (error?.code === 'PGRST116' || !data) {           // no row → 404
  throw new NotFoundException({ error_code: ErrorCode.RESOURCE_NOT_FOUND, message: '...' });
}
```
Do NOT collapse this into `(error || !data) → 404` — that masks `08006`-class errors as 404 (the exact bug caught in Story 2.3).

**IST year:** the `JB-{YYYY}` year is the IST creation year, not UTC. Compute with the same UTC+5:30 offset used by `getIstDayRange`:
```ts
const istNow = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
const istYear = istNow.getUTCFullYear();
```
(Or derive from `getIstDayRange().start`.) Pass as `p_year`. [Source: src/common/utils/ist-day-range.util.ts]

**422 vs 400:** `ValidationPipe` is configured with `errorHttpStatusCode: 422`, so DTO validation failures return 422. Business-rule guards thrown as `BadRequestException` return **400** by default. AC #6 (XOR + bad input) must be **422** and AC #9 (no tenant) must be **400**. The XOR guard therefore must NOT use a bare `BadRequestException` (that yields 400). Throw it as 422 explicitly, e.g. `throw new HttpException({ error_code: ErrorCode.VALIDATION_ERROR, message }, HttpStatus.UNPROCESSABLE_ENTITY)`. Keep the no-tenant guard as `BadRequestException` (400) to match `CustomersService.createCustomer`. [Source: src/customers/customers.service.ts; test/customers.e2e-spec.ts]

### CustomersService.findOrCreateByPhone()

Add to `src/customers/customers.service.ts` (new method — leave `createCustomer` untouched). This closes Epic 2 retro action #3 (the `created_via: 'job_creation'` write path that did not exist).

```ts
async findOrCreateByPhone(owner: RequestUser, input: NewCustomerDto): Promise<CustomerResponse> {
  if (!owner.tenantId) {
    throw new BadRequestException({ error_code: ErrorCode.VALIDATION_ERROR, message: 'Company setup required...' });
  }
  const admin = this.supabaseClientFactory.createAdmin();

  // 1. dedup lookup on (tenant_id, country_code, phone_number)
  const { data: existing, error: lookupErr } = await admin
    .from('customers')
    .select('id, name, country_code, phone_number, address, city, created_via, created_at, tenant_id')
    .eq('tenant_id', owner.tenantId)
    .eq('country_code', input.countryCode)
    .eq('phone_number', input.phoneNumber)
    .maybeSingle();                       // 0-or-1 row; no PGRST116 on empty
  if (lookupErr) { this.logger.error(...); throw new InternalServerErrorException(...); }
  if (existing) return this.toResponse(existing);   // AC #2 — link, no duplicate

  // 2. create with created_via = 'job_creation'  (AC #3)
  const { data, error } = await admin
    .from('customers')
    .insert({
      id: crypto.randomUUID(), tenant_id: owner.tenantId,
      name: input.name, country_code: input.countryCode, phone_number: input.phoneNumber,
      address: input.address ?? null, city: input.city ?? null,
      created_via: 'job_creation',
    })
    .select('id, name, country_code, phone_number, address, city, created_via, created_at, tenant_id')
    .single();
  if (error) {
    if (error.code === '23505') return this.findOrCreateByPhone(owner, input);  // race: re-read the winner
    if (error.code === '23503') throw new BadRequestException({ error_code: ErrorCode.VALIDATION_ERROR, message: 'Unknown country code' });
    this.logger.error(...); throw new InternalServerErrorException(...);
  }
  return this.toResponse(data);
}
```
Reuse the existing `CUSTOMER_COLUMNS` const (customers.service.ts:71) in both `.select(...)` calls and the existing private `toResponse()` mapper. The `23503` (unknown dial code → 422) catch mirrors the Story 2.1 review fix. The `23505` race re-read keeps the find-or-create idempotent under concurrency. [Source: src/customers/customers.service.ts:createCustomer; 2-1-create-customer.md#Review Findings]

### Migration SQL — `20260621000002_create_jobs.sql`

Run Supabase MCP `list_tables` first. Mirror the `customers` RLS template (`customers_tenant_isolation`).

```sql
-- ============ jobs ============
CREATE TABLE jobs (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_number                TEXT        NOT NULL,
  customer_id               UUID        NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  technician_id             UUID        NOT NULL REFERENCES users(id)     ON DELETE RESTRICT,
  service_location          TEXT        NOT NULL,
  service_type              TEXT        NOT NULL CHECK (service_type IN
                              ('ac_service','ac_installation','pest_control','plumbing','electrical','other')),
  scheduled_start           TIMESTAMPTZ NOT NULL,
  scheduled_end             TIMESTAMPTZ,
  status                    TEXT        NOT NULL DEFAULT 'scheduled'
                              CHECK (status IN ('scheduled','in_progress','completed','cancelled')),
  current_step              TEXT,
  priority                  TEXT        NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','urgent')),
  require_completion_photo  BOOLEAN     NOT NULL DEFAULT false,
  description               TEXT,
  notes_for_technician      TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- job_number unique per tenant per year-scope (sequence guarantees uniqueness; this is a safety net)
CREATE UNIQUE INDEX jobs_tenant_job_number_unique ON jobs (tenant_id, job_number);
-- list-by-day query support (Story 3.2)
CREATE INDEX idx_jobs_tenant_id_scheduled_start ON jobs (tenant_id, scheduled_start);

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "jobs_tenant_isolation" ON jobs FOR ALL
  USING (tenant_id = (auth.jwt() ->> 'tenantId')::uuid)
  WITH CHECK (tenant_id = (auth.jwt() ->> 'tenantId')::uuid);

-- ============ activity_logs (append-only) ============
CREATE TABLE activity_logs (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      UUID        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  tenant_id   UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_type  TEXT        NOT NULL,
  actor_id    UUID        NOT NULL REFERENCES users(id),
  metadata    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_activity_logs_job_id ON activity_logs (job_id, created_at);

ALTER TABLE activity_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "activity_logs_tenant_isolation" ON activity_logs FOR ALL
  USING (tenant_id = (auth.jwt() ->> 'tenantId')::uuid)
  WITH CHECK (tenant_id = (auth.jwt() ->> 'tenantId')::uuid);

-- ============ job_sequences (per-tenant per-year counter) ============
CREATE TABLE job_sequences (
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  year       INT  NOT NULL,
  last_seq   INT  NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, year)
);
ALTER TABLE job_sequences ENABLE ROW LEVEL SECURITY;
-- written only by the SECURITY DEFINER RPC under service role; no client policy needed.
```

Notes: `activity_logs` immutability is app-enforced for Phase 1 (no update/delete code paths). The `(tenant_id, year)` PK on `job_sequences` makes year rollover automatic — a new year inserts a fresh row starting at 1, so no reset/cron is needed (AR-12).

### RPC SQL — `20260621000003_rpc_create_job_with_log.sql`

```sql
-- Atomic, race-safe per-tenant/per-year counter
CREATE OR REPLACE FUNCTION increment_job_counter(p_tenant_id UUID, p_year INT)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_seq INT;
BEGIN
  INSERT INTO job_sequences (tenant_id, year, last_seq)
  VALUES (p_tenant_id, p_year, 1)
  ON CONFLICT (tenant_id, year)
  DO UPDATE SET last_seq = job_sequences.last_seq + 1
  RETURNING last_seq INTO v_seq;     -- ON CONFLICT row lock serializes concurrent callers ⇒ no gaps/dupes
  RETURN v_seq;
END $$;

-- Atomic job insert + job_created activity log; returns the created row
CREATE OR REPLACE FUNCTION create_job_with_log(
  p_tenant_id UUID, p_customer_id UUID, p_technician_id UUID,
  p_service_location TEXT, p_service_type TEXT,
  p_scheduled_start TIMESTAMPTZ, p_scheduled_end TIMESTAMPTZ,
  p_description TEXT, p_priority TEXT, p_require_completion_photo BOOLEAN,
  p_notes_for_technician TEXT, p_actor_id UUID, p_year INT
)
RETURNS SETOF jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_seq        INT;
  v_job_number TEXT;
  v_job_id     UUID := gen_random_uuid();
BEGIN
  v_seq := increment_job_counter(p_tenant_id, p_year);
  v_job_number := 'JB-' || p_year::text || '-' || lpad(v_seq::text, 4, '0');

  INSERT INTO jobs (
    id, tenant_id, job_number, customer_id, technician_id,
    service_location, service_type, scheduled_start, scheduled_end,
    status, current_step, priority, require_completion_photo,
    description, notes_for_technician
  ) VALUES (
    v_job_id, p_tenant_id, v_job_number, p_customer_id, p_technician_id,
    p_service_location, p_service_type, p_scheduled_start, p_scheduled_end,
    'scheduled', NULL, COALESCE(p_priority,'normal'), COALESCE(p_require_completion_photo,false),
    p_description, p_notes_for_technician
  );

  INSERT INTO activity_logs (job_id, tenant_id, event_type, actor_id)
  VALUES (v_job_id, p_tenant_id, 'job_created', p_actor_id);

  RETURN QUERY SELECT * FROM jobs WHERE id = v_job_id;
END $$;
```

Both functions are `SECURITY DEFINER` (called via the service-role `createAdmin()` client; they set `tenant_id` from the explicit `p_tenant_id` param). PostgREST wraps the RPC in a single transaction and the nested `increment_job_counter` call shares it — counter increment, job insert, and log insert are all atomic (AR-10). `RETURNS SETOF jobs` → supabase-js returns `data` as an array; read `data[0]` (matches the existing `setup_tenant_for_owner` array-handling pattern). [Source: src/auth/auth.service.ts RPC handling; supabase/migrations/20260619185741_create_tenants_and_rpc.sql]

### JobResponse shape (service return)

```ts
export interface JobResponse {
  id: string;
  jobNumber: string;
  tenantId: string;
  customerId: string;
  technicianId: string;
  serviceLocation: string;
  serviceType: ServiceType;
  scheduledStart: string;
  scheduledEnd: string | null;
  status: JobStatus;                 // always 'scheduled' on create
  currentStep: string | null;       // always null on create
  priority: JobPriority;
  requireCompletionPhoto: boolean;
  description: string | null;
  notesForTechnician: string | null;
  createdAt: string;
  updatedAt: string;
}
```

### Scope boundaries (do NOT over-build)

- **Create only.** No `GET /jobs`, no `GET /jobs/:id`, no `PATCH`, no workflow, no attachments — those are Stories 3.2–3.6. Do not add list/detail/pagination code here.
- The `jobs.updated_at` auto-update trigger and `idx_jobs_technician_id_updated_at` are **Epic 4 / Story 4.1** concerns. Add only the `updated_at` column (DEFAULT now()) here.
- The `workflow.service.ts`, `attachments.service.ts`, `idempotency_log`, and `current_step` advancement logic are later stories. `current_step` column exists but stays `NULL` on create.
- Do not backfill `jobCount`/`lastJobDate` (Story 3.2) or `jobHistory` (Story 3.3) — those are owned by their stories. (Their typed-empty placeholders already exist in the customers module.)
- Activity log immutability: app-enforced for Phase 1 — do not add UPDATE/DELETE revoke policies.

### Testing standards summary

- **Unit:** Jest, co-located `*.spec.ts`. Mock `SupabaseClientFactory.createAdmin()` with chained jest mocks. For `.rpc()`, mock `admin.rpc = jest.fn().mockResolvedValue({ data: [jobRow], error: null })`. For the two lookups (`customers`, `users`), use the `mockQuery`-style builder where `.eq()` returns the builder and `.single()`/`.maybeSingle()` resolves. Mock `CustomersService.findOrCreateByPhone` as a jest fn on the injected provider.
- **E2E:** `test/jobs.e2e-spec.ts`, picked up by `testRegex: ".e2e-spec.ts$"`. Override `SupabaseClientFactory` with `{ create: jest.fn(), createAdmin: mockCreateAdmin }`. Because both lookups AND the RPC go through the same `createAdmin()` client, return an object whose `from()` resolves the lookup rows and whose `rpc()` resolves the job row — use a small dispatcher (e.g., `from: jest.fn(() => lookupBuilder)`, `rpc: jest.fn().mockResolvedValue({ data: [jobRow], error: null })`). See `test/customers.e2e-spec.ts` `mockListResult`/`mockInsertResult` for the builder idiom.
- **422 vs 400:** validation failures (bad enum, missing field, malformed UUID/date, XOR) → 422; no-tenant business guard → 400. Assert `error_code` on every non-2xx response (Epic 2 review caught multiple assertion gaps).
- **`IsUUID` trap:** use `@IsUUID()` (default `'all'`), never `@IsUUID('4')`. [Source: epic-1-retro-2026-06-20.md]

### Project Structure Notes

- New module dir `src/jobs/` with `enums/`, `dto/`, `jobs.controller.ts`, `jobs.service.ts`, `jobs.module.ts`, `jobs.service.spec.ts` — layout parallel to `src/customers/`. No `*.repository.ts` files (see architecture decision above).
- `JobsModule` imports `CustomersModule` (already `exports: [CustomersService]`) to reuse `findOrCreateByPhone`. Register `JobsModule` in `src/app.module.ts` after `CustomersModule`. [Source: src/app.module.ts]
- `jobs` path is unused; no route conflicts.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 3.1: Create Job] — base AC + implementation notes (note phone-split + camelCase reconciliations above)
- [Source: _bmad-output/planning-artifacts/epics.md#FR-6] — create job contract; [#FR-11] activity log; [#FR-13] customer dedup intent
- [Source: _bmad-output/planning-artifacts/epics.md#AR-10] — RPC atomicity; [#AR-12] job sequence counter
- [Source: _bmad-output/planning-artifacts/architecture.md#1.1] — repository pattern (intentionally NOT adopted; see decision note)
- [Source: src/customers/customers.service.ts] — `createCustomer` / `toResponse` patterns to clone; add `findOrCreateByPhone` here
- [Source: src/skills/skills.service.ts] — canonical service create pattern (createAdmin, crypto.randomUUID, 23505→409)
- [Source: src/auth/auth.service.ts] — `.rpc()` invocation + array-result error handling pattern
- [Source: src/common/factories/supabase-client.factory.ts] — `create(jwt)` vs `createAdmin()`
- [Source: src/common/enums/error-code.enum.ts] — all error codes (no new codes needed: VALIDATION_ERROR, RESOURCE_NOT_FOUND, FORBIDDEN, UNAUTHORIZED, INTERNAL_SERVER_ERROR)
- [Source: src/common/utils/ist-day-range.util.ts] — IST offset for job-number year
- [Source: supabase/migrations/20260621000001_create_customers_table.sql] — customers table + RLS template
- [Source: supabase/migrations/20260619185741_create_tenants_and_rpc.sql] — plpgsql RPC conventions (p_ params, ON CONFLICT)
- [Source: test/customers.e2e-spec.ts] / [src/customers/customers.service.spec.ts] — test harness + mock cookbook
- [Source: project-context.md] — Supabase MCP usage + migration discipline (write .sql AND apply via MCP)
- [Source: _bmad-output/implementation-artifacts/epic-2-retro-2026-06-21.md] — action items #2 (PGRST116 guard-order), #3 (`created_via='job_creation'` gap), #4 (RPC tenant-isolation under service role)
- [Source: _bmad-output/implementation-artifacts/2-1-create-customer.md] — phone-split, createAdmin rationale, 23503→422 fix
- [Source: _bmad-output/implementation-artifacts/deferred-work.md#C1,#C2] — RLS bypass + unbounded TEXT (consistent here; DB length CHECKs still deferred)

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m]

### Debug Log References

- Supabase MCP `apply_migration` (project `pnlvreaijzslfymlnoti`): `create_jobs` → `{success:true}`; `rpc_create_job_with_log` → `{success:true}`. `list_tables` confirmed `jobs`, `activity_logs`, `job_sequences` created with RLS enabled, FKs to `tenants`/`customers`/`users`, CHECK constraints, and indexes.
- RPC correctness verified at the DB level via a rollback-wrapped `DO` block (Supabase MCP `execute_sql`): asserted `JB-2026-0001` → `JB-2026-0002` sequential, year rollover `JB-2027-0001`, `status='scheduled'` / `current_step=NULL`, `priority`/`require_completion_photo` passthrough, and 3 atomic `job_created` activity-log rows. Block ended with `RAISE EXCEPTION` to roll back; post-check confirmed 0 rows persisted (jobs/logs/seqs/tenants all 0).
- Unit: `jobs.service.spec.ts` 11/11, `customers.service.spec.ts` findOrCreateByPhone 6/6. Full unit suite 106/106 (11 suites).
- E2E: `jobs.e2e-spec.ts` 10/10. Full e2e suite 82 passed / 2 skipped (8 suites) — the 2 skips are the pre-existing real-DB RLS integration tests.

### Completion Notes List

- Implemented `POST /api/v1/jobs` (owner-only) following the established `JobsService` + `SupabaseClientFactory.createAdmin()` pattern. Deliberately did NOT adopt the architecture.md repository abstraction (consistent with Epics 1–2; decision documented in Dev Notes).
- Atomic job creation via two new SECURITY DEFINER RPCs: `increment_job_counter` (race-safe `ON CONFLICT … DO UPDATE … RETURNING` per-tenant/per-year counter; year rollover automatic via `(tenant_id, year)` PK) and `create_job_with_log` (job INSERT + `job_created` activity-log INSERT in one transaction, calling the counter internally). Job number = `JB-{istYear}-{NNNN}`, zero-padded, IST creation year.
- Tenant isolation enforced at the app layer (createAdmin bypasses RLS): service validates `customerId`/`technicianId` belong to the caller's tenant before the RPC (→ 404), and the RPC sets `tenant_id` from the explicit param on both inserts. RLS policies added on all three tables as defense-in-depth.
- New-customer dedup/auto-create handled by a new `CustomersService.findOrCreateByPhone()` (the only write path that sets `created_via: 'job_creation'`, closing Epic 2 retro action #3); reuses `CUSTOMER_COLUMNS` + `toResponse`, with `23505` race re-read and `23503` unknown-dial-code → 422.
- 422-vs-400 handled per spec: DTO validation + XOR violation → 422 (XOR thrown as an explicit `HttpException(422)`, since a bare `BadRequestException` would be 400); no-tenant business guard → 400.
- Applied Epic 2 retro guard-ordering invariant (genuine DB error → 500 FIRST, then empty → 404) on both lookups, documented inline.
- Scope held to create-only: no list/detail/PATCH/workflow/attachments, no `updated_at` trigger (Epic 4), `current_step` stays NULL.
- Lint: production files clean except one `no-unsafe-assignment` on the RPC result destructure in `jobs.service.ts` — identical to the accepted baseline in `auth.service.ts:268`. Spec/e2e files carry the codebase's accepted `unbound-method` / `no-unsafe-member-access` (JSON.parse) baseline; prettier applied.

### File List

- `supabase/migrations/20260621000002_create_jobs.sql` (new)
- `supabase/migrations/20260621000003_rpc_create_job_with_log.sql` (new)
- `src/jobs/enums/service-type.enum.ts` (new)
- `src/jobs/enums/job-status.enum.ts` (new)
- `src/jobs/enums/job-priority.enum.ts` (new)
- `src/jobs/dto/new-customer.dto.ts` (new)
- `src/jobs/dto/create-job.dto.ts` (new)
- `src/jobs/jobs.service.ts` (new)
- `src/jobs/jobs.controller.ts` (new)
- `src/jobs/jobs.module.ts` (new)
- `src/jobs/jobs.service.spec.ts` (new)
- `test/jobs.e2e-spec.ts` (new)
- `src/customers/customers.service.ts` (modified — added `findOrCreateByPhone` + `FindOrCreateCustomerInput`)
- `src/customers/customers.service.spec.ts` (modified — added `findOrCreateByPhone` tests)
- `src/app.module.ts` (modified — registered `JobsModule`)

## Change Log

| Date       | Change                                                                 |
|------------|------------------------------------------------------------------------|
| 2026-06-21 | Story 3.1 implemented: `jobs`/`activity_logs`/`job_sequences` migrations + `increment_job_counter`/`create_job_with_log` RPCs, `POST /api/v1/jobs` (owner-only) with new-customer dedup via `CustomersService.findOrCreateByPhone`, unit + e2e tests. Unit 106/106, e2e 82 pass/2 skip, build clean. Status → review. |
| 2026-06-21 | Code review (3 adversarial layers): 5 patches applied — RPC `23503`→404, bounded `findOrCreateByPhone` 23505 retry, `scheduledEnd<scheduledStart`→422, optional-field RPC-passthrough test, AC6 malformed-UUID/ISO e2e cases. 3 items deferred (J1 real-DB integration test, J2 in-RPC year, J3 >9999 width), 6 dismissed. Unit 110/110, e2e 85 pass/2 skip, build clean. Status → done. |
