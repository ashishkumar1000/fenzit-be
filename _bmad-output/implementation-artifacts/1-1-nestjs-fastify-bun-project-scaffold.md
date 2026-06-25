---
baseline_commit: NO_VCS
---

# Story 1.1: NestJS + Fastify + Bun Project Scaffold

## Story

As a developer,
I want the project bootstrapped with NestJS v11 + Fastify adapter + Bun runtime and all cross-cutting infrastructure wired (config, cache, Supabase factory, JWT guards, exception filter, logging interceptor, Swagger),
So that all feature modules have a consistent, working foundation and `GET /health` returns 200.

## Acceptance Criteria

**AC1:** Given the repo is cloned and `.env` is populated with all required vars, when `bun run start:dev` is executed, then the server starts without errors and `GET /health` returns `{ "status": "ok" }` with HTTP 200. ✅

**AC2:** Given a request arrives without an `Authorization` header on any protected route, when the global `JwtAuthGuard` processes it, then HTTP 401 is returned with `{ "statusCode": 401, "error_code": "UNAUTHORIZED", "message": "..." }`. ✅

**AC3:** Given a required env var (e.g., `SUPABASE_URL`) is missing at startup, when the app bootstraps, then the process exits immediately with a descriptive Joi validation error (fail-fast, no silent runtime failure). ✅

**AC4:** Given any unhandled exception is thrown anywhere in the app, when it passes through the `GlobalExceptionFilter`, then the response always has shape `{ "statusCode", "error_code", "message" }` with no stack trace in production. ✅

**AC5:** Given any request completes (success or error), when the `LoggingInterceptor` fires on response, then a structured JSON log is emitted containing `request_id`, `tenant_id` (or null), `route`, `http_status`, `duration_ms`. ✅

**AC6:** Given `NODE_ENV != production`, when `GET /api/docs` is requested, then the Swagger UI is served with all registered routes visible. ✅

## Tasks / Subtasks

- [x] Task 1: Project Scaffold & Dependencies
  - [x] 1.1 Initialize NestJS v11 project with Fastify adapter and Bun runtime
  - [x] 1.2 Install all required dependencies
  - [x] 1.3 Configure tsconfig.json with `experimentalDecorators: true`, `emitDecoratorMetadata: true`
  - [x] 1.4 Set up ESLint + Prettier configuration
  - [x] 1.5 Create `.env.example` with all required env vars

- [x] Task 2: Core Bootstrap & Config Module
  - [x] 2.1 Wire `reflect-metadata` as first import in `main.ts`
  - [x] 2.2 Configure NestJS with Fastify adapter in `main.ts`
  - [x] 2.3 Register AR-22 trailing slash normalization (preValidation hook with 301 redirect)
  - [x] 2.4 Set up `ConfigModule` with Joi schema validation for all required env vars
  - [x] 2.5 Set up `CacheModule` (`@nestjs/cache-manager`) with in-memory store

- [x] Task 3: Supabase Client Factory
  - [x] 3.1 Create `SupabaseClientFactory` as DEFAULT-scoped singleton
  - [x] 3.2 Factory exposes `create(jwt: string)` method
  - [x] 3.3 Wire factory into `AppModule` providers

- [x] Task 4: Error Handling Infrastructure
  - [x] 4.1 Create `ErrorCode` enum with all initial codes
  - [x] 4.2 Create `GlobalExceptionFilter` enforcing single error shape
  - [x] 4.3 Register `GlobalExceptionFilter` as `APP_FILTER`
  - [x] 4.4 Write unit tests for `GlobalExceptionFilter`

- [x] Task 5: JWT Authentication Guards
  - [x] 5.1 Create `@Public()` decorator
  - [x] 5.2 Create `JwtAuthGuard`
  - [x] 5.3 Create `RolesGuard`
  - [x] 5.4 Create `@Roles()` decorator
  - [x] 5.5 Register `JwtAuthGuard` and `RolesGuard` as `APP_GUARD`
  - [x] 5.6 Wire `@nestjs/jwt` module with `SUPABASE_JWT_SECRET`
  - [x] 5.7 Write unit tests for `JwtAuthGuard`
  - [x] 5.8 Write unit tests for `RolesGuard`

- [x] Task 6: Logging Interceptor
  - [x] 6.1 Create `LoggingInterceptor` with UUID request_id and structured JSON logging
  - [x] 6.2 Register `LoggingInterceptor` as `APP_INTERCEPTOR`
  - [x] 6.3 Write unit tests for `LoggingInterceptor`

- [x] Task 7: Common Utilities
  - [x] 7.1 Create `PaginatedResponse<T>` generic class
  - [x] 7.2 Create cursor encode/decode utility
  - [x] 7.3 Create IST day range utility
  - [x] 7.4 Write unit tests for IST day range utility

- [x] Task 8: Health Check & Swagger
  - [x] 8.1 Create `HealthController` with `GET /health` marked `@Public()`
  - [x] 8.2 Configure Swagger at `/api/docs` (disabled in production)
  - [x] 8.3 Write unit test for `HealthController`

- [x] Task 9: Final Wiring & Verification
  - [x] 9.1 Complete `AppModule` with all providers wired
  - [x] 9.2 `bun run start:dev` starts, `GET /health` returns 200 ✅ verified
  - [x] 9.3 Fail-fast on missing env var ✅ verified via Joi validation
  - [x] 9.4 All tests pass ✅ 22/22

