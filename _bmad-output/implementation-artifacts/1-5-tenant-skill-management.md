---
baseline_commit: cbf6518
---

# Story 1.5: Tenant Skill Management

Status: done

## Story

As an owner,
I want to define a custom list of skills for my company and manage them freely,
so that I can assign the right skill to each technician when inviting them.

## Acceptance Criteria

1. **Create skill (201)** — Given an authenticated Owner with `tenantId` in their JWT, when `POST /api/v1/skills` is called with a non-empty `name`, then HTTP 201 with `{ id, name, tenantId, createdAt }`.

2. **Duplicate skill name (409)** — Given a skill with the same name (case-insensitive) already exists for this tenant, when `POST /api/v1/skills` is called, then HTTP 409 with `error_code: "DUPLICATE_RESOURCE"`.

3. **List skills (200)** — Given an Owner with `tenantId`, when `GET /api/v1/skills` is called, then HTTP 200 with array of all skills for that tenant (can be empty array).

4. **Delete skill — no assigned technicians (200)** — Given a skill with no technicians assigned, when `DELETE /api/v1/skills/:id` is called, then HTTP 200 and the skill row is deleted.

5. **Delete skill — with assigned technicians (200)** — Given a skill assigned to one or more technicians, when `DELETE /api/v1/skills/:id` is called, then HTTP 200, the skill row is deleted, and all `user_skills` rows referencing it are cascade-deleted.

6. **Delete skill not owned by tenant (404)** — Given a `skillId` belonging to a different tenant, when `DELETE /api/v1/skills/:id` is called, then HTTP 404 with `error_code: "RESOURCE_NOT_FOUND"`.

7. **Technician forbidden (403)** — Given a Technician JWT, when any of `POST /GET /DELETE /api/v1/skills` is called, then HTTP 403 with `error_code: "FORBIDDEN"`.

8. **Auto-seed on company setup** — Given `serviceCategories: ["AC Technician", "Plumber"]` in `POST /api/v1/auth/company`, when the company is created for the first time (`created = true`), then corresponding rows are inserted into `tenant_skills` for that tenant. On idempotent re-call (`created = false`) no duplicate seeds are added.

9. **No tenantId guard** — Given an Owner JWT with `tenantId: null` (company not yet set up), when `POST /api/v1/skills` is called, then HTTP 400 with `error_code: "VALIDATION_ERROR"` and message `"Company setup required before managing skills"`.

## Tasks / Subtasks

- [x] Task 1: DB migration — create `tenant_skills` + `user_skills` tables, drop `skill_type` from `users` (AC: 1–6, 8)
  - [x] 1.1 Create `supabase/migrations/20260620000004_tenant_skills.sql`
  - [x] 1.2 Apply via Supabase MCP `apply_migration` and verify with `list_tables`.

- [x] Task 2: Create `SkillsModule` skeleton (AC: 7)
  - [x] 2.1 Create `src/skills/skills.module.ts`, `src/skills/skills.controller.ts`, `src/skills/skills.service.ts`.
  - [x] 2.2 Register `SkillsModule` in `AppModule`.
  - [x] 2.3 Wire `SupabaseClientFactory` into `SkillsService` (inject via constructor).

- [x] Task 3: Implement `POST /api/v1/skills` (AC: 1, 2, 7, 9)
  - [x] 3.1 Create `src/skills/dto/create-skill.dto.ts`
  - [x] 3.2 Implement `SkillsService.createSkill()`
  - [x] 3.3 Wire `POST skills/` in `SkillsController`

- [x] Task 4: Implement `GET /api/v1/skills` (AC: 3, 7)
  - [x] 4.1 Implement `SkillsService.listSkills()`
  - [x] 4.2 Wire `GET skills/` in controller

- [x] Task 5: Implement `DELETE /api/v1/skills/:id` (AC: 4, 5, 6, 7)
  - [x] 5.1 Implement `SkillsService.deleteSkill()`
  - [x] 5.2 Wire `DELETE skills/:id` in controller

- [x] Task 6: Auto-seed `tenant_skills` from `serviceCategories` on company setup (AC: 8)
  - [x] 6.1 Add seeding in `AuthService.setupCompany()` using upsert with `ignoreDuplicates: true`
  - [x] 6.2 Skip seeding on re-call (`created === false`)

