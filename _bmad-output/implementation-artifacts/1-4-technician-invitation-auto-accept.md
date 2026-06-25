---
baseline_commit: bd6b57d6ae706118e51072dc18e06576fa5f4935
---

# Story 1.4: Technician Invitation & Auto-Accept

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an owner,
I want to invite a technician by phone number with their name and skill type,
so that they can log in with OTP and automatically join my tenant as an active technician.

## Acceptance Criteria

1. **Invite created (201)** — Given a valid `phone`, `name`, and `skill_type`, when `POST /api/v1/auth/invite` is called by an Owner, then HTTP 201 with `{ invite_id }` and a `status: "invited"` User record is created scoped to the Owner's Tenant.

2. **Duplicate active member (409)** — Given the phone number is already an active member of the same Tenant, when `POST /api/v1/auth/invite` is called, then HTTP 409 with `error_code: "DUPLICATE_RESOURCE"`.

3. **Auto-accept on first OTP login (200)** — Given an invited phone number performing their first OTP login, when `POST /api/v1/auth/otp/verify` is called, then the User's `status` transitions `invited → active`, and the returned JWT contains the correct `tenantId` and `role: "technician"`.

4. **Technician forbidden (403)** — Given a Technician JWT, when `POST /api/v1/auth/invite` is called, then HTTP 403 with `error_code: "FORBIDDEN"`.

5. **Invalid skill_type (422)** — Given an invalid `skill_type` value not in the enum, when `POST /api/v1/auth/invite` is called, then HTTP 422 with `error_code: "VALIDATION_ERROR"`.

## Tasks / Subtasks

- [x] Task 1: DB migration — add `skill_type` column to `users` table (AC: 1, 3)
  - [x] 1.1 Create `supabase/migrations/20260620000001_add_skill_type_to_users.sql` — `ALTER TABLE users ADD COLUMN skill_type TEXT CHECK (skill_type IN ('ac_technician', 'pest_control', 'plumbing', 'electrical', 'general'));` (nullable, existing rows stay null). Apply via Supabase MCP.
  - [x] 1.2 Verify the column exists in the live DB via Supabase MCP `list_tables` with verbose=true.

- [x] Task 2: Create the `SkillType` enum and `InviteTechnicianDto` (AC: 5)
  - [x] 2.1 Create `src/auth/enums/skill-type.enum.ts` with `ac_technician | pest_control | plumbing | electrical | general`.
  - [x] 2.2 Create `src/auth/dto/invite-technician.dto.ts` using `@IsEnum(SkillType)`, `@IsString()` for `name` and `phone`, `@Matches(/^\+\d{7,15}$/)` for E.164 phone validation.

- [x] Task 3: Implement `AuthService.inviteTechnician()` (AC: 1, 2, 4)
  - [x] 3.1 Add `inviteTechnician(owner: RequestUser, dto: InviteTechnicianDto)` to `src/auth/auth.service.ts`.
  - [x] 3.2 Check if a user with `phone = dto.phone` already exists and is active in `owner.tenantId` — if so, throw `ConflictException` with `error_code: DUPLICATE_RESOURCE`. Use `createAdmin()` for queries (RLS blocks).
  - [x] 3.3 INSERT the new user row with `{ phone, name, role: 'technician', status: 'invited', tenant_id: owner.tenantId, skill_type: dto.skillType }`. If INSERT fails with Postgres unique constraint `23505` (duplicate phone), also throw `ConflictException` with `error_code: DUPLICATE_RESOURCE`.
  - [x] 3.4 Return `{ invite_id: newUser.id }`.
  - [x] 3.5 Add unit tests to `src/auth/auth.service.spec.ts` covering: 201 path (new invite), 409 path (active duplicate), 409 path (duplicate phone unique constraint), and service-role client usage.

- [x] Task 4: Modify `AuthService.verifyOtp()` for auto-accept (AC: 3)
  - [x] 4.1 In `verifyOtp()`, after `findOrCreateUser()` returns the user, check if `user.status === 'invited'`.
  - [x] 4.2 If `'invited'`: call `createAdmin()` and run `UPDATE users SET status = 'active', updated_at = now() WHERE id = user.id RETURNING id, phone, name, role, tenant_id, status, skill_type`. Overwrite `user` with the returned updated row.
  - [x] 4.3 Sign the JWT using the now-activated user's `tenant_id` and `role` (which were already correct from the invite INSERT — `tenant_id` is the owner's tenant, `role` is `'technician'`).
  - [x] 4.4 Add unit tests to `auth.service.spec.ts` for the auto-accept path: mock `findOrCreateUser` returning an `invited` user, expect the update call to fire, expect the returned JWT payload to contain `tenantId` and `role: 'technician'`.

