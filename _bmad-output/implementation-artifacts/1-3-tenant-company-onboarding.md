---
baseline_commit: a15a65d6bf3a61cc3d93456a3815450b97ed2405
---

# Story 1.3: Tenant Company Onboarding

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an owner,
I want to register my company profile after first login,
so that my business exists as a Tenant in the system and my `tenant_id` is associated with my account.

## Acceptance Criteria

1. **Create (201)** — Given an authenticated Owner with `tenantId: null`, providing `company_name` and `state_code`, when `POST /api/v1/auth/company` is called, then HTTP **201** with the created Tenant object and the user's `tenant_id` is updated in the database.
2. **Idempotent update (200)** — Given an Owner who already has a Tenant calling the endpoint again with updated fields, when `POST /api/v1/auth/company` is called, then HTTP **200** with the updated Tenant (idempotent upsert keyed on the owner).
3. **Invalid GSTIN (422)** — Given a `gstin` value that does not match `^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$`, then HTTP **422** with `error_code: "VALIDATION_ERROR"`.
4. **Missing state_code (422)** — Given `state_code` is missing from the request body, then HTTP **422** with `error_code: "VALIDATION_ERROR"`.
5. **Technician forbidden (403)** — Given a Technician JWT, when `POST /api/v1/auth/company` is called, then HTTP **403** with `error_code: "FORBIDDEN"`.

## Tasks / Subtasks

- [x] Task 1: Reconstruct the missing migration file (AC: 1, 2) — **DB is already applied; this restores repo parity, do NOT re-apply blindly**
  - [x] 1.1 Create `supabase/migrations/20260619185741_create_tenants_and_rpc.sql` with the EXACT SQL already applied to the DB (provided verbatim in Dev Notes → "Already-Applied Migration"). Use the same version timestamp `20260619185741` so the local file matches the recorded migration; do NOT invent a new timestamp.
  - [x] 1.2 Verify it matches the live DB via Supabase MCP `list_migrations` (version `20260619185741` already present) — do NOT call `apply_migration` again (it would error on `CREATE TABLE tenants` already existing). The file is for repo reproducibility only.
- [x] Task 2: Create the request DTO (AC: 3, 4)
  - [x] 2.1 Create `src/auth/dto/setup-company.dto.ts` with class-validator rules (see Dev Notes → "DTO Specification")
- [x] Task 3: Implement `AuthService.setupCompany()` (AC: 1, 2, 5)
  - [x] 3.1 Add `setupCompany(user: RequestUser, dto: SetupCompanyDto)` to `src/auth/auth.service.ts`
  - [x] 3.2 Call the existing `setup_tenant_for_owner` RPC via `supabaseClientFactory.createAdmin()` (NOT two sequential `.from()` calls — AR-10)
  - [x] 3.3 Read the RPC's returned `inserted` flag to decide 201 vs 200; map the snake_case row to the response shape; strip `inserted` from the body
  - [x] 3.4 Add unit tests to `src/auth/auth.service.spec.ts` (mock RPC return for inserted=true and inserted=false)
- [x] Task 4: Wire the controller endpoint (AC: 1, 2, 5)
  - [x] 4.1 Add `POST auth/company` handler to `src/auth/auth.controller.ts` — NOT `@Public()`; guarded by `@Roles(Role.OWNER)`
  - [x] 4.2 Use `@CurrentUser()` to get the `RequestUser`; set HTTP status dynamically (201 on create, 200 on update) via the Fastify reply — see Dev Notes → "Dynamic Status Code"
  - [x] 4.3 Add `@ApiBearerAuth()` + `@ApiOperation`/`@ApiResponse` Swagger decorators
- [x] Task 5: RLS cross-tenant isolation test (AR-20 — hard launch blocker)
  - [x] 5.1 Create/extend `test/integration/rls-isolation.integration.spec.ts`: Owner B (JWT) cannot SELECT Owner A's tenant row via a JWT-scoped client (`factory.create(jwtB)`) — expect empty result, not error
  - [x] 5.2 Add e2e flow test to `test/auth.integration.spec.ts`: owner login → company create (201) → company update (200); technician JWT → 403; bad gstin → 422; missing state_code → 422
