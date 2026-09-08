---
baseline_commit: 1f27221322dada2d4fe9e1155e534dc0ad71443a
---

# Story 3.9: /users/me — today-scoped, enriched profile jobs

Status: done

## Story

As an owner,
I want the profile payload to carry today's jobs with customer and technician names embedded,
so that the Home "Today & needs attention" section (fenzo-app 1-7) can render a real dispatch view without extra requests or on-device id→name joins.

## Design Contract

[Source: artifacts/planning-artifacts/ux-designs/ux-Fenzo-2026-09-05-home-todays-jobs/EXPERIENCE.md → "Data Contract"] — this story is items 1 and 2 of that contract. Item 3 (activity/attachment counts) is deliberately NOT built: nothing renders them.

**Cross-repo ordering (CLAUDE.md):** this change is ADDITIVE (new optional query param + new fields on profile job rows; no existing field renamed/removed) → this repo merges/deploys FIRST, then fenzo-app 1-7 switches on.

## Acceptance Criteria

1. **Given** `GET /users/me` is called with `jobsScope=today`, **then** the `jobs` page contains only jobs whose `scheduled_start` falls in the exclusive IST day window for today (same mechanics as `GET /jobs?scope=today`: `>= range.start` and `< range.end` from `getIstDayRange()`, anchored at noon IST for the day boundary).
2. **Given** `jobsScope` is omitted or `jobsScope=all`, **then** the payload is byte-compatible with today's behaviour (all jobs, `created_at DESC`, `profile-jobs` cursor) — the default path must not change shape or order.
3. **Given** `jobsScope` is any other value (e.g. `next-week`), **then** the global ValidationPipe rejects it with 422.
4. **Given** `jobsScope=today`, **then** the page sorts by `scheduled_start` ASC (dispatch order — soonest first) and paginates with a cursor scoped to `profile-jobs-today` (a cursor minted for one profile scope must be rejected on the other, same rule as the jobs-list cursor scopes).
5. **Given** any profile payload (owner or technician branch, any scope), **then** every row in `jobs.data` additionally carries:
   - `technician: { id, name, countryCode, phoneNumber, skills: string[] }` — always present (`technician_id` is NOT NULL, so unassigned jobs cannot exist — decision 2026-09-05); `skills` are the tenant's skill names (same resolution as the job-detail embed);
   - `customer: { id, name, countryCode, phoneNumber, address, city }`
   Both are the same shapes the `GET /jobs/:id` detail embed uses (`toDetailResponse`).
6. **Given** the embed assembly, **then** it is batched: the page's technician ids and customer ids are resolved with two `in`-filtered queries (+ skills resolution), never one query per row.
7. Unit tests cover: today-window filtering, default (`all`) unchanged, 422 on bad param, per-scope cursor rejection, embed present on every row, and sorting by `scheduled_start` ASC in today scope.

## Tasks / Subtasks

- [x] Task 1 — Query DTO (AC 3): `src/users/dto/get-profile-query.dto.ts` — add optional `jobsScope` (`@IsOptional() @Transform(trim) @IsEnum(['today', 'all'])`); mirror the trim-Transform pattern already in `list-jobs-query.dto.ts`.
- [x] Task 2 — Today scope in `listProfileJobs` (AC 1, 2, 4): `src/users/users.service.ts`
  - Accept `jobsScope` alongside `cursor`/`limit`; when `today`, add the IST day-window predicates (`getIstDayRange()` from jobs — import or reuse the shared helper, no new IST math) and switch sort to `scheduled_start` ASC with a new cursor scope constant `PROFILE_JOBS_TODAY_CURSOR_SCOPE = 'profile-jobs-today'` (mirrors `PROFILE_JOBS_CURSOR_SCOPE` at users.service.ts:35 and the `JOBS_CURSOR_SCOPE_BY_SCOPE` pattern in jobs.service.ts:177-186).
  - Default branch (`all`): untouched — same query, sort, cursor scope as today.
