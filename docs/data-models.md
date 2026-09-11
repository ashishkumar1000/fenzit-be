# Data Models — fenzit-be

All persistent state lives in **Supabase Postgres**. Schema is defined by
timestamped SQL files in `supabase/migrations/`. Every table has **Row-Level
Security (RLS)** enabled.

## Migrations Inventory

38 migrations, applied in chronological order. New migrations **must** be
appended (never edit history) and **must** be applied via the Supabase MCP
(see `project-context.md`).

| #   | File                                            | Purpose |
|----:|-------------------------------------------------|---------|
| 01  | `20260619000001_create_users_table.sql`         | `users` table + RLS |
| 02  | `20260619000002_fix_users_insert_policy.sql`    | Tighten insert policy |
| 03  | `20260619185741_create_tenants_and_rpc.sql`     | `tenants` table + `setup_tenant_for_owner` RPC |
| 04  | `20260620000001_add_skill_type_to_users.sql`    | Add `skill_type` to users |
| 05  | `20260620000002_split_phone_add_country_codes.sql` | Split phone → `(country_code, phone_number)`; create `country_codes` |
| 06  | `20260620000003_multi_tenant_phone_uniqueness.sql` | Phone uniqueness scoped per tenant |
| 07  | `20260620000004_tenant_skills.sql`              | `tenant_skills` table |
| 08  | `20260621000001_create_customers_table.sql`     | `customers` table + RLS |
| 09  | `20260621000002_create_jobs.sql`                | `jobs` + `activity_logs` tables |
| 10  | `20260621000003_rpc_create_job_with_log.sql`    | `increment_job_counter`, `create_job_with_log` |
| 11  | `20260621000004_rpc_update_job_with_log.sql`    | `update_job_with_log` |
| 12  | `20260621000005_create_idempotency_log.sql`     | `idempotency_log` (24h dedup) |
| 13  | `20260621000006_rpc_advance_workflow_step.sql`  | `advance_workflow_step` |
| 14  | `20260621000007_create_attachment_uploads.sql`  | `attachment_uploads` (R2 presign) |
| 15  | `20260621000008_create_attachments.sql`         | `attachments` (confirmed) |
| 16  | `20260621000009_rpc_confirm_attachment.sql`     | `confirm_attachment` |
| 17  | `20260621000010_attachments_signature_unique.sql` | Unique checksum on attachments |
| 18  | `20260621000011_delta_sync_index.sql`           | `idx_jobs_tenant_updated_at` covering index |
| 19  | `20260621000012_pg_cron_idempotency_cleanup.sql`| `pg_cron` job — purge `idempotency_log` older than 24h |
| 20  | `20260621000013_rpc_confirm_attachment_conflict.sql` | Server-side conflict resolution (Epic 4 Story 4.3) |
| 21  | `20260621000014_rpc_confirm_attachment_conflict_fix.sql` | Bugfix for above |
| 22  | `20260903000001_jobs_customer_history_index.sql` | Index for customer job-history lookup |
| 23  | `20260903000002_add_jobs_completed_at.sql`      | Add `completed_at` to jobs |
| 24  | `20260903000003_rpc_advance_workflow_step_completed_at.sql` | Advance RPC sets `completed_at` |
| 25  | `20260905000001_add_jobs_require_completion_signature.sql` | Add `require_completion_signature` to jobs |
| 26  | `20260905000002_rpc_create_job_with_log_signature.sql` | Create-job RPC accepts signature flag |
| 27  | `20260905000003_rpc_update_job_with_log_flags.sql` | Update-job RPC accepts flags |
| 28  | `20260905000004_drop_stale_rpc_overloads.sql`   | Drop stale RPC overloads |
| 29  | `20260905000005_add_customer_structured_address.sql` | Structured address on customers (Epic 1) |
| 30  | `20260909000001_enable_rls_users_country_codes.sql` | RLS on `users`, `country_codes` (Epic 3) |
| 31  | `20260909000002_notifications_table.sql`        | `notifications` table (Epic 3) |
| 32  | `20260909000003_rpc_notify_owner_on_advance.sql` | Advance RPC notifies owner (Epic 3) |
| 33  | `20260909000004_notifications_cleanup.sql`      | pg_cron — purge old notifications (Epic 3) |
| 34  | `20260910000001_create_global_skills.sql`       | Global `skills` catalog, sort_order-pinned seeds + RLS (Epic 4) |
| 35  | `20260911000001_tenant_skills_cutover.sql`      | Cutover: `user_skills.skill_id` → `skills`, tenant-isolated RLS on `user_skills`, drop `tenant_skills` + `tenants.service_categories`, slim `setup_tenant_for_owner` (Epic 4 Story 4.2) |
| 36  | `20260911000002_workflow_templates_skill_tagged_jobs.sql` | `workflow_templates` table + 6 v1 seeds, `jobs.skill_id`/`workflow_template_id`/`workflow_template_version`, drop `jobs.service_type` + CHECK, re-issue `create_job_with_log` with `p_skill_id` (Epic 4 Story 4.3) |
| 37  | `20260911000003_generic_workflow_engine.sql` | Drop `jobs.require_completion_photo/signature`, re-issue create/update RPCs without flag params, re-issue `confirm_attachment` with template-driven auto-advance, `workflow_steps_valid()` + steps shape CHECK (Epic 4 Story 4.4) |
| 38  | `20260911000004_confirm_auto_advance_no_template_log.sql` | Re-issue `confirm_attachment`: RAISE LOG on the no-template-row auto-advance skip (Story 4.4 review patch — body otherwise identical to 37) |

