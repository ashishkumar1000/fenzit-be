---
baseline_commit: 22d655b7ae1d2a9e45b809a336d88e2421c71060
---

# Story 3.8: Optional Signature & Editable Requirement Flags

Status: ready-for-dev

## Story

As an owner,
I want to decide per job whether a customer signature (and completion photos) is required,
so that simple jobs can be completed without forcing an unnecessary signature step.

## Background (why this story exists)

Signature capture is currently a **hard-mandatory workflow step**: `validateStep` enforces
exactly-one-step-forward, so `completed` can only follow `signature_captured`
(`workflow.service.ts:55-88`) — there is no skip rule for it, unlike photos. The owner has no
way to say "this job doesn't need a signature".

The photo pattern is the template to mirror end-to-end:
`jobs.require_completion_photo` column → `create_job_with_log` RPC param → `CreateJobDto` →
skip rule in `validateStep` → sync payload → FE stepper. This story adds
`require_completion_signature` the same way, and additionally makes **both** flags editable
via `PATCH /jobs/:id` (the photo flag was deliberately absent from the update path until now —
`update-job.dto.ts:16-25` PickType list).

**Deliberate design decisions (do not "fix" these):**
- **Default `false` for the new flag.** Matches the photo flag's default. Existing jobs
  become signature-optional — accepted, app is pre-launch with no real users.
- **The step-order gate stays app-side.** `advance_workflow_step` RPC is compare-and-set only
  (verified: no ordering logic in `20260621000006_*.sql` / `20260903000003_*.sql`). All new
  skip rules live in `validateStep` — one place, no DB re-issue of that RPC.
- **Effective-chain semantics (dynamic flags).** Flags are read fresh at each advance, so a
  flag edit changes what is reachable *from the current step onward* (matrix below). No
  current_step rewrite on edit.
- **No new activity-log event for flag edits.** The update RPC logs only reassign
  (`20260621000004_rpc_update_job_with_log.sql:85-94`); every other edit field (description,
  dates, priority) is unlogged. Flag edits follow the same rule.
- **Repo boundary:** the authoritative FE-facing contract doc
  (`fenzo-app/_bmad-output/planning-artifacts/api-contracts.md`) lives in the fenzo-app repo —
  its §1/§2/§5/§6/§7 updates ride with the FE stories (1-6 and 3-5). This story updates the
  BE repo's own docs only (`docs/data-models.md`).
- **Breaking-ish change is intentional.** Pre-launch, no live users; no additive-then-remove
  dance needed.

**Step-order matrix (after this story):** from the current step, walking forward, the next
*required* step is the only legal target:

| Photo required? | Signature required? | Valid path after `in_progress` |
|---|---|---|
| Yes | Yes | photos_uploaded → signature_captured → completed |
| Yes | No | photos_uploaded → completed |
| No | Yes | signature_captured → completed (today's behaviour) |
| No | No | completed directly |

## API Contract (fenzit-be docs/api-contracts.md is stale for jobs — data-models.md is the BE doc updated here)

- `POST /api/v1/jobs` body gains optional `requireCompletionSignature?: boolean`
  (default false server-side) alongside `requireCompletionPhoto`.
- `PATCH /api/v1/jobs/:id` editable-subset gains `requireCompletionPhoto?: boolean` and
  `requireCompletionSignature?: boolean` (owner-only; job must still be `scheduled` —
  existing PT409 guard). Absent = unchanged (COALESCE semantics, same as every other edit
  field). Cancel body `{"status":"cancelled"}` unchanged.
- Every job-returning response (`JobResponse`) gains `requireCompletionSignature: boolean`;
  the sync payload (`SyncJobDto`) gains it too.
- Workflow step rules: `validateStep` now accepts `(currentStep, requested,
  requireCompletionPhoto, requireCompletionSignature)`; ordering = effective-chain successor
  (matrix above). `advance_workflow_step` RPC signature unchanged.

## Acceptance Criteria

1. **Given** the migration is applied, **when** the `jobs` table is inspected, **then** it has
   `require_completion_signature BOOLEAN NOT NULL DEFAULT false`, no index added, RLS
   policies untouched, and all existing rows read `false`.

2. **Given** `POST /api/v1/jobs` with `requireCompletionSignature: true`, **when** called,
   **then** the job is created with the flag persisted and echoed in the 201 response;
   **given** the field omitted, **then** it persists as `false`. Validation is
   `@IsOptional() @IsBoolean()` mirroring `create-job.dto.ts:76-79`.

3. **Given** `PATCH /jobs/:id` with `requireCompletionPhoto` and/or
   `requireCompletionSignature`, **when** called by the owner on a `scheduled` job, **then**
   only the provided flags change (absent = unchanged), the response echoes the new values,
   and the update RPC receives them as nullable params (`?? null`). **Given** either flag
   supplied together with `{"status":"cancelled"}` or with an otherwise-empty patch, **then**
   the existing 422 rules (`jobs.service.ts:370-389`) apply unchanged.

4. **Given** `validateStep` with the effective-chain rule, **when** evaluated, **then** the
   full matrix holds — including `in_progress → completed` legal only when BOTH flags are
   false, `photos_uploaded → completed` legal only when signature is false, and every
   non-successor request still 422 `INVALID_WORKFLOW_STEP` with `currentStep` in the body.
   Today's photo-skip behaviour (`in_progress → signature_captured` when photo not required)
   is preserved exactly.

5. **Given** a job whose `current_step` sits on (or past) a now-non-required step — e.g.
   signature toggled OFF while `current_step = signature_captured` — **when** the technician
   advances, **then** walking forward from `current_step` to the next required step decides
   validity (here: `completed` is legal). The corrupt-`current_step` guard
   (`workflow.service.ts:69-71`) is unchanged.

6. **Given** any job-returning endpoint (create, detail, list, profile jobs) **and** the
   technician delta-sync, **when** called, **then** `requireCompletionSignature` is present
   in every payload — via `toResponse` (`jobs.service.ts:837-858`), all four select lists
   (`JOB_DETAIL_COLUMNS` :172-173, listJobs inline :537, users `JOB_COLUMNS`
   `users.service.ts:31`, sync select `sync.service.ts:31`) and the sync mapper
   (`sync.service.ts:65` → `SyncJobDto` :28). The customer job-history slim mapper
   (`customers.service.ts:505-511`) deliberately does NOT gain the flag (display-only rows,
   same exclusion precedent as `completedAt` in Story 3-7 AC #10).

7. **Given** the whole change, **when** `bun run lint` and the test suite run, **then** they
   pass with: `validateStep` truth-table rows for every matrix cell (extend the `it.each` at
   `workflow.service.spec.ts:106-127`); create-passthrough assertion extended
   (`jobs.service.spec.ts:313-336`); update-RPC param assertion extended
   (`jobs.service.spec.ts:1088-1099`); full-shape `toEqual` blocks updated (`:406-425`,
   `users.service.spec.ts:121` fixtures); the photo-skip 422 e2e kept green
   (`test/jobs.e2e-spec.ts:1253-1277`); new e2e for a PATCH flag edit + a signature-skip
   advance (in the `PATCH` describe at `:953`). Existing migration/RPC-behaviour tests are
   unaffected (specs mock `SupabaseClientFactory`; migrations are verified via Supabase MCP
   in Task 1, not in Jest).

## Tasks / Subtasks

- [ ] **Task 1 — Migration: flag column** (AC: #1)
  - [ ] New `supabase/migrations/20260905000001_add_jobs_require_completion_signature.sql`:
        `ALTER TABLE jobs ADD COLUMN require_completion_signature BOOLEAN NOT NULL DEFAULT false;`
        (style mirror: `20260903000002_add_jobs_completed_at.sql`; trailing newline —
        CR3.7 review finding).
  - [ ] Apply via Supabase MCP (`apply_migration`), verify via `execute_sql`
        (column exists, all rows false, RLS policy count unchanged).

- [ ] **Task 2 — Migrations: RPC re-issues** (AC: #2, #3)
  - [ ] New migration `20260905000002_rpc_create_job_with_log_signature.sql`: `CREATE OR REPLACE
        FUNCTION create_job_with_log` re-issued with `p_require_completion_signature BOOLEAN`
        added after `p_require_completion_photo` (append-only history — never edit an applied
        migration; pattern: `20260903000003_rpc_advance_workflow_step_completed_at.sql`). INSERT
        adds the column with `COALESCE(p_require_completion_signature, false)` — copy only the
        `create_job_with_log` body from `20260621000003_rpc_create_job_with_log.sql:27-65`
        (`increment_job_counter` is a separate function in that file; do NOT re-issue it).
  - [ ] New migration `20260905000003_rpc_update_job_with_log_flags.sql`: re-issued
        `update_job_with_log` adding `p_require_completion_photo BOOLEAN,
        p_require_completion_signature BOOLEAN` at the END of the param list (positional order
        is breaking — new params must trail so existing callers are unaffected). UPDATE clause:
        `require_completion_photo = COALESCE(p_require_completion_photo, require_completion_photo),`
        same for signature. Copy the PT409/PT422 guards + reassign log verbatim.
  - [ ] Apply both via MCP; verify with a rolled-back transaction probe (temp-table style per
        Story 3-7 debug log) that flag-only updates persist and null params leave values.

- [ ] **Task 3 — Create path** (AC: #2)
  - [ ] `create-job.dto.ts`: add `requireCompletionSignature?: boolean` after
        `requireCompletionPhoto` (:76-79) with `@ApiPropertyOptional({ default: false })
        @IsOptional() @IsBoolean()`.
  - [ ] `jobs.service.ts` `createJob` RPC params (:298-312): add
        `p_require_completion_signature: dto.requireCompletionSignature ?? false` after :308.
  - [ ] `JobRow` (:109-128, sibling of :123) + `JobResponse` (:36-58, sibling of :53) +
        `toResponse` (:852) + `JOB_DETAIL_COLUMNS` (:172-173) + listJobs select (:537).
  - [ ] `users.service.ts:31` `JOB_COLUMNS` — the profile payload has its own literal; missing
        it makes the key silently `undefined` (the `as JobRow[]` cast hides it; trap documented
        by `jobs.service.spec.ts:338-350`).

- [ ] **Task 4 — Update path** (AC: #3)
  - [ ] `update-job.dto.ts`: extend the `PickType` list (:16-25) with
        `'requireCompletionPhoto'`, `'requireCompletionSignature'`; update the header comment
        explaining the PickType choice.
  - [ ] `jobs.service.ts` `updateJob`: add both flags to the `hasEdit` field list (:358-366)
        so "empty patch → 422" counts them, and to the RPC params (:438-449) as
        `?? null` (COALESCE semantics — absent = unchanged).

- [ ] **Task 5 — Workflow: effective-chain validateStep** (AC: #4, #5)
  - [ ] `workflow.service.ts`: `WorkflowJobRow` gains `require_completion_signature: boolean`
        (:36 sibling); fetch select gains the column (:110); `validateStep` signature gains the
        4th param; `advanceWorkflowStep` passes `row.require_completion_signature` (:181).
  - [ ] Implement as **effective-chain successor**: filter `STEP_ORDER` to required steps
        (`photos_uploaded` in only when photo required; `signature_captured` in only when
        signature required; `on_my_way`/`arrived`/`in_progress`/`completed` always in), keep the
        corrupt-step guard, then from `currentStep`'s full-order index walk forward to the first
        step present in the effective chain and require `requested === that`. This single rule
        reproduces all four matrix cells AND the dynamic-flag edge (AC #5) — do NOT add
        piecemeal special-case ifs per matrix row.
  - [ ] `advance-workflow.dto.ts` swagger description (:8-12): rewrite to state the
        effective-chain rule + both flags.

- [ ] **Task 6 — Sync + docs** (AC: #6)
  - [ ] `sync.service.ts`: select list (:31) + mapper (:65); `sync-response.dto.ts`
        `SyncJobDto` (:28 sibling). Do NOT add `completed_at` here — that is Story 3-7's
        documented follow-up, not this story's scope.
  - [ ] `docs/data-models.md` jobs table (:117): add the column row.

- [ ] **Task 7 — Tests** (AC: #7)
  - [ ] `workflow.service.spec.ts`: truth-table rows for all matrix cells + the AC-5 dynamic
        edge (signature off at `signature_captured`) + corrupt-step still false; extend the
        422-no-RPC test (:225-245) with a signature-required variant.
  - [ ] `jobs.service.spec.ts`: create passthrough (:313-336), default-create path (:160-182),
        full-shape `toEqual` (:406-425), trap test stays green, updateJob RPC params
        (:1088-1099) + a flag-only patch (no other fields) not counting as empty.
  - [ ] `users.service.spec.ts` fixture (:121) updated.
  - [ ] e2e: PATCH flag edit round-trip + signature-skip advance (`test/jobs.e2e-spec.ts`,
        PATCH describe :953 / workflow tests :1253-1277). Extend the `fetchRow` fixtures
        seeding the workflow select (:91) with the new column.
  - [ ] `bun run lint` + `bun run test` green. Known pre-existing failures at baseline (do not
        "fix" here): 3 `tsc --noEmit` errors, 8 e2e failures (4 customers, 4 sync).

## Dev Notes

- **Existing patterns to reuse (never reinvent):**
  - Migration + MCP workflow: Story 3-7 Tasks 1-2 verbatim style (append-only, rolled-back
    transaction probes, `execute_sql` verification).
  - `validateStep` stays a pure function — all tests drive it without mocks
    (`workflow.service.spec.ts:106-127` is an `it.each` table).
  - COALESCE update semantics + `hasEdit` gating: mirror how `priority` flows through
    `updateJob` (`jobs.service.ts:358-366, 438-449`).
- **Param-list ordering hazard:** Postgres RPC params are positional. New params on BOTH RPCs
  must be appended at the END (`create_job_with_log` — after `p_year`; `update_job_with_log` —
  after `p_priority`). Inserting mid-list silently reorders existing positional callers.
  The service call sites pass named keys, but the SQL signature is what breaks.
- **`toResponse` is shared by WorkflowService** — adding the flag to `JobRow` + one mapping
  line covers advance responses too; do not duplicate mapping logic there.
- **Sync select has no `completed_at`** (3-7 AC #10 exclusion) — leave it that way; flag only.
- **Testing standards** (`_bmad-output/planning-artifacts/architecture.md` §Testing Patterns):
  Jest unit specs with mocked `SupabaseClientFactory`; run the RLS isolation spec once after
  applying migrations as cheap insurance (no policy change expected).
- **Deploy order (handoff):** this story merges/deploys FIRST. fenzo-app stories 1-6 (owner
  toggles) and 3-5 revision (technician capture) consume `requireCompletionSignature` and the
  PATCH flags; until they ship, the FE never sends the new fields and nothing changes for the
  current FE. FE contract-doc updates (fenzo-app `api-contracts.md` §1/§2/§5/§6/§7) are part
  of those FE stories, not this one.

### Project Structure Notes

- New files: three migrations (20260905000001..03). Everything else edits existing files.
- Naming: `require_completion_signature` in DB/RPC, `requireCompletionSignature` in TS/JSON —
  same convention as the photo flag.
- `baseline_commit` at story creation: HEAD of `fenzit-be` main.

### References

- [Source: fenzit-be/src/jobs/workflow.service.ts:21-28,55-88,110,178-192] STEP_ORDER, validateStep + photo-skip, fetch select, call site
- [Source: fenzit-be/src/jobs/jobs.service.ts:36-58,109-128,172-173,298-312,358-366,438-449,537,837-858] response/row shapes, create + update paths, toResponse
- [Source: fenzit-be/src/jobs/dto/create-job.dto.ts:76-79; update-job.dto.ts:6-25] flag validator + PickType list
- [Source: fenzit-be/src/jobs/dto/advance-workflow.dto.ts:8-12] step swagger text
- [Source: fenzit-be/src/sync/sync.service.ts:28-35,52-80; src/sync/dto/sync-response.dto.ts:28] sync select + mapping + DTO
- [Source: fenzit-be/src/users/users.service.ts:31] profile JOB_COLUMNS
- [Source: fenzit-be/supabase/migrations/20260621000002_create_jobs.sql:22; 20260621000003_rpc_create_job_with_log.sql:27-41,63; 20260621000004_rpc_update_job_with_log.sql:10-21,45-48,63-68,72-80,85-94] base column + both RPCs
- [Source: fenzit-be/src/jobs/workflow.service.spec.ts:106-127,225-245; src/jobs/jobs.service.spec.ts:313-336,338-350,406-425,1074,1088-1099; test/jobs.e2e-spec.ts:91,953,1253-1277] test seams
- [Source: fenzit-be/docs/data-models.md:117] jobs data-model table
- [Source: fenzit-be/_bmad-output/implementation-artifacts/3-7-jobs-timeline-scopes.md] migration/MCP patterns, exclusion precedent, known pre-existing test failures
- [Source: fenzit-be/project-context.md] Supabase MCP rules for migrations

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List

## Change Log