- [x] Task 3 — Embed assembly (AC 5, 6): in `users.service.ts`, after `pageRows` are selected:
  - Collect distinct `technician_id`s and `customer_id`s from the page.
  - Batch-fetch: users rows (`id, name, country_code, phone_number`, tenant-filtered), `user_skills` for those technician ids, tenant skills for name resolution (reuse the `TenantSkillEmbed` flattening already in `users.service.ts`), customers rows (`id, name, country_code, phone_number, address, city`, tenant-filtered).
  - Build `ProfileJobResponse = JobResponse & { technician: … | null; customer: … }` — new exported type next to the existing `ProfileResponse` (users.service.ts:86-94); do NOT widen `JobResponse` (GET /jobs must not change shape).
  - Update `ProfileResponse.jobs` / technician-branch typing to the new row type.
- [x] Task 4 — Controller (AC 1): `src/users/users.controller.ts` — pass `query.jobsScope` through to `getProfile` (the controller already binds `GetProfileQueryDto`). **No change needed** — the controller binds `GetProfileQueryDto` and passes the whole query object to `getMyProfile`, which reads `query.jobsScope` directly.
- [x] Task 5 — Tests (AC 7): extend `src/users/users.service.spec.ts` (and DTO test if one exists) per AC 7; reuse the spec's existing Supabase-query-builder mock patterns.

## Dev Notes

- **IST day window is a day boundary, not a time-of-day one** — copy the exact predicate shape from `listJobs`'s today branch (jobs.service.ts:554-556), anchored `getIstDayRange()` (default current IST day). There is no `date` re-anchor on `/users/me` — the Home section is always *today*; do not add a `date` param.
- **No status filter in the today window** — parity with `GET /jobs?scope=today`: completed/cancelled jobs in the window are returned and the FE filters them out of display. Do not pre-narrow server-side; that would make the payload lie about the window semantics established in Story 3-7.
- The technician branch (`users.service.ts:251-256`) uses the same `listProfileJobs` with `technicianId = self` — embeds flow there for free; no special-casing.
- `jobs.data` rows were previously unmodelled on the FE (`Paginated<unknown>`); nothing on the wire removes a field — the FE 1-7 story models the NEW shape. If delta-sync (Epic 4 BE stories, done) also consumes `listProfileJobs`, grep before changing its signature.
- Company-not-set-up early returns (users.service.ts:202, 212) already emit empty pages — leave their shape; empty `data: []` needs no embed.
- Testing: `bun run test` (never bare `bun test`); `bunx tsc --noEmit` must be clean.
- [Source: src/jobs/jobs.service.ts listJobs (514-636) + toResponse/toDetailResponse; src/users/users.service.ts listProfileJobs (393-447) + ProfileResponse (86-94); src/users/dto/get-profile-query.dto.ts; EXPERIENCE.md Data Contract; BE project-context.md (Supabase MCP rules — no migration needed, read-only change)].

### Review Findings

Full-mode review (blind-hunter, edge-case-hunter, verification-gap, acceptance-auditor), 2026-09-05. All `patch` findings applied in the same pass (tests 330/330, typecheck + eslint clean); findings kept below as the record.