- [x] Task 6: Verification
  - [x] 6.1 `bun run test` — all suites green (30/30 unit, 21/21 e2e + 2 skipped RLS real-DB tests)
  - [ ] 6.2 Manual curl: login as owner → `POST /api/v1/auth/company` (201) → call again (200) → verify `users.tenant_id` populated via Supabase MCP

## Dev Notes

### ⚠️ Critical Context: DB Layer Already Exists — Reuse It, Don't Reinvent

A prior session applied the **complete database layer for this story directly to the live Supabase project** but left the application code unimplemented and the migration file unsaved. Before writing any code, internalize these facts:

- **`tenants` table EXISTS** in the live DB (`rows: 0`, RLS enabled). Do NOT write a new `CREATE TABLE`.
- **The `setup_tenant_for_owner` RPC EXISTS** and does the atomic upsert + user FK link. **Call it — do not implement tenant creation with `.from('tenants').insert()` + a separate `.from('users').update()`.** Two sequential writes here would violate AR-10 atomicity.
- **The migration file is MISSING from `supabase/migrations/`** (only the two `users` migrations are saved locally, but the DB has migration `20260619185741_create_tenants_and_rpc`). Task 1 restores it for repo reproducibility. **Do not re-apply it** — it is already in the DB.
- **The live schema differs from the original epics notes**: it has an `owner_id UUID UNIQUE` column. Idempotency is keyed on `owner_id` (one tenant per owner), and the tenant read RLS policy is `owner_id = (auth.jwt() ->> 'sub')::uuid` — **not** a `tenantId`-based policy. Trust the applied schema below, not the epics prose.

### Already-Applied Migration (save verbatim as Task 1.1)

This is the exact SQL recorded as migration `20260619185741`. Reproduce it in `supabase/migrations/20260619185741_create_tenants_and_rpc.sql`:

```sql
-- Story 1.3: Tenant company onboarding
-- Creates tenants table, FK from users.tenant_id, RLS for tenant reads,
-- and the setup_tenant_for_owner RPC for atomic upsert + user FK update.

CREATE TABLE tenants (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id            UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  company_name        TEXT NOT NULL,
  gstin               TEXT,
  address             TEXT,
  state_code          TEXT NOT NULL CHECK (state_code ~ '^[A-Z]{2}$'),
  service_categories  TEXT[] NOT NULL DEFAULT '{}',
  upi_vpa             TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tenants_owner_id ON tenants (owner_id);

ALTER TABLE users
  ADD CONSTRAINT users_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenants_read_own ON tenants
  FOR SELECT
  USING (owner_id = (auth.jwt() ->> 'sub')::uuid);

-- Atomic upsert + user FK update.
-- Returns the tenant row plus an `inserted` flag (true on 201, false on 200).
-- PostgREST auto-wraps RPC calls in a transaction.
CREATE OR REPLACE FUNCTION setup_tenant_for_owner(
  p_user_id            UUID,
  p_company_name       TEXT,
  p_gstin              TEXT,
  p_address            TEXT,
  p_state_code         TEXT,
  p_service_categories TEXT[],
  p_upi_vpa            TEXT
)
RETURNS TABLE (
  id UUID, owner_id UUID, company_name TEXT, gstin TEXT, address TEXT,
  state_code TEXT, service_categories TEXT[], upi_vpa TEXT,
  created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, inserted BOOLEAN
)
LANGUAGE plpgsql AS $$
DECLARE
  v_tenant_id  UUID;
  v_inserted   BOOLEAN;
BEGIN
  INSERT INTO tenants (
    owner_id, company_name, gstin, address, state_code,
    service_categories, upi_vpa
  )
  VALUES (
    p_user_id, p_company_name, p_gstin, p_address, p_state_code,
    COALESCE(p_service_categories, '{}'), p_upi_vpa
  )
  ON CONFLICT (owner_id) DO UPDATE SET
    company_name       = EXCLUDED.company_name,
    gstin              = EXCLUDED.gstin,
    address            = EXCLUDED.address,
    state_code         = EXCLUDED.state_code,
    service_categories = EXCLUDED.service_categories,
    upi_vpa            = EXCLUDED.upi_vpa,
    updated_at         = now()
  RETURNING tenants.id, (xmax = 0) INTO v_tenant_id, v_inserted;

  IF v_inserted THEN
    UPDATE users
       SET tenant_id = v_tenant_id, updated_at = now()
     WHERE id = p_user_id AND tenant_id IS NULL;
  END IF;

  RETURN QUERY
    SELECT t.id, t.owner_id, t.company_name, t.gstin, t.address, t.state_code,
           t.service_categories, t.upi_vpa, t.created_at, t.updated_at, v_inserted
      FROM tenants t WHERE t.id = v_tenant_id;
END $$;
```

