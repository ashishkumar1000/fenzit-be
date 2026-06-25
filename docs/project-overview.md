# Project Overview — fenzit-be (Jobzo Backend)

## Executive Summary

`fenzit-be` is the **Jobzo** backend — a field-service management API for Indian
HVAC/pest-control technician dispatch. It is a single-tenant-per-company
multi-tenant NestJS service that issues phone-based OTP authentication,
manages customers, dispatches jobs through a fixed workflow, and coordinates
attachments stored in Cloudflare R2. Mobile clients (technician + owner) and a
Cloudflare Worker (storage event webhook) integrate through this API.

The codebase has **all four planned epics delivered** (per
`_bmad-output/planning-artifacts/epics.md`):

- **Epic 1 — Project Foundation & Authentication**: phone OTP, JWT, tenants, skills, RBAC guards
- **Epic 2 — Customer Management**: customers CRUD, search, profile with job history
- **Epic 3 — Job Lifecycle**: jobs CRUD, technician assignment, 6-step workflow, R2 attachments, activity log
- **Epic 4 — Offline-First Mobile Sync**: delta-sync endpoint, idempotent action replay, server-side conflict resolution

## Repository Structure

- **Type:** Monolith (single NestJS app + co-located Supabase migrations)
- **Primary Language:** TypeScript 5.7 (`strictNullChecks: true`, NodeNext ESM)
- **Architecture Pattern:** Modular monolith (feature modules + shared `common/`)

## Tech Stack Summary

| Category       | Technology                                | Version  | Justification |
|----------------|-------------------------------------------|----------|---------------|
| Runtime        | Bun                                       | 1.3.13+  | Fast startup; required for OTP caching |
| Framework      | NestJS (Fastify adapter)                  | v11      | Module boundaries, DI, decorators |
| HTTP           | Fastify                                   | v5       | Lower overhead vs Express; supports `ignoreTrailingSlash` (AR-22) |
| ORM/DB driver  | `@supabase/supabase-js`                   | ^2.108   | Direct Postgres + PostgREST RPC |
| Database       | Supabase Postgres                         | managed  | Row-Level Security enforces tenancy |
| Cache          | `@nestjs/cache-manager`                   | ^3.1.3   | In-memory OTP sessions (AR-8) |
| Auth           | `@nestjs/jwt` + Supabase JWT secret       | ^11      | Custom-issued JWTs, 7d expiry |
| Validation     | `class-validator` + `class-transformer`   | latest   | DTO validation, `ValidationPipe` |
| Config         | `@nestjs/config` + Joi                   | ^4 / ^18 | Joi schema validates `.env` |
| Object storage | Cloudflare R2 via `@aws-sdk/client-s3`    | ^3.1073  | S3-compatible API, presigned PUTs |
| API docs       | `@nestjs/swagger`                         | ^11      | Swagger UI at `/api/docs` (non-prod) |
| Testing        | Jest + ts-jest + supertest                | ^30      | Unit + e2e (see `test/`) |
| Linting        | ESLint + Prettier                         | ^9 / ^3  | `eslint.config.mjs` flat config |

## Architecture Type

- **Repository type:** Monolith
- **Parts:** 1 (the API server)
- **External integrations:** Supabase Postgres (data + RLS), Cloudflare R2
  (attachments), Cloudflare Worker (storage event webhook → `internal/webhooks/storage`)

## High-Level Module Map

```
src/
├── auth/         # OTP, JWT issuance, invite, company setup
├── common/       # Shared guards, decorators, filters, factories, interceptors
├── customers/    # Owner-side customer CRUD
├── health/       # Liveness probe (public)
├── jobs/         # Job lifecycle, workflow steps, attachments
├── skills/       # Per-tenant skill catalog
├── storage/      # (used by webhooks + jobs for R2 coordination)
├── supabase/     # SupabaseModule — per-request JWT-scoped client factory
├── sync/         # Technician delta-sync endpoint
├── tenants/      # Tenant entities (used by auth for invite acceptance)
└── webhooks/     # Public, signature-verified storage event receiver
```

## Module Dependency Direction

```
app.module (root)
 ├── AuthModule      → SupabaseModule, CacheModule
 ├── SkillsModule    → SupabaseModule
 ├── CustomersModule → SupabaseModule
 ├── JobsModule      → SupabaseModule
 ├── StorageModule   → SupabaseModule
 ├── WebhooksModule  → SupabaseModule
 └── SyncModule      → SupabaseModule
```

All feature modules depend on `SupabaseModule` (per-request JWT client factory);
no module depends on another feature module.

## External Integration Surface

| Caller              | Mechanism                              | Auth                          |
|---------------------|----------------------------------------|-------------------------------|
| Mobile (Owner)      | HTTPS REST `POST/GET/PATCH/DELETE /api/v1/*` | Bearer JWT (7d)         |
| Mobile (Technician) | Same as Owner but with technician role | Bearer JWT (7d)               |
| Cloudflare Worker   | `POST /internal/webhooks/storage`      | Shared secret header          |
| Postgres            | `supabase.rpc()` for atomic operations | RLS via JWT claims            |
| Cloudflare R2       | Presigned `PUT` URLs (mobile uploads)  | URL signature (time-limited)  |

## Generated Documentation

- [Architecture](./architecture.md)
- [Source Tree Analysis](./source-tree-analysis.md)
- [API Contracts](./api-contracts.md)
- [Data Models](./data-models.md)
- [Development Guide](./development-guide.md)

## Next Steps

When creating new features, start by referencing:

1. `architecture.md` for module boundaries and AR-* rules
2. `api-contracts.md` for endpoint shapes and auth requirements
3. `data-models.md` for table ownership and RLS posture
4. `development-guide.md` for the local dev loop and testing pattern