- [x] [Review][Patch] Add `GET /users/me` + `PATCH /users/me` to `docs/api-contracts.md` (endpoint was absent entirely) — added a Users section documenting the role branches, embeds, `jobsScope` semantics, and 422.
- [x] [Review][Patch] Stale Swagger on `getMyProfile` — summary now mentions the per-row technician/customer embeds and `jobsScope=today`; 422 response added. [src/users/users.controller.ts]
- [x] [Review][Patch] Wrong "same mechanics as GET /jobs?scope=today" comment — the parity is the day WINDOW + no-status-filter only; the sort intentionally differs (GET /jobs keys created_at DESC, profile dispatch view keys scheduled_start ASC). Comment corrected; IST-midnight cursor-replay behaviour (short/empty page, never wrong rows) documented. [src/users/users.service.ts:432-441]
- [x] [Review][Patch] Data-anomaly fallback logged nothing — `embedProfileJobs` now warns with the specific missing tech/customer ids (same discipline as jobs detail's 500). [src/users/users.service.ts]
- [x] [Review][Patch] Tenant filter untested on the three batched embed queries — asserted (users `tenant_id`, skills `tenant_skills.tenant_id`, customers `tenant_id`); createAdmin bypasses RLS so this is the only cross-tenant guard. [src/users/users.service.spec.ts]
- [x] [Review][Patch] Missing-row fallback untested for the CUSTOMER side — id-only customer embed test added. [src/users/users.service.spec.ts]
- [x] [Review][Patch] `jobsScope=today` × technician branch never exercised — combined test added (day window + own-jobs filter + embeds). [src/users/users.service.spec.ts]
- [x] [Review][Patch] Trim transform on `jobsScope` untested — padded value accepted, whitespace-only 422. [src/users/dto/get-profile-query.dto.spec.ts]
- [x] [Review][Patch] Empty-page embed guard untested — empty page asserted to skip all three batched queries. [src/users/users.service.spec.ts]
- [x] [Review][Patch] Explicit `jobsScope=all` untested at service level — asserted identical to the omitted default. [src/users/users.service.spec.ts]
- [x] [Review][Patch] `nextCursor: null` on a short today page untested — asserted hasMore=false + null cursor. [src/users/users.service.spec.ts]
- [x] [Review][Patch] AC2/Task-3/fallback story-record notes — recorded under Completion Notes (AC2 "byte-compatible" read as additive-fields; embeds non-nullable per 2026-09-05 decision; anomaly fallback can emit `name: null`/`''` — FE story 1-7 must model these as nullable).
- [x] [Review][Defer] Profile embed shapes mirror `toDetailResponse` by comment only, no shared type/parity test — deferred, accepted coupling tradeoff (CR3.9-D1 in deferred-work.md).

Dismissed as noise (9): null-ids-into-`.in()` (schema: `technician_id`/`customer_id`/`scheduled_start` all NOT NULL); Promise.all throw (awaited, same exception path as every Supabase call); NULL scheduled_start invisible (exact window parity with GET /jobs); cursor or()-injection (blocked by `TIMESTAMP_RE`, cursor.util.ts:34-37); type-accuracy claim (schema confirms the non-nullable typings); echo-controller route mirroring (DTO spec pins the ValidationPipe contract by design); unconditional embed cost (AC 5 mandates embeds in every scope); duplicated SQL literals in tests (intentional shape pinning); AC7 predicate-level window test (mocked-builder suite; predicate copied verbatim from listJobs).

## Dev Agent Record

### Agent Model Used

Claude Code (GLM) — BMAD dev-story run, 2026-09-05

### Debug Log References

- Red-green-refactor: new service tests written first (15 failing), then implementation; final state 323/323 green across 20 suites.
- Spec mock builders extended for the new query chains: `usersTableHandler` gained the `in('id', ids).eq('tenant_id', …)` branch, `userSkillsTableHandler` dispatches on the select column list (`user_id` prefix = batched skills path), new `customersTableHandler` for `customers.eq('tenant_id', …).in('id', …)`.
- Cursor-mint test initially used non-UUID job ids (`j1`) — `decodeCursor` validates the id as a UUID, so the test now mints/decodes with UUID ids.

### Completion Notes List

- **Task 4 needed no code change** — `users.controller.ts` already binds `GetProfileQueryDto` and passes the whole query to `getMyProfile`, which reads `query.jobsScope` directly.
- `CursorScope` union in `common/utils/cursor.util.ts` gained `'profile-jobs-today'`; cross-scope replay (either direction) is rejected 400 by the existing `decodeCursor` scope check — tested both directions.
- Today scope copies the exact `listJobs` day-window shape (`getIstDayRange()`, `>= start`, `< end`) with NO status filter, per Dev Notes parity rule; sort is `scheduled_start ASC, id ASC` and the keyset cursor is `scheduled_start.gt` (mirrors the ascending timeline scopes in jobs.service.ts).
- Embeds are always present on every row in ANY scope (AC 5) — additive on the default path too; nothing removed or renamed, so AC 2's "byte-compatible" holds for existing fields. `JobResponse` itself is untouched (GET /jobs shape unchanged).
- Batched embed = exactly 3 extra queries per non-empty page (users `in`, user_skills `in` + tenant-skill name join, customers `in`), regardless of page size; skills reuse `flattenSkills` for the object/array embed normalization.
- Data-anomaly fallback: if a users/customers row is missing (impossible under FK unless deleted mid-page), the embed key still renders (id-only, null names) — the FE must never see a shape suggesting an unassigned job.
- Verification: `bun run test` (jest) 323 pass / 0 fail; `bun run typecheck` clean; `eslint` clean on all touched files. `--watchman=false` needed in the sandboxed shell (watchman state dir is not writable there) — not a repo issue.
- **Review-record notes (2026-09-05 full-mode review):**
  - AC2 "byte-compatible" is satisfied as ADDITIVE-ONLY: embeds are new keys on `jobs.data` rows in every scope; no existing field removed/renamed, same query/sort/cursor mechanics on the default path (verified by tests). Nothing existing on the wire changes.
  - Task 3's `technician: … | null` wording is superseded — the embed is non-nullable per AC 5 and the 2026-09-05 no-unassigned-jobs decision; `ProfileJobResponse` types it as always present.
  - ⚠️ For fenzo-app story 1-7: on a data anomaly (mid-page deletion) a profile job row can carry `technician.name: null`, `countryCode: ''`, `phoneNumber: ''` and `customer.name: null`, `address: null`, `city: null` — model these as nullable in the FE types, unlike the GET /jobs/:id detail embed (which 500s instead).

### File List

- `src/users/dto/get-profile-query.dto.ts` — added optional `jobsScope` (`'today' | 'all'`, trim + IsEnum)
- `src/users/dto/get-profile-query.dto.spec.ts` — NEW: ValidationPipe spec pinning the 422 contract (AC 3)
- `src/users/users.service.ts` — `ProfileTechnicianEmbed`/`ProfileCustomerEmbed`/`ProfileJobResponse` types; `ProfileJobResponse` on both profile responses; `PROFILE_JOBS_TODAY_CURSOR_SCOPE`; `listProfileJobs` today scope + scope-keyed cursors; new `embedProfileJobs` batched assembly; both `getMyProfile` call sites pass `jobsScope`
- `src/users/users.service.spec.ts` — extended mocks (batch users/skills/customers handlers) + 10 new tests (embeds, batching, today window/sort, cursor scopes both ways, cursor mint tag, fallbacks, embed 500)
- `src/common/utils/cursor.util.ts` — added `'profile-jobs-today'` to the `CursorScope` union
- `src/users/users.controller.ts` — Swagger summary/422 response refreshed for the new contract (review fix)
- `docs/api-contracts.md` — added the Users (profile) section documenting GET/PATCH /users/me (review fix)

### Change Log

- 2026-09-05: Story implemented per tasks 1-5 (red-green-refactor); all ACs covered; status → review.
- 2026-09-05: Full-mode code review (4 layers) — 12 patch findings applied (docs/api-contracts.md Users section, Swagger refresh, corrected today-scope parity comment, embed anomaly warn-logging, 7 new test assertions); 1 defer (CR3.9-D1); 9 dismissed. Tests 330/330, typecheck + eslint clean. Status → done.
- 2026-09-09: Parity follow-up (bmad-code-review verification-gap on the jobs-list in_progress fix):
  `jobsScope='today'` for a technician now ORs the IST day window with their `in_progress` jobs —
  same branch `GET /jobs?scope=today` uses, so an active job no longer vanishes from the profile's
  Today page when its slot crosses midnight IST. Owners (technicianId=null) keep the pure window.
  Cursor mechanics unchanged (scheduled_start-ASC keyset, scope-tagged cursor). Reviewed, tests green.
