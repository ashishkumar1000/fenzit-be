# Project Context — fenzit-be (Jobzo Backend)

## Supabase MCP — Use This for All Database Work

A Supabase MCP server is configured for this project (`.mcp.json`). **Every dev agent should use it** instead of writing raw SQL scripts or guessing schema details.

### When to use the Supabase MCP

- **Before writing a migration** — inspect existing tables and columns to avoid conflicts
- **After writing a migration** — apply it via MCP to verify it runs clean
- **When debugging a query** — run it against the real DB to confirm results
- **When implementing a repository** — verify column names, types, and constraints match the code
- **When writing RLS policies** — test them against real data with different JWT claims

### How to use it

The MCP is available as `mcp__supabase__*` tools. Key operations:

- **List tables / inspect schema** — use before implementing any repository
- **Execute SQL** — run migrations and ad-hoc queries directly
- **Apply RLS policies** — test isolation with different tenant JWTs

### Important rules

1. **Never write two sequential Supabase calls for what must be atomic** — use `supabase.rpc()` (see AR-10 in architecture.md)
2. **Never bypass RLS** — all test queries must use a proper JWT, not the service role key
3. **Migration files live in `supabase/migrations/`** — always write a `.sql` file AND apply it via MCP; never apply ad-hoc SQL without a migration file
4. **Run the RLS cross-tenant isolation test** (`test/integration/rls-isolation.integration.spec.ts`) after any RLS policy change — this is a hard launch blocker (AR-20)
5. **Every new or changed-signature DB function must revoke public EXECUTE and grant explicit service_role EXECUTE in its own migration** (see `supabase/migrations/20260925000001` for the revokes and `20260925000003` for the explicit service_role grants — together they are the pattern). Postgres grants EXECUTE to PUBLIC at function creation, CREATE OR REPLACE preserves existing ACLs, but a changed signature mints a NEW pg_proc entry that starts with the default grants again. Default privileges (migration `20260925000003`) already deny PUBLIC for postgres-created functions, so most new functions are safe by default — the per-function statements are still mandatory so the app's `createAdmin()` RPC path never depends on default-privilege history.
6. **Minimise stored procedures — business logic lives in NestJS application code, not DB functions** (user decision 2026-09-21, commit `87bc201`). Do not create new DB functions/RPCs for business logic. When a write needs atomicity, prefer a single **guarded UPDATE** from backend app code (`UPDATE ... WHERE id = ? AND tenant_id = ? AND <guard predicate>` — atomic in Postgres; zero rows updated means conflict/already-claimed; see the 12-3 report worker). The legacy job/workflow RPCs predate this decision; do not add new ones, and do not extend the legacy ones. The six existing job/workflow RPCs are locked down (rule 5) but slated for eventual migration to app code.

## Project: fenzit-be (Jobzo)

Field-service management backend for Indian HVAC/pest-control technician dispatch.

- **Stack**: NestJS v11 + Fastify v5 + Bun v1.3.13
- **Database**: Supabase (PostgreSQL) with RLS on every table
- **Storage**: Cloudflare R2 (direct mobile upload via presigned PUT)
- **Auth**: Custom JWT issued by NestJS, signed with `SUPABASE_JWT_SECRET`

## Architecture Quick Reference

| Concern | Decision |
|---|---|
| OTP sessions | In-memory cache (`@nestjs/cache-manager`), NOT a DB table |
| Activity log atomicity | `supabase.rpc()` — never two sequential `supabase.from()` calls |
| SupabaseClientFactory | DEFAULT-scoped singleton; call `factory.create(jwt)` per-method |
| Roles | `owner` and `technician` only (Phase 1) |
| JWT library | `@nestjs/jwt` — do not use `jose` or `jsonwebtoken` directly |
| File uploads | `@fastify/multipart` NOT used — presigned PUT URLs only |

Full architecture: `fenzo-meta/docs/repos/fenzit-be/bmad-history/planning-artifacts/architecture.md`
Full epic/story breakdown: `fenzo-meta/docs/repos/fenzit-be/bmad-history/planning-artifacts/epics.md`
