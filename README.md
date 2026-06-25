# fenzit-be — Jobzo Backend

Field-service management backend for Indian HVAC / pest-control technician
dispatch. A multi-tenant NestJS API that handles phone-OTP authentication,
company onboarding, customer & job management, technician workflow, R2
attachment uploads, and offline sync for the mobile apps.

> **Status:** Active development. All four planned epics delivered:
> **Epic 1** (auth/tenancy), **Epic 2** (customers), **Epic 3** (job lifecycle),
> **Epic 4** (offline sync). Phase 1 only — see *Phase 1 vs Production Status*
> in [Development Guide](./docs/development-guide.md#phase-1-vs-production-status)
> for pre-launch blockers.

## Stack

| Concern | Choice |
|---|---|
| Runtime | Bun ≥ 1.3.13 |
| Framework | NestJS v11 on Fastify v5 |
| Language | TypeScript 5.7 (NodeNext ESM) |
| Database | Supabase Postgres (RLS on every table) |
| Cache | `@nestjs/cache-manager` (in-memory, OTP sessions) |
| Auth | Phone OTP → custom JWT (`@nestjs/jwt`, 7d) |
| Object storage | Cloudflare R2 (presigned PUT) |
| API docs | Swagger UI at `/api/docs` (non-prod only) |
| Tests | Jest + ts-jest + supertest |

## Project Documentation

Start here: **[docs/index.md](./docs/index.md)**

- [Project Overview](./docs/project-overview.md)
- [Architecture](./docs/architecture.md) — modular monolith, AR-* rules
- [Source Tree Analysis](./docs/source-tree-analysis.md)
- [API Contracts](./docs/api-contracts.md) — all endpoints with bodies + responses
- [Data Models](./docs/data-models.md) — 13 tables + 6 atomic RPCs
- [Development Guide](./docs/development-guide.md) — setup, scripts, testing

Planning artifacts (BMAD): `_bmad-output/planning-artifacts/`

## Quickstart

```bash
# 1. Install dependencies
bun install

# 2. Configure environment
cp .env.example .env
# Then fill in real Supabase + Cloudflare R2 + WORKER_WEBHOOK_SECRET values.
# All vars are validated at boot by Joi; missing values fail fast.

# 3. Apply database migrations
# Use the Supabase MCP — see project-context.md for the rules.
# Never run migrations via raw psql outside of a migration file.

# 4. Start dev server (watch mode)
bun run start:dev
```

API is mounted at `http://localhost:3000/api/v1`. Swagger UI is at
`http://localhost:3000/api/docs` in non-production environments. Liveness
probe at `GET /health`.

## Scripts

| Script | Purpose |
|---|---|
| `bun run start` | Production-style start (no watch) |
| `bun run start:dev` | Watch mode (recommended for dev) |
| `bun run start:debug` | Watch + Node inspector |
| `bun run start:prod` | Run pre-built `dist/main` |
| `bun run build` | Compile TypeScript → `dist/` |
| `bun run lint` | ESLint with autofix |
| `bun run format` | Prettier write |
| `bun run test` | Unit tests (Jest, `*.spec.ts` under `src/`) |
| `bun run test:cov` | Coverage report → `coverage/` |
| `bun run test:e2e` | E2E + integration suite (uses `test/jest-e2e.json`) |
| `bun run test:e2e -- rls-isolation` | **Hard launch blocker** for any RLS change (AR-20) |

## Project Structure

```
src/
├── main.ts                 # Bootstrap (Fastify, /api/v1 prefix, Swagger)
├── app.module.ts           # Root module + global guards/filters/interceptors
├── auth/                   # OTP, JWT, invite, company setup
├── customers/              # Owner-side customer CRUD
├── jobs/                   # Job lifecycle, workflow steps, attachments
├── skills/                 # Per-tenant skill catalog
├── storage/                # R2 storage primitives
├── sync/                   # Technician delta sync (Epic 4)
├── webhooks/               # Cloudflare Worker storage events (HMAC-verified)
├── tenants/                # Tenant entities (used by auth)
├── supabase/               # SupabaseModule — per-request JWT client factory
├── common/                 # Shared decorators, guards, interceptors, filters
└── health/                 # Public liveness probe

supabase/migrations/        # 22 SQL migrations — schema, RLS, atomic RPCs
test/                       # E2E + integration suites (incl. RLS isolation)
docs/                       # ← Full project documentation
```

See [docs/source-tree-analysis.md](./docs/source-tree-analysis.md) for an
annotated tree.

## Hard Rules (non-obvious — read before contributing)

These come from `_bmad-output/planning-artifacts/epics.md` (AR-* lines 71-115):

- **AR-7** — Custom JWT signed with `SUPABASE_JWT_SECRET`, 7-day expiry.
- **AR-8** — OTP sessions live in `cache-manager` (in-memory), **not** a DB table.
- **AR-9** — Idempotency via `idempotency_log` table (UNIQUE on `key, tenant_id`),
  cleaned by `pg_cron` after 24 hours.
- **AR-10** — Multi-step mutations go through `supabase.rpc()`. **Never** two
  sequential `supabase.from()` calls for what must be atomic.
  *(Violations exist in `findOrCreateUser` + `inviteTechnician` — pre-existing,
  see deferred-work.md.)*
- **AR-13** — `JwtAuthGuard` + `RolesGuard` are global; `@Public()` bypasses.
- **AR-17** — All required env vars validated at boot via Joi; missing values
  crash the process with a descriptive error.
- **AR-20** — `test/integration/rls-isolation.integration.spec.ts` must pass
  before any merge that touches RLS, RPCs, or any tenant-scoped table.
  *(Always skipped in CI today — see deferred-work.md infra gap.)*
- **AR-22** — Fastify `ignoreTrailingSlash` is on so POST/PUT bodies survive
  path normalization (a 301 would drop them).
- **No `@fastify/multipart`** — uploads are presigned PUT to R2 only.
- **No `jose` / `jsonwebtoken`** — use `@nestjs/jwt`.
- **No service-role-bypass in tests** — always use a real JWT.
- **No raw SQL outside migrations** — apply via Supabase MCP only.

Full rationale: `_bmad-output/planning-artifacts/architecture.md` and
`_bmad-output/planning-artifacts/epics.md`.

## Environment Variables

All required, validated at boot by `Joi` (see `src/app.module.ts`).

| Var | Required | Purpose |
|---|---|---|
| `NODE_ENV` | yes (default `development`) | Toggles Swagger UI |
| `PORT` | yes (default `3000`) | Listen port |
| `SUPABASE_URL` | yes | Project URL |
| `SUPABASE_ANON_KEY` | yes | Public anon key |
| `SUPABASE_JWT_SECRET` | yes (≥32 chars) | HMAC secret for JWT signing |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Service role key (RLS-bypass for RPCs) |
| `CLOUDFLARE_R2_ACCOUNT_ID` / `_ACCESS_KEY` / `_SECRET_KEY` / `_BUCKET` | yes | R2 credentials |
| `WORKER_WEBHOOK_SECRET` | yes (≥32 chars) | HMAC for `/internal/webhooks/storage` |
| `MAX_ATTACHMENT_SIZE_BYTES` | no | Cap on client-reported size (default 50 MB) |

## License

UNLICENSED — private project.