- [x] Task 5: Wire the controller endpoint (AC: 1, 2, 4)
  - [x] 5.1 Add `POST auth/invite` handler to `src/auth/auth.controller.ts` — `@Roles(Role.OWNER)`, `@ApiBearerAuth()`, `@HttpCode(HttpStatus.CREATED)`.
  - [x] 5.2 Add `@ApiOperation` + `@ApiResponse` Swagger decorators (201, 403, 409, 422).

- [x] Task 6: E2E tests (AC: 1, 2, 3, 4, 5)
  - [x] 6.1 Create `test/invite.e2e-spec.ts` covering all 5 ACs: successful invite 201, active-member 409, auto-accept flow (invite → OTP verify → check JWT tenantId/role), technician 403, invalid skill_type 422.

- [x] Task 7: Verification
  - [x] 7.1 `bun run test` — all unit tests green (39/39 passing, up from 32).
  - [x] 7.2 `bun run test:e2e` — all e2e tests green (30 passed, 2 skipped RLS real-DB).
  - [x] 7.3 TypeScript build clean: `bun run build` exits 0.

## Dev Notes

### ⚠️ Critical Architecture Constraints

1. **RLS blocks JWT-scoped INSERT/UPDATE of `users`** — the `users_insert_only_service_role` policy has `WITH CHECK (false)`, and there is no UPDATE policy that the anon role can use. Always use `this.supabaseClientFactory.createAdmin()` for any `users` read/write in the invite and auto-accept flows. Never pass the caller's JWT to a factory-created client for these writes.

2. **No separate invites table** — the `users` table row with `status = 'invited'` IS the invite record. The `invite_id` returned in the 201 response is `users.id`. No new table, no new migration except the `skill_type` column.

3. **`findOrCreateUser` must not activate invited users** — `findOrCreateUser` is used by `verifyOtp`. The activation (invited → active UPDATE) must happen **after** `findOrCreateUser` returns but still within `verifyOtp`. Do NOT modify `findOrCreateUser` — it is correct to return an invited user as-is. The activation is `verifyOtp`'s responsibility.

4. **AR-10 does NOT apply here** — Invite is a single-table INSERT (no atomicity needed). Auto-accept is a single-table UPDATE (no atomicity needed). AR-10 mandates `supabase.rpc()` only when two tables must be written atomically; neither invite nor accept cross table boundaries.

5. **JWT shape on auto-accept** — the invited user's row already has `tenant_id = owner.tenantId` and `role = 'technician'` from the INSERT. After the `status = 'active'` UPDATE, these fields are unchanged. The JWT is signed from the fresh row returned by the UPDATE RETURNING clause: `{ sub: user.id, tenantId: user.tenant_id, role: user.role }`.

6. **Phone uniqueness** — `users.phone TEXT UNIQUE` (migration `20260619000001`). A single phone can only appear once. If an invited user from another tenant tries to verify OTP, their activation sets them to active in whatever `tenant_id` was stored at invite time — no conflict. Handle Postgres `23505` unique violation on invite INSERT as a 409.

### DB Migration

Create `supabase/migrations/20260620000001_add_skill_type_to_users.sql`:

```sql
-- Story 1.4: Add skill_type to users for technician invite
ALTER TABLE users
  ADD COLUMN skill_type TEXT
  CHECK (skill_type IN ('ac_technician', 'pest_control', 'plumbing', 'electrical', 'general'));
```

The column is nullable — existing `owner` rows and users created before this migration will have `skill_type = NULL`, which is correct. `CHECK` constraint only validates non-null values.

Apply via: `mcp__supabase__apply_migration` with the project ID from `list_projects`.

### `SkillType` Enum

Create `src/auth/enums/skill-type.enum.ts`:

```typescript
export enum SkillType {
  AC_TECHNICIAN = 'ac_technician',
  PEST_CONTROL = 'pest_control',
  PLUMBING = 'plumbing',
  ELECTRICAL = 'electrical',
  GENERAL = 'general',
}
```

### `InviteTechnicianDto` Specification

Create `src/auth/dto/invite-technician.dto.ts`:

```typescript
import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsString, MinLength, Matches } from 'class-validator';
import { SkillType } from '../enums/skill-type.enum';

export class InviteTechnicianDto {
  @ApiProperty({ example: '+911234567890', description: 'E.164 phone number' })
  @IsString()
  @Matches(/^\+\d{7,15}$/, { message: 'phone must be a valid E.164 number' })
  phone: string;

  @ApiProperty({ example: 'Ravi Kumar' })
  @IsString()
  @MinLength(1)
  name: string;

  @ApiProperty({ enum: SkillType, example: SkillType.AC_TECHNICIAN })
  @IsEnum(SkillType, { message: `skill_type must be one of: ${Object.values(SkillType).join(', ')}` })
  skillType: SkillType;
}
```

`@IsEnum` causes 422 `VALIDATION_ERROR` via the global `ValidationPipe` for any unknown value — AC5 is satisfied automatically.

### `inviteTechnician()` Implementation Guidance

Add to `src/auth/auth.service.ts`:

```typescript
async inviteTechnician(
  owner: RequestUser,
  dto: InviteTechnicianDto,
): Promise<{ invite_id: string }> {
  const admin = this.supabaseClientFactory.createAdmin();

  // Check for existing active member in this tenant
  const { data: existing } = await admin
    .from('users')
    .select('id, status')
    .eq('phone', dto.phone)
    .eq('tenant_id', owner.tenantId)
    .eq('status', 'active')
    .maybeSingle();

  if (existing) {
    throw new ConflictException({
      error_code: ErrorCode.DUPLICATE_RESOURCE,
      message: 'Phone number is already an active member of this tenant',
    });
  }

  const { data: newUser, error } = await admin
    .from('users')
    .insert({
      id: this.generateUuid(),
      phone: dto.phone,
      name: dto.name,
      role: Role.TECHNICIAN,
      status: 'invited',
      tenant_id: owner.tenantId,
      skill_type: dto.skillType,
    })
    .select('id')
    .single();

  if (error) {
    // Postgres unique violation on phone
    if (error.code === '23505') {
      throw new ConflictException({
        error_code: ErrorCode.DUPLICATE_RESOURCE,
        message: 'This phone number already has a pending invite',
      });
    }
    this.logger.error('Failed to create invite:', { error });
    throw new InternalServerErrorException('Failed to create invite');
  }

  return { invite_id: newUser.id };
}
```

Add `ConflictException` to `@nestjs/common` imports. Add `InviteTechnicianDto` and `SkillType` imports.

### Auto-Accept in `verifyOtp()` Guidance

In `verifyOtp()`, after the `findOrCreateUser` call, add:

```typescript
let resolvedUser = user;

if (user.status === 'invited') {
  const adminClient = this.supabaseClientFactory.createAdmin();
  const { data: activatedUser, error: updateError } = await adminClient
    .from('users')
    .update({ status: 'active', updated_at: new Date().toISOString() })
    .eq('id', user.id)
    .select('id, phone, name, role, tenant_id, status, skill_type')
    .single();

  if (updateError || !activatedUser) {
    this.logger.error('Failed to activate invited user:', { error: updateError });
    throw new InternalServerErrorException('Failed to activate invited user');
  }
  resolvedUser = activatedUser;
}

const token = await this.jwtService.signAsync({
  sub: resolvedUser.id,
  tenantId: resolvedUser.tenant_id ?? null,
  role: resolvedUser.role,
});
```

Replace the existing `const token = ...` block with this pattern — use `resolvedUser` instead of `user` when signing the JWT and building the response object.

### Controller Endpoint

Add to `src/auth/auth.controller.ts`:

```typescript
@Post('invite')
@Roles(Role.OWNER)
@ApiBearerAuth()
@HttpCode(HttpStatus.CREATED)
@ApiOperation({ summary: 'Invite a technician by phone number' })
@ApiResponse({ status: 201, description: 'Invite created', schema: { example: { invite_id: '550e8400-...' } } })
@ApiResponse({ status: 403, description: 'Forbidden — Technician JWT' })
@ApiResponse({ status: 409, description: 'Phone already an active member of this tenant' })
@ApiResponse({ status: 422, description: 'Validation error — invalid skill_type or phone format' })
async inviteTechnician(
  @CurrentUser() user: RequestUser,
  @Body() dto: InviteTechnicianDto,
) {
  return this.authService.inviteTechnician(user, dto);
}
```

Import `InviteTechnicianDto` from `./dto/invite-technician.dto`.

### `findOrCreateUser` Current Behavior — Do Not Break

