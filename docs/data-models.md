# Data Models — fenzit-be

All persistent state lives in **Supabase Postgres**. Schema is defined by
timestamped SQL files in `supabase/migrations/`. Every table has **Row-Level
Security (RLS)** enabled.

## Migrations Inventory

22 migrations, applied in chronological order. New migrations **must** be
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
skill_type  TEXT                          -- technicians only
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
service_categories TEXT[] NOT NULL DEFAULT '{}'
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
job_number    TEXT  -- e.g. "2026-000123"
status        TEXT  -- scheduled | in_progress | completed | cancelled
service_type, service_location TEXT
scheduled_start, scheduled_end TIMESTAMPTZ
description, priority, notes_for_technician TEXT
require_completion_photo BOOLEAN
sequence_index INT  -- per-job workflow step pointer
created_at, updated_at TIMESTAMPTZ
```

**RLS:** Tenant isolation on reads; writes only via RPCs (service role).

### `activity_logs`

Append-only audit trail for job mutations. One row per state transition.

```sql
id          UUID PK
job_id      UUID FK → jobs(id) ON DELETE CASCADE
actor_id    UUID FK → users(id)
action      TEXT  -- 'created' | 'updated' | 'workflow_advanced' | ...
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

### `tenant_skills`

Per-tenant catalog of skills (e.g. "AC Repair", "Pest Control").

```sql
id          UUID PK
tenant_id   UUID FK → tenants(id) ON DELETE CASCADE
name        TEXT
description TEXT
UNIQUE (tenant_id, name)
```

### `user_skills`

Junction: which skills a technician has (used for matching when creating jobs).

```sql
user_id  UUID FK → users(id) ON DELETE CASCADE
skill_id UUID FK → tenant_skills(id) ON DELETE CASCADE
PRIMARY KEY (user_id, skill_id)
```

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

`pg_cron` cleanup job runs hourly (migration 12, Story 4.2) and deletes rows
older than 24h. Without this job the table grows without bound.

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

## Atomic RPCs

These are called via `supabase.rpc()` from the application layer. Each runs in
a single Postgres transaction — **never** split into multiple sequential
`supabase.from()` calls (see AR-10).

| RPC                              | Purpose |
|----------------------------------|---------|
| `setup_tenant_for_owner(...)`    | Idempotent upsert of tenant + sets `users.tenant_id` atomically |
| `create_job_with_log(...)`       | Increments `job_sequences` + inserts `jobs` + inserts `activity_logs` row — one txn |
| `update_job_with_log(...)`       | Updates `jobs` + inserts `activity_logs` row — one txn |
| `advance_workflow_step(...)`     | Validates step ordering, advances `sequence_index`, appends log — one txn |
| `confirm_attachment(...)`        | Inserts `attachments` row from `attachment_uploads`, server-side conflict resolution |
| `increment_job_counter(...)`     | Sub-RPC: race-safe per-tenant/per-year counter |

## RLS Posture Summary

- **Tenant-scoped tables** (`customers`, `jobs`, `tenant_skills`, `user_skills`,
  `attachments`, `attachment_uploads`, `idempotency_log`): policy reads
  `(auth.jwt() ->> 'tenantId')::uuid`
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