- [x] Task 7: Unit tests for `SkillsService` (AC: 1–6, 8, 9)
  - [x] 7.1 Create `src/skills/skills.service.spec.ts`
  - [x] 7.2 Test `createSkill`: happy path, 23505 → 409, no tenantId → 400
  - [x] 7.3 Test `listSkills`: returns array, empty array, no tenantId → empty
  - [x] 7.4 Test `deleteSkill`: found → success; not found → 404; no tenantId → 400
  - [x] 7.5 Add tests to `auth.service.spec.ts` for auto-seed paths

- [x] Task 8: E2E tests (AC: 1–9)
  - [x] 8.1 Create `test/skills.e2e-spec.ts` — 11 tests covering all ACs

- [x] Task 9: Verification
  - [x] 9.1 `npx jest` — 53/53 unit tests green
  - [x] 9.2 `npx jest --config ./test/jest-e2e.json` — 41/41 e2e tests green
  - [x] 9.3 TypeScript build clean

## Dev Notes

### Architecture & Critical Constraints

**1. Always use `createAdmin()` for `tenant_skills` and `user_skills` writes.**
RLS is enabled on both tables but the JWT-scoped client may not have INSERT/DELETE policies set up for service-layer writes. Use `createAdmin()` (service role) consistently — exactly the same pattern as `inviteTechnician` and `findOrCreateUser` in `auth.service.ts`.

**2. `tenant_skills` RLS is for future mobile reads, not for this story's API layer.**
The skills APIs are owner-only backend endpoints that bypass RLS via `createAdmin()`. The RLS policies on `tenant_skills` are added now as a foundation for when the mobile app reads skills directly via Supabase client in future.

**3. Cascade delete is handled 100% by the DB FK.**
`user_skills.skill_id` has `ON DELETE CASCADE` referencing `tenant_skills.id`. When a skill row is deleted, all `user_skills` rows for that skill are automatically removed by Postgres. No application code needed to clean up `user_skills`.

**4. Case-insensitive uniqueness via `lower(name)` functional index.**
The UNIQUE constraint on `tenant_skills` is `UNIQUE (tenant_id, lower(name))`. The application does NOT need to normalize names — just insert as-is and catch `23505`. Do NOT call `.toLowerCase()` before insert; the DB handles it.

**5. `skill_type` column removal from `users`.**
Story 1.4 added `skill_type TEXT` to `users`. This story drops it. The migration must use `ALTER TABLE users DROP COLUMN IF EXISTS skill_type`. The `SkillType` enum (`src/auth/enums/skill-type.enum.ts`) created in Story 1.4 will be **deleted** in Story 1.6 when `invite` is updated to use `skillIds[]`. Do NOT delete it in this story — Story 1.6 owns that change.

**6. `InviteTechnicianDto.skillType` still exists after this story.**
Story 1.5 only adds skill management. The invite flow still uses the old `skillType` enum for now — Story 1.6 replaces it with `skillIds: UUID[]`. Do NOT touch `invite-technician.dto.ts` or `inviteTechnician()` in this story.

**7. `setupCompany` auto-seed implementation detail.**
The seeding loop runs after the RPC succeeds. Use individual inserts with `ON CONFLICT DO NOTHING` — do NOT use a single bulk insert that would fail entirely if one name conflicts. Pattern:

```typescript
if (created && dto.serviceCategories?.length) {
  for (const name of dto.serviceCategories) {
    await admin
      .from('tenant_skills')
      .insert({ id: this.generateUuid(), tenant_id: tenant.id, name })
      .throwOnError()   // remove throwOnError — use onConflict instead
  }
}
```

Correct pattern using Supabase's upsert:
```typescript
if (created && dto.serviceCategories?.length) {
  await admin
    .from('tenant_skills')
    .upsert(
      dto.serviceCategories.map(name => ({
        id: this.generateUuid(),
        tenant_id: tenant.id,
        name,
      })),
      { onConflict: 'tenant_id,lower(name)', ignoreDuplicates: true }
    );
  // Silently ignore errors — skill seeding failure must not fail company setup
}
```

