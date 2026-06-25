# Development Guide — fenzit-be

## Prerequisites

- **Bun** ≥ 1.3.13 (required runtime; do not run with npm-installed node)
- **PostgreSQL** via Supabase (local or remote project)
- **Cloudflare R2** account + bucket (for attachment testing)
- A `.env` populated from `.env.example`

> **CI parity gap:** AR-18 plans for a Dockerfile + GitHub Actions test gate,
> but neither is committed yet. Local testing is the only gate today. The
> AR-20 RLS isolation test exists but is always skipped in CI (no DB
> infrastructure).

## Setup

```bash
# 1. Install dependencies
bun install

# 2. Configure environment
cp .env.example .env
# then fill in real Supabase + R2 + WORKER_WEBHOOK_SECRET values

# 3. Apply database migrations
# Use the Supabase MCP — see project-context.md for the rules.
# Never run migrations via raw psql outside of a migration file.

# 4. Start the dev server
bun run start:dev          # nest start --watch (autoreload)
```

## Available Scripts

| Script               | Purpose                                   |
|----------------------|-------------------------------------------|
| `bun run start`      | Production-style start (no watch)         |
| `bun run start:dev`  | Watch mode (recommended for dev)          |
| `bun run start:debug`| Watch + Node inspector                    |
| `bun run start:prod` | Run pre-built `dist/main`                 |
| `bun run build`      | Compile TypeScript → `dist/`              |
| `bun run lint`       | ESLint with autofix                       |
| `bun run format`     | Prettier write                            |
| `bun run test`       | Unit tests (Jest, `*.spec.ts` under `src/`) |
| `bun run test:cov`   | Coverage report → `coverage/`             |
| `bun run test:e2e`   | E2E + integration suite (uses `test/jest-e2e.json`) |
| `bun run test:debug` | Node inspector + ts-jest                  |

## Environment Variables

All required, validated by `Joi` schema in `src/app.module.ts`. Missing or
malformed values fail fast at boot.

| Var                         | Required | Purpose |
|-----------------------------|----------|---------|
| `NODE_ENV`                  | yes (defaults `development`) | Toggles Swagger UI |
| `PORT`                      | yes (defaults `3000`) | Listen port |
| `SUPABASE_URL`              | yes | Project URL |
| `SUPABASE_ANON_KEY`         | yes | Public anon key |
| `SUPABASE_JWT_SECRET`       | yes (≥32 chars) | HMAC secret for JWT signing |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Service role key (RLS-bypass for RPCs) |
| `CLOUDFLARE_R2_*`           | yes | R2 credentials + bucket |
| `WORKER_WEBHOOK_SECRET`     | yes (≥32 chars) | HMAC for `/internal/webhooks/storage` |
| `MAX_ATTACHMENT_SIZE_BYTES` | no | Cap on client-reported size (default 50 MB; INT max 2,147,483,647) |

## Project Layout (where things live)

| Want to...                          | Edit / Read                              |
|-------------------------------------|------------------------------------------|
| Add a new endpoint                  | `src/<feature>/<feature>.controller.ts`  |
| Add a new RPC                       | New migration in `supabase/migrations/`  |
| Change DTO validation               | `src/<feature>/dto/` + `class-validator` decorators |
| Add a guard / decorator / filter    | `src/common/`                            |
| Adjust RLS                           | New migration + update RLS test          |
| Change auth behavior                | `src/auth/auth.service.ts`               |
| Add a worker / scheduler            | `src/jobs/` (and the matching RPC)       |

## Testing

- **Unit tests** live next to source files (`*.spec.ts`).
- **E2E tests** live in `test/` and use `supertest`.
- **Integration tests** (RLS, real Postgres) live in `test/integration/`.
- **Coverage** from `src/` only (configured in `package.json` `jest.collectCoverageFrom`).

### Hard Launch Blocker

`test/integration/rls-isolation.integration.spec.ts` **must** pass before any
merge that touches RLS, RPCs, or any table touched by tenant policies. This is
AR-20.

```bash
bun run test:e2e -- rls-isolation
```