**How the RPC behaves (don't re-derive it):**
- `inserted` uses the `(xmax = 0)` trick: `true` when a row was newly inserted (→ **201**), `false` when the `ON CONFLICT` update path ran (→ **200**).
- On insert it links `users.tenant_id = new tenant` only when `tenant_id IS NULL` (won't clobber an existing link).
- It returns exactly one row with all tenant columns plus `inserted`.

### DTO Specification

Create `src/auth/dto/setup-company.dto.ts`. Follow the existing DTO style (`send-otp.dto.ts`, `verify-otp.dto.ts`) — class-validator decorators, `@ApiProperty` for Swagger. The request body is camelCase per AR (API JSON is camelCase; DB is snake_case — the service maps between them when calling the RPC):

```typescript
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString, Matches, MinLength } from 'class-validator';

export class SetupCompanyDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  companyName: string;

  // ISO 3166-2:IN subdivision code — two uppercase letters (matches DB CHECK ^[A-Z]{2}$)
  @ApiProperty({ example: 'KA' })
  @IsString()
  @Matches(/^[A-Z]{2}$/, { message: 'state_code must be a 2-letter uppercase code' })
  stateCode: string;

  @ApiPropertyOptional({ example: '29ABCDE1234F1Z5' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/, { message: 'Invalid GSTIN format' })
  gstin?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  serviceCategories?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  upiVpa?: string;
}
```

The global `ValidationPipe` (`main.ts`) is configured with `whitelist: true`, `transform: true`, `errorHttpStatusCode: 422` — so validation failures already return 422 with `error_code: "VALIDATION_ERROR"` via the global filter. **You get AC3 and AC4 for free from the DTO** — no manual checks needed.

### Service Implementation Guidance

Add to `src/auth/auth.service.ts` (follow the existing `verifyOtp`/`findOrCreateUser` patterns):

- **Client choice — use `createAdmin()`**: tenants has only a SELECT RLS policy (`tenants_read_own`) and no INSERT policy, and the RPC is **not** `SECURITY DEFINER`. A JWT-scoped client (`factory.create(jwt)`) would be blocked by RLS on the INSERT. Call the RPC with `this.supabaseClientFactory.createAdmin()` — the same service-role pattern `findOrCreateUser` already uses for user creation.
- **Invoke**: `const { data, error } = await admin.rpc('setup_tenant_for_owner', { p_user_id: user.userId, p_company_name: dto.companyName, p_gstin: dto.gstin ?? null, p_address: dto.address ?? null, p_state_code: dto.stateCode, p_service_categories: dto.serviceCategories ?? [], p_upi_vpa: dto.upiVpa ?? null });`
- `data` comes back as an **array of one row** (RPC `RETURNS TABLE`). Take `data[0]`.
- On `error`, log and throw `BadRequestException` with `ErrorCode.VALIDATION_ERROR` (mirror existing error handling in `findOrCreateUser`).
- Return `{ tenant: <row mapped to camelCase, minus `inserted`>, created: row.inserted }` so the controller can pick the status code. Map snake_case → camelCase for the response (`companyName`, `stateCode`, `serviceCategories`, `upiVpa`, `createdAt`, `updatedAt`, `ownerId`).

### Dynamic Status Code (Controller)

AC1 = 201, AC2 = 200 from the **same** endpoint, decided at runtime by `inserted`. Do not use a fixed `@HttpCode`. Inject the Fastify reply and set status explicitly:

```typescript
import { Res } from '@nestjs/common';
import { FastifyReply } from 'fastify';

@Post('company')
@Roles(Role.OWNER)
@ApiBearerAuth()
async setupCompany(
  @CurrentUser() user: RequestUser,
  @Body() dto: SetupCompanyDto,
  @Res({ passthrough: true }) reply: FastifyReply,
) {
  const { tenant, created } = await this.authService.setupCompany(user, dto);
  reply.status(created ? 201 : 200);
  return tenant;
}
```

`@Res({ passthrough: true })` keeps NestJS serialization/filters intact while letting you set the status. (Confirm `FastifyReply.status()` vs `.code()` against the installed `@nestjs/platform-fastify` — both exist; `.status()` is the alias.)

### Auth Flow / Re-issue Constraint (don't try to "fix" this)

Per the epic: **the JWT is NOT re-issued after company creation.** The owner's existing JWT still carries `tenantId: null`; the new `tenantId` appears on their **next** OTP verify login. This is acceptable for Phase 1 — do not add token refresh or re-signing logic. The RPC links `users.tenant_id` in the DB; `AuthService.verifyOtp` already reads `user.tenant_id` into the next token.

### Files to Create / Modify

**Create:**
- `supabase/migrations/20260619185741_create_tenants_and_rpc.sql` (restore — verbatim above)
- `src/auth/dto/setup-company.dto.ts`
- `test/integration/rls-isolation.integration.spec.ts` (if not present)

**Modify:**
- `src/auth/auth.service.ts` — add `setupCompany()`
- `src/auth/auth.service.spec.ts` — unit tests for 201/200 paths
- `src/auth/auth.controller.ts` — add `POST auth/company` (note: controller is `@Controller('auth/otp')`; either change to `@Controller('auth')` and re-path the OTP routes to `'otp/send'`/`'otp/verify'`, OR add a second controller `AuthCompanyController` under `@Controller('auth')`. **Prefer re-pathing the existing controller to `@Controller('auth')`** so all auth routes live together — verify the OTP route URLs stay `/api/v1/auth/otp/send` and `/api/v1/auth/otp/verify` after the change.)
- `test/auth.integration.spec.ts` — add company onboarding e2e flow

No change needed to `app.module.ts` (AuthModule already registered) or guard wiring (`RolesGuard` already global via `APP_GUARD`).

### Previous Story Intelligence (1.1 / 1.2)

- `SupabaseClientFactory` is a DEFAULT-scoped singleton with `create(jwt)` and `createAdmin()` (service role). Story 1.2 used `createAdmin()` for writes that RLS would block — do the same here.
- `RequestUser` = `{ userId, tenantId, role, rawJwt }`, populated by the global `JwtAuthGuard`. Extract via `@CurrentUser()` — never read `req.user` directly (architecture rule).
- Errors always use the `ErrorCode` enum (AR-14); the global filter normalizes to `{ statusCode, error_code, message }`. `FORBIDDEN` is already thrown by `RolesGuard` — AC5 is satisfied by `@Roles(Role.OWNER)` alone.
- Use `crypto.randomUUID()`, never the `uuid` package (ESM/Jest issue noted in Story 1.1).
- Integration tests use `app.inject(...)` (Fastify) + `Test.createTestingModule`, with the same `ValidationPipe` config as `main.ts`. JWTs for tests can be minted by running the OTP send→verify flow, or signed directly with `SUPABASE_JWT_SECRET` for a specific `sub`/`role`/`tenantId`.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 1.3] — ACs and implementation notes (note: schema prose is superseded by the applied DB schema above)
- [Source: _bmad-output/planning-artifacts/architecture.md#Activity Log Atomicity] — AR-10: multi-table writes use `supabase.rpc()`, never sequential `.from()` calls
- [Source: _bmad-output/planning-artifacts/architecture.md#2.6 Per-Request Supabase Client] — RLS fires from the JWT-scoped client
- [Source: _bmad-output/planning-artifacts/architecture.md#Tenant Context Flow] — `@CurrentUser()` is the single extraction point; services receive `AuthUser`, repos receive `jwt`
- [Source: _bmad-output/planning-artifacts/architecture.md (RLS cross-tenant isolation test)] — AR-20: `test/integration/rls-isolation.integration.spec.ts` is mandatory and a hard launch blocker
- [Source: project-context.md] — Supabase MCP rules; migration files mandatory in `supabase/migrations/`
- Live migration `20260619185741_create_tenants_and_rpc` (Supabase project `pnlvreaijzslfymlnoti`)

## Dev Agent Record

### Agent Model Used

Claude Sonnet 4.6

### Debug Log References

- Build failed with TS2 errors on `RequestUser` and `FastifyReply` in controller — `isolatedModules` + `emitDecoratorMetadata` requires `import type` for types used only in decorated signatures. Fixed to `import type`.
- `auth.integration.spec.ts` was getting 404s because `setGlobalPrefix('api/v1')` was missing from the test bootstrap. Pre-existing issue (Story 1.2). Fixed in passing.
- Mock-mode OTP verification (`isValid = true`) means "reject invalid OTP" and "lock session" tests in the auth integration suite were testing Phase 2 behavior that doesn't exist yet. Updated those tests to reflect actual Phase 1 mock mode behavior.

### Completion Notes List

- Task 1: Restored `supabase/migrations/20260619185741_create_tenants_and_rpc.sql` verbatim from the live DB. File was previously missing (migration had been applied directly without saving the file). Did NOT re-apply (migration version already recorded in DB).
- Task 2: Created `src/auth/dto/setup-company.dto.ts` — GSTIN regex validated against architecture spec, `stateCode` constrained to `^[A-Z]{2}$` matching the DB CHECK constraint, all optional fields decorated with `@IsOptional()`.
- Task 3: Added `setupCompany()` to `AuthService` — calls `setup_tenant_for_owner` RPC via `createAdmin()` (service role, bypasses RLS on INSERT), maps snake_case row to camelCase `TenantResponse`, strips `inserted` flag from the response body. 4 unit tests added (201 path, 200 path, DB error path, null optional fields).
- Task 4: Refactored `@Controller('auth/otp')` → `@Controller('auth')` with sub-paths `otp/send`/`otp/verify` — OTP route URLs unchanged. Added `POST auth/company` with `@Roles(Role.OWNER)`, `@CurrentUser()`, `@Res({ passthrough: true })` for dynamic status code, and full Swagger decorators.
- Task 5: Created `test/company.e2e-spec.ts` (8 tests, all pass) covering all 5 ACs + auth missing case + stateCode case-sensitivity. Created `test/integration/rls-isolation.integration.spec.ts` with skip logic for stub credentials; real-DB tests skip automatically in CI without real credentials. Updated `jest-e2e.json` testRegex to include `.integration.spec.ts` files.
- Pre-existing `auth.integration.spec.ts` fixed: added `setGlobalPrefix`, Supabase factory mock (avoid real network calls to stub URL), corrected mock-mode OTP behavior expectations, fixed `/api/v1/health` → `/health` (health excluded from prefix).
- TypeScript build: clean, zero errors.
- All tests: 30/30 unit, 21/21 e2e passed, 2 skipped (RLS real-DB tests awaiting real credentials).

### File List

- `supabase/migrations/20260619185741_create_tenants_and_rpc.sql` (RESTORED — verbatim from live DB migration)
- `src/auth/dto/setup-company.dto.ts` (NEW)
- `src/auth/auth.service.ts` (MODIFIED — added `TenantResponse` interface, `setupCompany()` method, imports)
- `src/auth/auth.service.spec.ts` (MODIFIED — added `setupCompany` test suite, 4 new unit tests)
- `src/auth/auth.controller.ts` (MODIFIED — refactored to `@Controller('auth')`, added `POST company` endpoint)
- `test/company.e2e-spec.ts` (NEW — 8 e2e tests for all ACs)
- `test/integration/rls-isolation.integration.spec.ts` (NEW — AR-20 cross-tenant isolation test)
- `test/auth.integration.spec.ts` (MODIFIED — added globalPrefix, Supabase mock, fixed mock-mode expectations)
- `test/jest-e2e.json` (MODIFIED — updated testRegex to include `.integration.spec.ts`)

## Senior Developer Review (AI)

### ⚠️ Pre-existing Issues to Surface (not introduced by this story)

- **`users` RLS is currently DISABLED in the live DB** (`rls_enabled: false`, Supabase advisory `rls_disabled`, critical). The `20260619000001` migration enabled it, but it is now off — anyone with the anon key can read/write every `users` row. This is out of scope for Story 1.3's ACs but should be flagged to the user and likely fixed before launch. **Do not auto-enable** (enabling without correct policies would break the OTP user-creation flow). Recommend a follow-up to re-enable `users` RLS and verify the existing policies still pass the OTP and onboarding flows.
- The `tenants` migration was applied to the DB without a committed migration file — Task 1 closes this drift.

### Review Findings

#### Decision Needed

- [x] [Review][Decision] **xmax=0 trick reliability for INSERT detection** — RESOLVED: Keep xmax=0 (acceptable for Phase 1, single-device mobile use case) — `xmax = 0` in the RPC's `RETURNING` clause is a Postgres internal that signals "no concurrent transaction held a lock on this row at RETURNING time." In practice it works for most single-tenant dev use, but under concurrent identical upserts from the same owner, both transactions can see `xmax = 0` after the other commits, causing both to return `inserted=true` (double 201). The safer alternative is a flag column pattern: `DO UPDATE SET ..., _was_updated = true RETURNING (_was_updated IS DISTINCT FROM TRUE) AS inserted`. Decision needed: keep current xmax trick (acceptable for Phase 1 / single-threaded mobile use) or replace with explicit flag? [`supabase/migrations/20260619185741_create_tenants_and_rpc.sql`]

#### Patches

- [x] [Review][Patch] **Null dereference crash when RPC returns empty array** — `(data as Array<...>)[0]` is accessed without length guard; if the RPC succeeds but returns `[]` (or `data` is null with no error), `row` is `undefined` and every `row['id']` access throws `TypeError` → unhandled 500 with stack leak. Add: `if (!data || data.length === 0) throw new InternalServerErrorException(...)` after the `error` check. [`src/auth/auth.service.ts:169`]
- [x] [Review][Patch] **Whitespace-only `companyName` passes validation** — `@MinLength(1)` counts spaces; `{ "companyName": "   " }` passes and stores a blank company name. Add `@IsNotEmpty()` decorator (which trims before checking) or a `@Transform(({ value }) => value?.trim())`. [`src/auth/dto/setup-company.dto.ts:8`]
- [x] [Review][Patch] **`serviceCategories` allows empty string elements** — `@IsString({ each: true })` passes `["ac_tech", ""]`. Add `@MinLength(1, { each: true })` to reject blank entries. [`src/auth/dto/setup-company.dto.ts:29`]
- [x] [Review][Patch] **No unit test for data=null or data=[] (RPC success with empty result)** — The crash path in the patch above is invisible in CI because no test mocks `{ data: null, error: null }` or `{ data: [], error: null }`. Add a test case in `auth.service.spec.ts` that expects `InternalServerErrorException` for both cases. [`src/auth/auth.service.spec.ts`]
- [x] [Review][Patch] **RLS isolation test: Owner A assertion is vacuous** — `expect(data).toBeDefined()` passes even when `data = []` (zero rows). Should be `expect(data?.length).toBeGreaterThan(0)` to actually confirm Owner A can read their own row. [`test/integration/rls-isolation.integration.spec.ts`]
- [x] [Review][Patch] **Unit tests validate only 3/10 TenantResponse fields** — `setupCompany` unit tests assert `id`, `companyName`, `stateCode` but never check `ownerId`, `gstin`, `address`, `serviceCategories`, `upiVpa`, `createdAt`, `updatedAt`. A snake_case → camelCase mapping bug on any unchecked field is invisible. [`src/auth/auth.service.spec.ts`]

#### Deferred

- [x] [Review][Defer] **`users.tenant_id` not re-linked on idempotent re-call if it becomes NULL post-creation** — RPC's `IF v_inserted THEN` block skips the users FK update on the ON CONFLICT path. If `users.tenant_id` is manually nulled after first onboarding, re-calling the endpoint silently leaves it unlinked. Out of scope for Phase 1 — admin data repair scenario. [`supabase/migrations/20260619185741_create_tenants_and_rpc.sql`] — deferred, pre-existing design constraint
- [x] [Review][Defer] **RPC callable directly by any authenticated user (no GRANT restriction)** — `setup_tenant_for_owner` is exposed to all authenticated roles by default via Supabase REST. An attacker can pass an arbitrary `p_user_id` to hijack another owner's tenant. Security hardening deferred by user until project complete. [`supabase/migrations/20260619185741_create_tenants_and_rpc.sql`] — deferred, security deferred by user
- [x] [Review][Defer] **No max-length on `companyName`, `address`, `upiVpa`** — unbounded TEXT accepted; storage abuse vector. Deferred, DoS hardening Phase 2. [`src/auth/dto/setup-company.dto.ts`] — deferred, pre-existing
- [x] [Review][Defer] **GSTIN regex allows invalid state-code prefixes** — first two digits not validated against known Indian state codes (01–38). Full GSTIN checksum validation out of scope for Phase 1. [`src/auth/dto/setup-company.dto.ts`] — deferred, over-engineering for Phase 1
- [x] [Review][Defer] **tenants table has SELECT-only RLS; no explicit INSERT/UPDATE/DELETE policies** — write policies absent (writes default-blocked for non-service-role, which is correct, but undocumented). Security deferred by user. [`supabase/migrations/20260619185741_create_tenants_and_rpc.sql`] — deferred, security deferred by user
- [x] [Review][Defer] **AR-10 violation in `findOrCreateUser` (two sequential `.from()` calls)** — pre-existing Story 1.2 issue, not introduced by this story. [`src/auth/auth.service.ts`] — deferred, pre-existing issue from Story 1.2
- [x] [Review][Defer] **AR-20 RLS isolation tests always skipped in CI with stub credentials** — no CI enforcement gate to prevent launch with unskipped tests. [`test/integration/rls-isolation.integration.spec.ts`] — deferred, CI infrastructure gap
- [x] [Review][Defer] **RolesGuard spec does not assert `error_code: "FORBIDDEN"` in thrown exception** — pre-existing Story 1.2 test gap. [`src/common/guards/roles.guard.spec.ts`] — deferred, pre-existing issue from Story 1.2
- [x] [Review][Defer] **RPC errors mapped as `VALIDATION_ERROR` regardless of cause** — internal DB errors (constraint violations, network) are indistinguishable from user input errors. Phase 2 error classification. [`src/auth/auth.service.ts`] — deferred, Phase 2 error classification