**8. `SkillsModule` file locations.**
```
src/skills/
  skills.module.ts
  skills.controller.ts
  skills.service.ts
  skills.service.spec.ts
  dto/
    create-skill.dto.ts
```

**9. `ErrorCode` additions needed.**
`RESOURCE_NOT_FOUND` must exist in `src/common/enums/error-code.enum.ts`. Check before adding — it may already exist. Add only if missing.

**10. Response shapes.**

`POST /api/v1/skills` → 201:
```json
{ "id": "uuid", "name": "AC Technician", "tenantId": "uuid", "createdAt": "2026-06-20T..." }
```

`GET /api/v1/skills` → 200:
```json
[{ "id": "uuid", "name": "AC Technician", "tenantId": "uuid", "createdAt": "..." }]
```

`DELETE /api/v1/skills/:id` → 200:
```json
{ "success": true }
```

### Files to CREATE

| File | Purpose |
|------|---------|
| `supabase/migrations/20260620000004_tenant_skills.sql` | tenant_skills + user_skills tables, drop skill_type |
| `src/skills/skills.module.ts` | NestJS module |
| `src/skills/skills.controller.ts` | REST endpoints |
| `src/skills/skills.service.ts` | Business logic |
| `src/skills/skills.service.spec.ts` | Unit tests |
| `src/skills/dto/create-skill.dto.ts` | Validation DTO |
| `test/skills.e2e-spec.ts` | E2E tests |

### Files to MODIFY

| File | What changes |
|------|-------------|
| `src/app.module.ts` | Import `SkillsModule` |
| `src/auth/auth.service.ts` | Add auto-seed in `setupCompany()` |
| `src/auth/auth.service.spec.ts` | Add auto-seed tests |
| `src/common/enums/error-code.enum.ts` | Add `RESOURCE_NOT_FOUND` if missing |

### Files to NOT TOUCH

| File | Reason |
|------|--------|
| `src/auth/dto/invite-technician.dto.ts` | Story 1.6 owns this change |
| `src/auth/enums/skill-type.enum.ts` | Story 1.6 will delete this |
| `src/auth/auth.controller.ts` | No invite changes in this story |

### Previous Story Learnings (from Story 1.4)

- **Always check for `!owner.tenantId`** before any DB write — Story 1.4 added this guard to `inviteTechnician`. Same pattern needed in `createSkill`.
- **`createAdmin()` is required for all `users` writes** due to RLS. Same applies to `tenant_skills`.
- **Postgres error codes**: `23505` = unique violation → 409, `23503` = FK violation → 422/400.
- **Mock chain depth matters in tests**: Each `.eq()`, `.single()`, `.maybeSingle()` call needs its own mock layer. Spec tests in `auth.service.spec.ts` show the exact pattern.
- **E2E test structure**: See `test/invite.e2e-spec.ts` — override `SupabaseClientFactory` with `mockCreateAdmin`, build mock chain in a helper function, inject app with `ValidationPipe`.

### Migration SQL Reference

```sql
-- supabase/migrations/20260620000004_tenant_skills.sql

CREATE TABLE tenant_skills (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX tenant_skills_tenant_id_name_unique
  ON tenant_skills (tenant_id, lower(name));

CREATE TABLE user_skills (
  user_id   UUID NOT NULL REFERENCES users(id)         ON DELETE CASCADE,
  skill_id  UUID NOT NULL REFERENCES tenant_skills(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, skill_id)
);

-- Drop the old hardcoded column
ALTER TABLE users DROP COLUMN IF EXISTS skill_type;

-- RLS on tenant_skills
ALTER TABLE tenant_skills ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_skills_tenant_isolation"
  ON tenant_skills
  FOR ALL
  USING (tenant_id = (auth.jwt() ->> 'tenantId')::uuid)
  WITH CHECK (tenant_id = (auth.jwt() ->> 'tenantId')::uuid);

-- RLS on user_skills (via skill's tenant)
ALTER TABLE user_skills ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_skills_tenant_isolation"
  ON user_skills
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM tenant_skills ts
      WHERE ts.id = user_skills.skill_id
        AND ts.tenant_id = (auth.jwt() ->> 'tenantId')::uuid
    )
  );
```