## Dev Notes

### Architecture Requirements
- **AR-1**: Scaffold → ESLint/Prettier → ConfigModule → CacheModule → SupabaseClientFactory → ErrorCode → GlobalExceptionFilter → utilities → JWT guards → LoggingInterceptor → Swagger
- **AR-3**: `SupabaseClientFactory` DEFAULT-scoped singleton; `create(jwt)` called per-method, never stored on class
- **AR-7**: JWT shape `{ sub, tenantId, role, iat, exp }`, `@nestjs/jwt`, 7-day, signed with `SUPABASE_JWT_SECRET`
- **AR-13**: `APP_GUARD` order: JwtAuthGuard first, then RolesGuard
- **AR-14**: `GlobalExceptionFilter` → `{ statusCode, error_code, message }`. `ErrorCode` enum canonical
- **AR-15**: `LoggingInterceptor` via `APP_INTERCEPTOR`, `crypto.randomUUID()` for request_id (Node built-in, avoids ESM issues)
- **AR-22**: Fastify `preValidation` hook 301-redirects trailing-slash variants

### Implementation Notes
- `uuid` package dropped — using `crypto.randomUUID()` instead (uuid@14 is ESM-only, breaks Jest CommonJS transform)
- `@fastify/static` required as peer dep for `@nestjs/swagger` with Fastify adapter
- tsconfig already has `emitDecoratorMetadata: true` and `experimentalDecorators: true` from NestJS scaffold
- `HealthController` excludes `/health` from global prefix `api/v1` via `setGlobalPrefix` exclude option

## Dev Agent Record

### Implementation Plan
Executed bootstrap in order: scaffold → config → Supabase factory → error handling → JWT guards → logging → utilities → health → Swagger → wiring.

### Debug Log
| Issue | Resolution |
|-------|------------|
| `uuid@14` ESM-only, breaks Jest | Switched to `crypto.randomUUID()` (Node.js built-in) |
| `request.url` read-only in Fastify v5 | Used `preValidation` hook with `reply.redirect()` instead |
| `reply.redirect(301, url)` wrong signature in Fastify v5 | Fixed to `reply.redirect(url, 301)` |
| App exits silently after module init | Missing `@fastify/static` peer dep required by `@nestjs/swagger` with Fastify |
| Rust placeholder files conflicting | Removed Cargo.toml, Cargo.lock, src/main.rs, target/ per user request |

### Completion Notes
- All 9 tasks and subtasks completed
- 20 unit tests pass, 2 e2e tests pass (22 total, 0 failures)
- `GET /health` returns `{"status":"ok"}` with 200 ✅
- ConfigModule Joi validation fails fast on missing env vars ✅
- GlobalExceptionFilter enforces `{ statusCode, error_code, message }` shape ✅
- LoggingInterceptor emits structured JSON with request_id, tenant_id, route, http_status, duration_ms ✅
- Swagger UI served at `/api/docs` in non-production ✅
- JwtAuthGuard returns 401 for missing/invalid tokens, @Public() bypasses it ✅

## File List
- `.env.example`
- `package.json` (updated — added Fastify deps, removed Express)
- `bun.lockb` (updated)
- `tsconfig.json` (unchanged — decorator options already present from scaffold)
- `src/main.ts` (rewritten — Fastify adapter, trailing-slash hook, global prefix, pipes, Swagger)
- `src/app.module.ts` (rewritten — all providers wired)
- `src/app.controller.ts` (deleted)
- `src/app.service.ts` (deleted)
- `src/app.controller.spec.ts` (deleted)
- `src/common/enums/error-code.enum.ts`
- `src/common/enums/role.enum.ts`
- `src/common/interfaces/request-user.interface.ts`
- `src/common/decorators/public.decorator.ts`
- `src/common/decorators/roles.decorator.ts`
- `src/common/decorators/current-user.decorator.ts`
- `src/common/factories/supabase-client.factory.ts`
- `src/common/filters/global-exception.filter.ts`
- `src/common/filters/global-exception.filter.spec.ts`
- `src/common/guards/jwt-auth.guard.ts`
- `src/common/guards/jwt-auth.guard.spec.ts`
- `src/common/guards/roles.guard.ts`
- `src/common/guards/roles.guard.spec.ts`
- `src/common/interceptors/logging.interceptor.ts`
- `src/common/interceptors/logging.interceptor.spec.ts`
- `src/common/dto/paginated-response.dto.ts`
- `src/common/utils/cursor.util.ts`
- `src/common/utils/ist-day-range.util.ts`
- `src/common/utils/ist-day-range.util.spec.ts`
- `src/health/health.controller.ts`
- `src/health/health.controller.spec.ts`
- `test/app.e2e-spec.ts` (rewritten)
- `test/jest-e2e.json` (updated — added setupFiles)
- `test/jest.env.setup.ts` (new)

## Change Log
- 2026-06-19: Initial implementation of Story 1.1 — NestJS v11 + Fastify + Bun scaffold with all cross-cutting infrastructure (config, cache, Supabase factory, JWT guards, exception filter, logging interceptor, Swagger, health check, common utilities). Removed placeholder Rust project files.

## Status
review