## Local Development Loop

1. Make schema changes via Supabase MCP `apply_migration` (writes both the SQL
   file and applies it).
2. Update the corresponding service/controller in `src/`.
3. Run the matching e2e suite: `bun run test:e2e -- <feature>`.
4. Run `bun run lint` before committing.
5. Run `/compact` after each task (per user memory).

## Code Conventions

- **No two sequential Supabase calls** for what must be atomic — use
  `supabase.rpc()` (AR-10).
- **All controllers** under `@ApiTags`, `@ApiBearerAuth` (unless `[Public]`),
  `@ApiOperation`, `@ApiResponse`.
- **All write paths** use `class-validator` DTOs + `ValidationPipe`.
- **Route ordering**: parameterless `@Get()` list routes MUST come before
  `@Get(':id')` (otherwise the catch-all shadows the list route).
- **No service-role bypassing** in test queries — always use a real JWT.
- **No `@fastify/multipart`** — uploads are presigned PUT to R2 only.
- **No raw SQL outside migrations** — apply via MCP only.

## Common Tasks

### Add a new endpoint

1. Create the DTO in `src/<feature>/dto/`.
2. Add the method to `<feature>.service.ts`.
3. Wire up the controller with `@ApiOperation`, `@ApiResponse`, role guard.
4. Add a unit test in the same folder.
5. Add an e2e test in `test/`.

### Add a new RPC

1. New file `supabase/migrations/YYYYMMDDhhmmss_rpc_<name>.sql`.
2. Inside the file: `CREATE OR REPLACE FUNCTION <name>(...) RETURNS ... LANGUAGE plpgsql SECURITY DEFINER ...`
3. Apply via Supabase MCP.
4. Add a TS wrapper in the relevant service using `supabase.rpc('<name>', { ... })`.
5. Add a unit test for the wrapper and an e2e test for the behavior.

### Verify RLS

```bash
# This is the launch blocker for any RLS-touching change
bun run test:e2e -- rls-isolation
```

## Debugging Tips

- **JWT failures**: check `SUPABASE_JWT_SECRET` matches across sign + verify.
- **OTP "any code works"**: Phase 1 mock OTP — `isValid = true` is hardcoded
  in `verifyOtp`. This is intentional for Phase 1; **do not** rely on it in
  production (deferred-work.md W1).
- **OTP lockouts**: sessions live in `cache-manager` (in-memory, not Postgres).
  Restart the dev server to clear.
- **R2 presigned URLs**: run `bun scripts/probe-r2.ts` to verify credentials.
- **Migrations out of sync**: `supabase/migrations/` is the source of truth;
  check the MCP's `list_migrations` against the filesystem.
- **`createAdmin()` RLS bypass**: tenant isolation on `customers`, `skills`,
  `auth` writes rests entirely on the app setting `tenant_id` — the service-
  role client bypasses RLS. Same pattern across write paths.

## Phase 1 vs Production Status

The codebase is **Phase 1 only** — do not deploy as-is. Pre-launch blockers
(from `_bmad-output/implementation-artifacts/deferred-work.md`):

| ID | Issue | File |
|---|---|---|
| W1 | Mock OTP — `isValid = true` hardcoded | `src/auth/auth.service.ts` |
| C1 | `createAdmin()` bypasses RLS in writes | `src/customers/customers.service.ts` (and similar) |
| AR-10 | `findOrCreateUser` + `inviteTechnician` non-atomic | `src/auth/auth.service.ts` |
| AR-20 | RLS isolation test always skipped in CI | `test/integration/rls-isolation.integration.spec.ts` |
| AR-18 | No Dockerfile, no GH Actions, no DO config | repo root |
| A2 | `sizeBytes` client-trusted | `src/jobs/dto/confirm-attachment.dto.ts` |
| CR3.6-1 | Idempotency replay returns stale presigned URL | `src/common/interceptors/idempotency.interceptor.ts` |
| — | Mock OTP delivery (`console.log` only) | `src/auth/mock-otp-delivery.provider.ts` |