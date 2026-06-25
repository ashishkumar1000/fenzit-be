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

Full architecture: `_bmad-output/planning-artifacts/architecture.md`
Full epic/story breakdown: `_bmad-output/planning-artifacts/epics.md`