## Tables

### `users`

Phone-based identity. One row per person (owner or technician). The `tenant_id`
column is `NULL` until the owner completes company setup.

```sql
id          UUID PK
phone       TEXT UNIQUE NOT NULL         -- (after migration 5: phone split per tenant)
name        TEXT
role        TEXT CHECK (role IN ('owner','technician'))
tenant_id   UUID FK → tenants(id) ON DELETE SET NULL
status      TEXT CHECK (status IN ('active','invited')) DEFAULT 'active'
created_at  TIMESTAMPTZ
updated_at  TIMESTAMPTZ (auto via trigger)
```

**RLS:**
- `SELECT`: own row OR same-tenant rows
- `UPDATE`: own row only
- `INSERT`: denied for clients (only service role / RPCs)

### `tenants`

One per company. Owner is the FK source of truth.

```sql
id                 UUID PK
owner_id           UUID UNIQUE NOT NULL FK → users(id) ON DELETE CASCADE
company_name       TEXT NOT NULL
gstin              TEXT
address            TEXT
state_code         TEXT NOT NULL CHECK (state_code ~ '^[A-Z]{2}$')
upi_vpa            TEXT
created_at, updated_at TIMESTAMPTZ
```

**RLS:** Owner can `SELECT` their own tenant only.

### `customers`

One per `(tenant_id, country_code, phone_number)`. Created manually by owner.

```sql
id           UUID PK
tenant_id    UUID FK → tenants(id) ON DELETE CASCADE
name         TEXT
country_code TEXT FK → country_codes(dial_code)
phone_number TEXT
address, city TEXT
created_via  TEXT CHECK (created_via IN ('manual','job_creation'))
created_at   TIMESTAMPTZ
UNIQUE (tenant_id, country_code, phone_number)
```

**RLS:** Strict tenant isolation on ALL operations (`FOR ALL` policy).

> **Drift:** `CustomersService.createCustomer()` uses `createAdmin()` (service
> role) which bypasses RLS — tenant isolation depends entirely on the app
> setting `tenant_id: owner.tenantId`. Same pattern in `auth/`, `skills/`.
> (Deferred C1.)

### `jobs`

Central entity. Generated job numbers are tenant+year scoped via
`job_sequences`.

```sql
id            UUID PK
tenant_id     UUID FK → tenants(id)
customer_id   UUID FK → customers(id)
technician_id UUID FK → users(id)
job_number    TEXT  -- e.g. "JB-2026-0001"
status        TEXT  -- scheduled | in_progress | completed | cancelled
skill_id      UUID FK → skills(id) ON DELETE RESTRICT  -- Story 4.3: what kind of work
workflow_template_id      UUID FK → workflow_templates(id) ON DELETE RESTRICT  -- stamp
workflow_template_version INT  -- stamped version (resolved inside create_job_with_log)
service_location TEXT
scheduled_start, scheduled_end TIMESTAMPTZ
description, priority, notes_for_technician TEXT
completed_at  TIMESTAMPTZ  -- set by advance_workflow_step on 'completed' (Story 3.2)
current_step  TEXT  -- per-job workflow step pointer (NULL until the first advance)
created_at, updated_at TIMESTAMPTZ
```