`findOrCreateUser` is called by `verifyOtp`. It:
1. Queries `users` by phone via `supabaseClient`
2. If found → returns the user as-is (invited or active)
3. If not found → creates a new user with `role: 'owner'`, `status: 'active'`

For invited users: `findOrCreateUser` returns the row with `status: 'invited'`. Do not modify this method. The activation (UPDATE to `status: 'active'`) happens in `verifyOtp` **after** the call returns.

The existing `findOrCreateUser` signature uses a `SupabaseClient` argument — no change needed.

### E2E Test Guidance

`test/invite.e2e-spec.ts` pattern (follow `test/company.e2e-spec.ts` for bootstrap):

```typescript
// 1. Owner OTP login → get owner JWT (tenantId null, may need company setup first for tenantId)
// 2. POST /api/v1/auth/invite → 201 { invite_id }
// 3. POST /api/v1/auth/invite (same phone, same tenant, status active after step 2 is accepted) → ... actually need auto-accept first
// Auto-accept flow: POST /api/v1/auth/otp/send (for invited phone) → POST /api/v1/auth/otp/verify → check JWT tenantId & role

// For the 409 test: invite → activate → invite same phone again → 409
// For the 422 test: send invalid skill_type → 422
// For the 403 test: use technician JWT → 403
```

**Important**: E2e tests use `app.inject(...)` with Fastify, NOT `request(app.getHttpServer())`. Mock the Supabase client factory to avoid real DB calls in unit tests; e2e tests also need the mock factory pattern established in `test/company.e2e-spec.ts`.

### Updated Files List (for `findOrCreateUser` return type)

`findOrCreateUser` currently returns:
```typescript
{ id: string; phone: string; name: string | null; role: string; tenant_id: string | null; status: string; }
```

After Task 1 adds `skill_type`, update the return type annotation to include `skill_type: string | null`. This is needed for the UPDATE RETURNING in Task 4 to type-check correctly.

### Previous Story Intelligence (Stories 1.1–1.3)

**From 1.3 dev notes (directly applicable):**
- `createAdmin()` is the correct client for all `users` writes — JWT-scoped client is blocked by RLS.
- `ConflictException` from `@nestjs/common` → caught by global `GlobalExceptionFilter` → `{ statusCode: 409, error_code: "DUPLICATE_RESOURCE", message: "..." }`.
- `ErrorCode.DUPLICATE_RESOURCE` already exists in `src/common/enums/error-code.enum.ts`.
- `@CurrentUser()` extracts `RequestUser` from `request.user` — always use this, never `@Req()`.
- `@Roles(Role.OWNER)` alone satisfies the 403 AC — `RolesGuard` is global via `APP_GUARD`.
- Global `ValidationPipe` has `whitelist: true, transform: true, errorHttpStatusCode: 422` — `@IsEnum` violations automatically produce 422 with `VALIDATION_ERROR`.

**From 1.2 dev notes:**
- OTP mock mode: `isValid = true` always — any 6-digit code passes. This means auto-accept will trigger on any OTP verify for an invited phone.
- E2e test pattern: `app.inject({ method: 'POST', url: '/api/v1/auth/otp/verify', payload: { otpSessionId, otpCode: '123456' } })`.
- `setGlobalPrefix('api/v1')` must be called in e2e test bootstrap or the routes 404.

**From 1.1 dev notes:**
- Use `crypto.randomUUID()`, never the `uuid` npm package (ESM/Jest compatibility issue).
- `reflect-metadata` must be the very first import in `main.ts` — do not change this.

### Project Structure Notes

- All new enum file: `src/auth/enums/skill-type.enum.ts` — consistent with existing `src/common/enums/` pattern, but placed under `src/auth/` since it is auth-domain-specific.
- All new DTOs go in `src/auth/dto/` — consistent with existing pattern.
- Migration timestamp: `20260620000001` (date 2026-06-20, sequence 000001).
- Import `ConflictException` from `@nestjs/common` — it is included in the standard package, no new dependency needed.

### References