## Dev Agent Record

### Completion Notes
<!-- Dev agent fills this in when done -->

### Debug Log
<!-- Dev agent fills this in during implementation -->

### Review Findings (2026-06-20)

#### Review Follow-ups Pass 1 (AI)

- [x] [Review][Patch] Wrong `onConflict` target for auto-seed — `'tenant_id,name'` must be `'tenant_id,lower(name)'` to match the functional index [src/auth/auth.service.ts]
- [x] [Review][Patch] `deleteSkill` delete query missing `tenant_id` filter — TOCTOU + no tenant fence on the actual mutation [src/skills/skills.service.ts:118]
- [x] [Review][Patch] `listSkills` returns `[]` when `tenantId` is null — should throw 400 like `createSkill`/`deleteSkill` for consistency [src/skills/skills.service.ts:71]
- [x] [Review][Patch] Seed upsert error silently discarded — no logging; add `const { error } = await ...` and `logger.warn` [src/auth/auth.service.ts:278]
- [x] [Review][Patch] `listSkills` silently returns `[]` on DB error — caller cannot distinguish empty tenant from DB failure; should throw 500 [src/skills/skills.service.ts:83]
- [x] [Review][Patch] `CreateSkillDto` missing `@IsNotEmpty()` — whitespace-only names (e.g. `"  "`) pass `MinLength(1)` [src/skills/dto/create-skill.dto.ts]
- [x] [Review][Patch] `serviceCategories` array items have no `MaxLength` per item — names > 100 chars inserted during seed bypassing the DTO limit [src/auth/dto/setup-company.dto.ts]
- [x] [Review][Patch] `DELETE /skills/:id` param not validated as UUID — malformed IDs cause PostgreSQL 22P02 instead of clean 400 [src/skills/skills.controller.ts:55]
- [x] [Review][Patch] Non-23505 DB error in `createSkill` throws 400 (caller's fault) — should be 500 (server fault) [src/skills/skills.service.ts:54]
- [x] [Review][Patch] AC7 e2e test checks status 403 but not `error_code: "FORBIDDEN"` body [test/skills.e2e-spec.ts]
- [x] [Review][Patch] No unit test coverage for `createSkill` generic DB error path [src/skills/skills.service.spec.ts]
- [x] [Review][Defer] RLS `user_skills_tenant_isolation` policy missing `WITH CHECK` clause — security hardening deferred per project policy
- [x] [Review][Defer] `DELETE` returns HTTP 200 with `{ success: true }` vs REST-conventional 204 — deliberate spec decision
- [x] [Review][Defer] `tenant_skills` RLS `FOR ALL` policy applies to admin client which bypasses RLS — known pattern, no impact on current code paths

#### Review Follow-ups Pass 2 (AI)

- [x] [Review][Patch] `deleteSkill` SELECT error silently discarded — `const { data: existing }` never destructures `error`; DB failure → misleading 404 [src/skills/skills.service.ts:111]
- [x] [Review][Patch] `@IsNotEmpty` does NOT reject whitespace-only strings (`"  "`) — added `@Transform(trim)` before validator [src/skills/dto/create-skill.dto.ts]
- [x] [Review][Patch] Seed names now lowercased in app before upsert — avoids reliance on PostgREST expression index support [src/auth/auth.service.ts]
- [x] [Review][Patch] `serviceCategories` items now trimmed via `@Transform` before validation [src/auth/dto/setup-company.dto.ts]
- [x] [Review][Patch] AC9 e2e test missing for `DELETE /skills/:id` with null tenantId [test/skills.e2e-spec.ts]
- [x] [Review][Patch] No unit test for `deleteSkill` when ownership SELECT itself fails (500 path) [src/skills/skills.service.spec.ts]
- [x] [Review][Defer] TOCTOU in deleteSkill (select+delete not atomic) — acceptable trade-off, deferred
- [x] [Review][Defer] RLS `user_skills` doesn't restrict `user_id = auth.uid()` — security, deferred per project policy

## Change Log

| Date | Change |
|------|--------|
| 2026-06-20 | Story created |
| 2026-06-20 | Code review complete — 11 patch items, 3 deferred |