**RLS:** Tenant isolation on reads; writes only via RPCs (service role).

The `skill_id` + `workflow_template_id` + `workflow_template_version` stamp is
written exactly once, inside `create_job_with_log` (latest template version for
the skill at insert time) — no create/PATCH code path writes it again. The old
`service_type` CHECK enum was dropped in migration 36 (Story 4.3). The
per-job `require_completion_photo` / `require_completion_signature` flag
columns were dropped in migration 37 (Story 4.4) — photo/signature requirements
live on the template steps (`requires_photo` / `requires_signature`), not on
the job.

**Read surface (Story 4.5):** job reads join the stamp out via FK embeds —
`skills(id, name)` and `workflow_templates(version, steps)` — and expose
`skill` + `workflowTemplate` (camelCase steps) + the derived 0-based
`currentStepIndex` (`null` while fresh) on every job read surface, including
the sync payload and the customer job-history `skillName`. The embeds are
plain left joins (no `!inner`), so a job whose skill was archived still reads.

### `activity_logs`

Append-only audit trail for job mutations. One row per state transition.

```sql
id          UUID PK
job_id      UUID FK → jobs(id) ON DELETE CASCADE
actor_id    UUID FK → users(id)
event_type  TEXT  -- 'step_<key>' (advance RPC) | 'conflict_resolved' (confirm RPC) | create/update RPC events
metadata    JSONB
created_at  TIMESTAMPTZ
```

### `job_sequences`

Per-tenant per-year counter for gap-free job numbering.

```sql
tenant_id UUID
year      INT
last_seq  INT
PRIMARY KEY (tenant_id, year)
```

`increment_job_counter(p_tenant_id, p_year)` upserts and returns the next
sequence value (used inside `create_job_with_log`).

### `user_skills`

Junction: which global-catalog skills a technician has (used for matching when
creating jobs). Rows are written by the invite flow against the global
`skills` catalog (migration 35 cut the FK over from the since-dropped
`tenant_skills`). `skill_id` uses **ON DELETE RESTRICT** — skills are never
API-deleted (only deactivated via `is_active`), so an accidental delete fails
loudly instead of silently stripping technicians' skills.

```sql
user_id  UUID FK → users(id) ON DELETE CASCADE
skill_id UUID FK → skills(id) ON DELETE RESTRICT
PRIMARY KEY (user_id, skill_id)
```

**RLS:** `user_skills_tenant_isolation` (FOR ALL, USING + WITH CHECK) — a row
is visible/writable only when its user's `users.tenant_id` matches the JWT
`tenantId` (EXISTS join into `users`, not a direct column read).

### `attachments`

Confirmed uploads tied to jobs.

```sql
id          UUID PK
job_id      UUID FK → jobs(id) ON DELETE CASCADE
uploader_id UUID FK → users(id)
object_key  TEXT  -- R2 object path
purpose     TEXT CHECK (purpose IN ('before','after'))
checksum    TEXT
size_bytes  INT
status      TEXT  -- pending | available | rejected
signature   TEXT UNIQUE  -- migration 17: dedup by checksum
created_at, updated_at TIMESTAMPTZ
```

### `attachment_uploads`

Phase-1 presigned uploads awaiting confirmation. `pg_cron` job (`migration 19`)
sweeps stale uploads.

```sql
id             UUID PK
job_id         UUID FK → jobs(id)
uploader_id    UUID FK → users(id)
object_key     TEXT
presigned_url  TEXT
expires_at     TIMESTAMPTZ
created_at     TIMESTAMPTZ
```

### `idempotency_log`

24h replay protection for POST endpoints with `X-Idempotency-Key`.

```sql
key           TEXT
user_id       UUID
endpoint      TEXT
response      JSONB
created_at    TIMESTAMPTZ
UNIQUE (key, user_id)        -- actually (key, tenant_id) per AR-9
```