- [Source: `_bmad-output/planning-artifacts/epics.md#Story 1.4`] — ACs and implementation notes
- [Source: `supabase/migrations/20260619000001_create_users_table.sql`] — users table schema; `status IN ('active', 'invited')` already exists; `skill_type` column must be added
- [Source: `_bmad-output/planning-artifacts/architecture.md#AR-3`] — `SupabaseClientFactory` singleton; `create(jwt)` for RLS queries; `createAdmin()` for service-role writes
- [Source: `_bmad-output/planning-artifacts/architecture.md#AR-10`] — RPC mandate applies only to multi-table atomic writes; single-table INSERT/UPDATE is fine with `.from()`
- [Source: `_bmad-output/planning-artifacts/architecture.md#AR-13`] — Global guards: `JwtAuthGuard` + `RolesGuard`; `@Public()` bypasses JWT; `@Roles()` triggers role check
- [Source: `_bmad-output/planning-artifacts/architecture.md#AR-14`] — `ErrorCode` enum; global `ExceptionFilter` normalises error shape
- [Source: `src/auth/auth.service.ts`] — current `verifyOtp` and `findOrCreateUser` implementation to preserve
- [Source: `src/auth/auth.controller.ts`] — existing controller structure to follow
- [Source: `src/common/enums/error-code.enum.ts`] — `DUPLICATE_RESOURCE` already defined
- [Source: `project-context.md`] — Supabase MCP rules; migration files in `supabase/migrations/`; never two sequential `.from()` for atomic operations

## Dev Agent Record

### Agent Model Used

Claude Sonnet 4.6

### Debug Log References

No blocking issues. All implementation went smoothly.

### Completion Notes List

- Task 1: Applied migration `20260620000001_add_skill_type_to_users` to live Supabase project. Column verified via `list_tables` — nullable TEXT with CHECK constraint on 5 skill values.
- Task 2: Created `SkillType` enum at `src/auth/enums/skill-type.enum.ts` and `InviteTechnicianDto` at `src/auth/dto/invite-technician.dto.ts`. `@IsEnum(SkillType)` satisfies AC5 automatically via global ValidationPipe.
- Task 3: Added `inviteTechnician()` to AuthService. Uses `createAdmin()` (service role) for both the active-member check and the INSERT. Handles both 409 cases: explicit active-member query and Postgres 23505 unique constraint on phone.
- Task 4: Modified `verifyOtp()` to detect `status='invited'` after `findOrCreateUser` and run an UPDATE to activate the user. JWT is signed from the activated user row (tenantId + role already correct from invite INSERT). Updated `findOrCreateUser` return type and SELECT to include `skill_type`.
- Task 5: Added `POST auth/invite` controller endpoint with `@Roles(Role.OWNER)`, `@HttpCode(201)`, and full Swagger decorators.
- Task 6: Created `test/invite.e2e-spec.ts` with 11 e2e tests covering all 5 ACs. Auto-accept test uses OTP send → verify flow with sequential `from()` mock (call count tracking).
- Task 7: 39/39 unit tests, 30/30 e2e tests (2 skipped RLS real-DB), build clean.

### File List

- `supabase/migrations/20260620000001_add_skill_type_to_users.sql` (NEW)
- `src/auth/enums/skill-type.enum.ts` (NEW)
- `src/auth/dto/invite-technician.dto.ts` (NEW)
- `src/auth/auth.service.ts` (MODIFIED — added `inviteTechnician()`, updated `verifyOtp()` auto-accept, updated `findOrCreateUser` return type/select)
- `src/auth/auth.service.spec.ts` (MODIFIED — added `inviteTechnician` suite + auto-accept suite, updated mockUser to include `skill_type`)
- `src/auth/auth.controller.ts` (MODIFIED — added `POST auth/invite` endpoint)
- `test/invite.e2e-spec.ts` (NEW — 11 e2e tests for all ACs)

## Senior Developer Review (AI)

**Review Date:** 2026-06-20
**Review Outcome:** Changes Requested
**Layers:** Blind Hunter · Edge Case Hunter · Acceptance Auditor
**Dismissed:** 8 (false positives / by-design)

### Action Items

#### Decision-Needed

- [x] [Review][Decision] D1 — Phone API split deviates from spec: story spec says single `phone: @Matches(/^\+\d{7,15}$/)` field, but implementation uses `countryCode`+`phoneNumber`. This was a separate user request made after story creation. **Decision required:** Update the spec to match the implementation, or revert to single-field E.164 phone? [src/auth/dto/invite-technician.dto.ts, src/auth/dto/send-otp.dto.ts]
- [x] [Review][Decision] D2 — Global `UNIQUE(country_code, phone_number)` prevents same person from being invited to multiple tenants. The old `UNIQUE(phone)` had the same restriction. **Decision required:** Is a person allowed to be a technician in multiple tenants simultaneously, or is one-person-one-tenant the intended model? [supabase/migrations/20260620000002_split_phone_add_country_codes.sql]

#### Patches

