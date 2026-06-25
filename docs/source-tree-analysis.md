# Source Tree Analysis

This is the annotated source tree for `fenzit-be` (Jobzo Backend). Critical folders
are marked with purpose annotations.

```
fenzit-be/
├── README.md                            # Generic NestJS scaffold (unchanged)
├── package.json                         # Bun runtime, NestJS v11, Fastify v5
├── bun.lock                             # Bun lockfile (do not regenerate with npm)
├── tsconfig.json                        # NodeNext ESM, strictNullChecks, target ES2023
├── tsconfig.build.json                  # Build-mode tsconfig (extends tsconfig.json)
├── nest-cli.json                        # NestJS CLI config (sourceRoot: src)
├── eslint.config.mjs                    # Flat ESLint config + Prettier integration
│
├── .env.example                         # Required env vars (Supabase, R2, webhook)
├── .env                                 # (gitignored) local secrets
│
├── project-context.md                   # Hand-written project context for AI agents
├── docs/                                # ← THIS directory (project documentation)
│
├── src/                                 # Application source (NestJS sourceRoot)
│   ├── main.ts                          # ⏵ ENTRY POINT: bootstraps Fastify app,
│   │                                    #   sets /api/v1 prefix, mounts Swagger in non-prod
│   ├── app.module.ts                    # ⏵ Root module: ConfigModule, JwtModule,
│   │                                    #   CacheModule, APP_GUARD JwtAuthGuard+RolesGuard,
│   │                                    #   APP_FILTER GlobalExceptionFilter,
│   │                                    #   APP_INTERCEPTOR LoggingInterceptor
│   │
│   ├── auth/                            # Auth & onboarding
│   │   ├── auth.module.ts
│   │   ├── auth.controller.ts           # POST /api/v1/auth/otp/{send,verify},
│   │   │                                #   POST /api/v1/auth/invite (owner only),
│   │   │                                #   POST /api/v1/auth/company (owner only)
│   │   ├── auth.service.ts              # OTP issuance, JWT mint, invite, tenant upsert
│   │   ├── dto/                         # SendOtpDto, VerifyOtpDto, SetupCompanyDto,
│   │   │                                #   InviteTechnicianDto
│   │   └── enums/                       # (skill type enum, etc.)
│   │
│   ├── customers/                       # Customer management (owner only)
│   │   ├── customers.module.ts
│   │   ├── customers.controller.ts      # POST/GET /api/v1/customers, GET /:id
│   │   ├── customers.service.ts         # create / list (cursor 50) / detail with jobs
│   │   └── dto/                         # CreateCustomerDto, ListCustomersQueryDto
│   │
│   ├── jobs/                            # Job lifecycle, workflow, attachments
│   │   ├── jobs.module.ts
│   │   ├── jobs.controller.ts           # POST/GET/PATCH /api/v1/jobs,
│   │   │                                #   POST /:id/workflow, /:id/attachments, /:id/attachments/:uploadId/confirm
│   │   ├── jobs.service.ts              # createJob, listJobs (cursor paginated,
│   │   │                                #   IST-day filter), getJobDetail, updateJob
│   │   ├── workflow.service.ts          # advanceWorkflowStep (RPC: rpc_advance_workflow_step)
│   │   ├── attachments.service.ts       # Two-phase R2 upload (request → PUT → confirm)
│   │   ├── dto/                         # CreateJobDto, UpdateJobDto, ListJobsQueryDto,
│   │   │                                #   AdvanceWorkflowDto, UploadAttachmentDto,
│   │   │                                #   ConfirmAttachmentDto
│   │   └── enums/                       # JobStatus, WorkflowStep, SkillType (used by jobs)
│   │
│   ├── skills/                          # Per-tenant skill catalog (owner only)
│   │   ├── skills.module.ts
│   │   ├── skills.controller.ts         # POST/GET/DELETE /api/v1/skills
│   │   ├── skills.service.ts            # create / list / delete (cascades to technicians)
│   │   └── dto/                         # CreateSkillDto
│   │
│   ├── storage/                         # R2 storage primitives (used by attachments)
│   │   └── (presigned URL helpers)
│   │
│   ├── sync/                            # Technician delta sync (Epic 4)
│   │   ├── sync.module.ts
│   │   ├── sync.controller.ts           # POST /api/v1/sync (technician only)
│   │   ├── sync.service.ts              # Returns jobs updated since lastSyncedAt
│   │   │                                #   (uses delta_sync_index from migration 11)
│   │   └── dto/                         # SyncRequestDto, SyncResponseDto
│   │
│   ├── webhooks/                        # Cloudflare Worker → backend storage events
│   │   ├── webhooks.module.ts
│   │   ├── webhooks.controller.ts       # POST /internal/webhooks/storage (Public)
│   │   ├── webhooks.service.ts          # HMAC verify + process + reconcile attachments
│   │   └── dto/                         # StorageEventDto
│   │
│   ├── tenants/                         # Tenant entities (used by AuthModule)
│   │   ├── entities/                    # (Plain TS interfaces mirrored from Postgres)
│   │   └── (no controller — internal)
│   │
│   ├── supabase/                        # ⏵ SupabaseModule — per-request JWT client
│   │   └── supabase.module.ts           # SupabaseClientFactory: DEFAULT-scoped
│   │                                    #   singleton, factory.create(jwt) per request
│   │
│   ├── common/                          # ⏵ Shared cross-cutting concerns
│   │   ├── decorators/                  # @Public, @Roles, @CurrentUser
│   │   ├── dto/                         # Pagination DTOs
│   │   ├── enums/                       # Role, etc.
│   │   ├── factories/                   # SupabaseClientFactory
│   │   ├── filters/                     # GlobalExceptionFilter
│   │   ├── guards/                      # JwtAuthGuard (global), RolesGuard (global)
│   │   ├── interceptors/                # LoggingInterceptor, IdempotencyInterceptor
│   │   ├── interfaces/                  # RequestUser, etc.
│   │   └── utils/                       # (helpers)
│   │
│   └── health/                          # Liveness probe (public)
│       └── health.controller.ts         # GET /health (excluded from /api/v1 prefix)
│
├── supabase/                            # Co-located Postgres migrations (see data-models.md)
│   └── migrations/                      # 22 migrations, numbered YYYYMMDDhhmmss_*.sql
│
├── test/                                # E2E + integration test suites
│   ├── jest-e2e.json                    # Jest config for e2e
│   ├── jest.env.setup.ts                # Loads .env before tests
│   ├── app.e2e-spec.ts                  # App-level smoke test
│   ├── auth.integration.spec.ts         # OTP + JWT + invite
│   ├── company.e2e-spec.ts              # Tenant setup
│   ├── customers.e2e-spec.ts            # Customer CRUD
│   ├── invite.e2e-spec-spec.ts          # Invite flow
│   ├── jobs.e2e-spec.ts                 # Job CRUD + workflow + attachments
│   ├── skills.e2e-spec.ts               # Skill CRUD
│   ├── sync.e2e-spec.ts                 # Delta sync endpoint
│   ├── idempotency.e2e-spec.ts          # Idempotency-Key replay
│   ├── conflict-resolution.e2e-spec.ts  # Server-side conflict resolution
│   └── integration/
│       └── rls-isolation.integration.spec.ts  # ⏵ HARD LAUNCH BLOCKER (AR-20)
│
├── scripts/                             # Dev scripts (not part of build)
│   └── probe-r2.ts                      # Probe Cloudflare R2 credentials
│
├── cloudflare-worker/                   # (External; consumes webhooks API)
│
└── _bmad/                               # BMAD workflow state + plans
    ├── bmm/config.yaml                  # bmm module config
    └── custom/                          # Workflow customization
```

## Entry Points

| Entry Point            | Purpose                              |
|------------------------|--------------------------------------|
| `src/main.ts`          | Process bootstrap, Fastify adapter, global prefix `/api/v1`, Swagger at `/api/docs` (non-prod) |
| `src/app.module.ts`    | Root DI module; registers global guards/filters/interceptors |
| `src/health/health.controller.ts` | Public health probe at `/health` |
| `supabase/migrations/` | Database schema + RLS + atomic RPCs |

## Critical Folder Quick Reference

| Folder                            | What lives here                           | Rule |
|-----------------------------------|-------------------------------------------|------|
| `src/common/`                     | Cross-cutting decorators/guards/filters   | Never import from feature modules — only the other way |
| `src/supabase/`                   | JWT-scoped Supabase client factory        | All other modules depend on this |
| `supabase/migrations/`            | Atomic DDL + RPC functions                | Never run ad-hoc SQL outside a migration (project-context.md) |
| `test/integration/rls-isolation.integration.spec.ts` | Multi-tenant RLS test | MUST pass before merge (AR-20) |

## Multi-Part?

No — single NestJS app. The `cloudflare-worker/` sibling is a separate
deployment (not part of this monorepo's build); it integrates only via the
`/internal/webhooks/storage` endpoint.