`pg_cron` cleanup job runs hourly (migration 12 — shipped with the idempotency
machinery in Story 3.5/3.6, predating Story 4.2) and deletes rows older than
24h. Without this job the table grows without bound.

> **Edge case (W3):** Idempotency dedup is **read-through** — two genuinely
> concurrent requests with the same key can both miss the lookup and both
> execute the handler before either inserts. The compare-and-set guard in
> `advance_workflow_step` closes the practical window for workflow steps;
> the general interceptor has no such backstop. Acceptable for Phase 1.

### `country_codes`

Lookup table for E.164 dial codes.

```sql
dial_code TEXT PK  -- e.g. '+91'
name      TEXT
```

### `skills`

Global skill catalog (migration 34). Developer-seeded ONLY via migrations —
fixed UUIDs so later migrations can reference them (see the seed UUIDs below;
do not regenerate them). No API write path exists; RLS grants SELECT to
`authenticated`, and writes are denied via RLS (no write policies — the
anon/authenticated roles keep their default grants but cannot satisfy a
policy). `sort_order` pins the documented seed order (all seeds share one
`now()`, so `created_at` cannot order them) and is UNIQUE so a future seed
cannot introduce ordering ties. `is_active` is a future hook — deactivation
is migration-only until a deactivate flow exists. `updated_at` is inert:
there is no trigger and no write path, so it always equals `created_at`
(review round 2 note — revisit if a deactivation flow lands). The
per-tenant `tenant_skills` table it supersedes was dropped in migration 35
(Story 4.2).

```sql
id         UUID PK DEFAULT gen_random_uuid()
name       TEXT NOT NULL               -- unique case-insensitive
sort_order INT NOT NULL                -- UNIQUE; pins seed order; GET /skills orders by it
is_active  BOOLEAN NOT NULL DEFAULT true
created_at TIMESTAMPTZ NOT NULL DEFAULT now()
updated_at TIMESTAMPTZ NOT NULL DEFAULT now()  -- inert: always equals created_at
```

Seed rows (fixed UUIDs — Stories 4.2/4.3 reference these):

| sort_order | name           | id                                     |
|-----------:|----------------|----------------------------------------|
| 1          | Plumbing       | d89d67f7-c0fe-42f8-9f76-c1660c98ce97   |
| 2          | Electrical     | 77d9450a-f9a4-4992-a82a-cdf27063e9e9   |
| 3          | AC Service     | 65f33480-b37e-47e2-a4a0-0155b156cc7a   |
| 4          | AC Installation | 95f021b0-a973-45fc-b73f-db0dc5afd4a0   |
| 5          | Pest Control   | 71cc840c-3663-489e-bbf2-867d92c46619   |
| 6          | Cleaning       | 72f67596-fec7-4ae8-a6f1-fceabaef0d7d   |

### `workflow_templates`

Per-skill workflow definitions (migration 36, Story 4.3). Developer-seeded ONLY
via migrations — no API write path exists, exactly like `skills`. One row per
`(skill_id, version)`; `create_job_with_log` stamps the skill's latest version
(`ORDER BY version DESC LIMIT 1`) onto the job at insert. RLS grants SELECT to
`authenticated` (mirrors `skills_authenticated_read`); writes are denied via
RLS (no write policy).

```sql
id         UUID PK DEFAULT gen_random_uuid()
skill_id   UUID NOT NULL FK → skills(id) ON DELETE RESTRICT
version    INT NOT NULL
steps      JSONB NOT NULL CHECK (jsonb_typeof(steps) = 'array')
created_at TIMESTAMPTZ NOT NULL DEFAULT now()
updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
UNIQUE (skill_id, version)
```

`steps` is an ordered array of per-step objects
`{ key, label, requires_photo, requires_signature, sets_status, advances_on }` —
the canonical step/label data the engine reads (Story 4.4). Since migration 37
the shape is enforced by `workflow_steps_valid(steps)` (IMMUTABLE plpgsql
validator) plus a CHECK constraint on the table: non-empty array of objects
with unique slug keys (`^[a-z0-9_]{1,64}$`), non-empty labels, boolean
flags, `sets_status ∈ ('in_progress','completed') | null` and
`advances_on ∈ ('photo_confirm') | null`. The v1 seed is one identical
6-step chain per skill; the template's ordered steps ARE the workflow chain —
the only legal advance is the first not-yet-completed step (Story 4.4). Fixed
template seed UUIDs:

| skill          | template id (v1)                       |
|----------------|----------------------------------------|
| Plumbing       | 6f1a2b3c-4d5e-4f6a-8b7c-1d2e3f4a5b6c   |
| Electrical     | 7f2b3c4d-5e6f-4a7b-8c8d-2e3f4a5b6c7d   |
| AC Service     | 8a3c4d5e-6f7a-4b8c-9d9e-3f4a5b6c7d8e   |
| AC Installation | 9b4d5e6f-7a8b-4c9d-8e8f-4a5b6c7d8e9f  |
| Pest Control   | ac5e6f7a-8b9c-4dae-8f9a-5b6c7d8e9f0a   |
| Cleaning       | bd6f7a8b-9cad-4ebf-8aab-6c7d8e9f0a1b   |

Operational rule: **every new skill seed must ship its template row in the same
migration.** A skill without any template row makes `create_job_with_log` raise
"No workflow template found for skill" — a plain server fault by design (500),
not a handled client error.

## Atomic RPCs

These are called via `supabase.rpc()` from the application layer. Each runs in
a single Postgres transaction — **never** split into multiple sequential
`supabase.from()` calls (see AR-10).

| RPC                              | Purpose |
|----------------------------------|---------|
| `setup_tenant_for_owner(...)`    | Idempotent upsert of tenant + sets `users.tenant_id` atomically |
| `create_job_with_log(...)`       | Increments `job_sequences` + inserts `jobs` (stamping the skill's latest `workflow_templates` version) + inserts `activity_logs` row — one txn |
| `update_job_with_log(...)`       | Updates `jobs` + inserts `activity_logs` row — one txn |
| `advance_workflow_step(...)`     | Compare-and-set on `current_step` (PT409 on mismatch/terminal), appends `step_<key>` log, notifies owner — one txn |
| `confirm_attachment(...)`        | Inserts `attachments` row from `attachment_uploads` (conflict resolution), then — if the first photo landed on the template's `advances_on: 'photo_confirm'` step with `current_step` at its predecessor — delegates to `advance_workflow_step` (PT409 swallowed + logged: the attachment always commits) — one txn |
| `increment_job_counter(...)`     | Sub-RPC: race-safe per-tenant/per-year counter |

## RLS Posture Summary

- **Tenant-scoped tables** (`customers`, `jobs`,
  `attachments`, `attachment_uploads`, `idempotency_log`): policy reads
  `(auth.jwt() ->> 'tenantId')::uuid`
- **`user_skills`**: tenant-isolated transitively — the policy joins into
  `users` and matches `users.tenant_id` against the JWT `tenantId` (the table
  has no `tenant_id` column of its own)
- **Global reference tables** (`skills`): SELECT-only policy TO `authenticated`
  (no tenant scoping); no write policies — client writes are RLS-denied
- **`users`**: more permissive — a user can read their own row OR any same-tenant row
- **`tenants`**: owner can read their own tenant only
- **Writes**: most client writes are blocked; service role + RPCs do the
  mutations. This is the **AR-20** enforcement layer (defense-in-depth).

## Key Indexes

| Index                                          | Purpose |
|------------------------------------------------|---------|
| `users(phone)`                                 | Phone lookup (OTP verify) |
| `users(tenant_id)`                             | Tenant membership lookup |
| `customers(tenant_id, country_code, phone_number)` UNIQUE | One customer per phone per tenant |
| `idx_jobs_tenant_updated_at` (covering)        | Delta sync query (Story 4.1) |

## How to Add a New Table

1. Create a new migration `supabase/migrations/YYYYMMDDhhmmss_<name>.sql`
2. Define the table + RLS policy
3. Apply via Supabase MCP `apply_migration` (do NOT run ad-hoc SQL — see project-context.md)
4. Add the table to `docs/data-models.md`
5. If client reads/writes are needed, add an `rpc_<action>` for any atomic mutation
6. Update the integration RLS test (`test/integration/rls-isolation.integration.spec.ts`) if it covers your table