- [x] [Review][Patch] P1 — Migration: no safety guard before `ALTER COLUMN SET NOT NULL` — if any user row has a phone with an unrecognized country code prefix, the migration fails and rolls back, destroying nothing but blocking deployment. Add `DO $$ BEGIN IF EXISTS (SELECT 1 FROM users WHERE country_code IS NULL) THEN RAISE EXCEPTION 'Unmatched phone prefixes found'; END IF; END $$;` before the NOT NULL alter. [supabase/migrations/20260620000002_split_phone_add_country_codes.sql]
- [x] [Review][Patch] P2 — `inviteTechnician` does not guard against `owner.tenantId = null`: an owner who has not completed company setup would insert a row with `tenant_id = null`, and the active-member check `.eq('tenant_id', null)` behaves unexpectedly (PostgREST may treat it as IS NULL). Add: `if (!owner.tenantId) throw new BadRequestException({ error_code: ErrorCode.VALIDATION_ERROR, message: 'Company setup required before inviting technicians' });` [src/auth/auth.service.ts:inviteTechnician]
- [x] [Review][Patch] P3 — `verifyOtp` auto-accept UPDATE has no idempotency guard: `UPDATE ... WHERE id = $1` fires even if `status` was already changed to `active` between the SELECT and the UPDATE. Change to `WHERE id = $1 AND status = 'invited'` and treat zero rows returned as a no-op (re-fetch the user). [src/auth/auth.service.ts:verifyOtp]
- [x] [Review][Patch] P4 — Postgres FK violation (`23503`) on `country_code` not handled: a client sending a valid-format but non-existent country code (e.g. `+19`) passes DTO validation, hits the INSERT, and gets an opaque 500 instead of a 422. Catch `error.code === '23503'` in `inviteTechnician` and throw `BadRequestException({ error_code: VALIDATION_ERROR, message: 'Invalid country code' })`. [src/auth/auth.service.ts:inviteTechnician]
- [x] [Review][Patch] P5 — `phoneNumber` minimum of 4 digits is too permissive for real E.164 numbers (ITU-T E.164 mandates ≥7 total digits including country code). Raise minimum to 6 digits: `@Matches(/^\d{6,15}$/)`. [src/auth/dto/send-otp.dto.ts, src/auth/dto/invite-technician.dto.ts]
- [x] [Review][Patch] P6 — 409 message for `23505` unique constraint says "pending invite" but the conflict may be cross-tenant (the same phone is already invited elsewhere globally). The message should be "This phone number is already registered" (neutral, no tenant info leaked). [src/auth/auth.service.ts:inviteTechnician]

#### Deferred

- [x] [Review][Defer] W1 — `verifyOtp` has `isValid = true` hardcoded (OTP not actually verified) — explicitly acknowledged as Phase 2 todo [src/auth/auth.service.ts:112] — deferred, pre-existing
- [x] [Review][Defer] W2 — `findOrCreateUser` concurrent INSERT race (TOCTOU on new phone): two simultaneous verifyOtp calls get PGRST116 then both attempt INSERT; the second gets 23505 and returns a 400 — deferred, pre-existing
- [x] [Review][Defer] W3 — `country_codes` seed maps `+1` to `iso2='US'` only; Canada (`+1`) is excluded; if `iso2` is ever used for routing or display, Canadian users will be misidentified — deferred, data quality
- [x] [Review][Defer] W4 — `name` field accepts whitespace-only strings (` `); `@MinLength(1)` passes with a single space — deferred, low priority
- [x] [Review][Defer] W5 — `invite_id` in response is the raw `users.id` UUID; leaks internal primary key space — deferred, by design for this phase

### Review Follow-ups (AI)

- [x] [AI-Review][Decision] D1 — Spec/implementation alignment: single `phone` vs split `countryCode`+`phoneNumber`
- [x] [AI-Review][Decision] D2 — Multi-tenant uniqueness: allow same phone in multiple tenants?
- [x] [AI-Review][Patch] P1 — Migration NOT NULL safety assertion
- [x] [AI-Review][Patch] P2 — Guard against null tenantId in inviteTechnician
- [x] [AI-Review][Patch] P3 — Auto-accept UPDATE: add WHERE status='invited' guard
- [x] [AI-Review][Patch] P4 — Handle 23503 FK error → 422 instead of 500
- [x] [AI-Review][Patch] P5 — phoneNumber minimum length: 4 → 6 digits
- [x] [AI-Review][Patch] P6 — Neutral 409 message for cross-tenant uniqueness conflict
