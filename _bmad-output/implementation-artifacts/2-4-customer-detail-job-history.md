# Story 2.4: Populate Customer Detail Job History

Status: ready-for-dev

> Gap found during frontend planning (2026-09-01): `GET /api/v1/customers/:id` still returns the Epic-2 placeholder `jobHistory: new PaginatedResponse([], null)` (customers.service.ts:426) even though the jobs table has existed since Story 3.1. The FE Customer Detail screen (fenzo-app Story 2.1) depends on this.

## Story

As an owner,
I want a customer's detail response to include their real, paginated job history,
so that the mobile Customer Detail screen can show their service record.

## Acceptance Criteria

1. **Given** an existing customer with jobs, **when** `GET /api/v1/customers/:id` is called, **then** `jobHistory` contains real rows sorted `scheduled_start DESC`, page size 20, in the standard `PaginatedResponse` envelope.
2. Each `JobHistoryItem` gains an `id: string` field (the job uuid) alongside the existing `jobNumber`, `scheduledStart`, `status`, `serviceType` — clients need it to navigate to job detail. (Additive change; no field removed.)
3. **Given** `?cursor=<opaque>` query param on the same endpoint, **then** the next history page is returned (keyset on `scheduled_start DESC, id DESC` via the existing `encodeCursor`/`decodeCursor` utils — reuse, adapting the cursor payload to `{ id, scheduledStart }` or keep `{ id, createdAt }` keyed on scheduled_start; record the choice); malformed cursor → 400 (existing decodeCursor behaviour).
4. **Given** a customer with zero jobs, **then** `jobHistory: { data: [], nextCursor: null, hasMore: false }` — unchanged empty behaviour.
5. Existing ACs of Story 2.3 (404 cross-tenant, 403 technician) unchanged; unit + e2e specs updated; the placeholder comment at customers.service.ts:90-92 and :425-427 removed.

## Tasks / Subtasks

- [ ] Add `JOB_HISTORY_PAGE_SIZE = 20` const; extend `getCustomerDetail(owner, customerId, cursor?)`; add `cursor` to a new `GetCustomerDetailQueryDto` (`@IsOptional @IsString @MaxLength(512)`), wire through the controller `@Query()`.
- [ ] History query: `admin.from('jobs').select('id, job_number, scheduled_start, status, service_type').eq('tenant_id', owner.tenantId).eq('customer_id', customerId)` + keyset predicate + `.order('scheduled_start', {ascending:false}).order('id',{ascending:false}).limit(21)`; map snake→camel; build envelope with `encodeCursor`.
- [ ] Add `id` to `JobHistoryItem`; update Swagger annotations.
- [ ] Index check: confirm an index serves `(tenant_id, customer_id, scheduled_start DESC)`; if only `idx_jobs_tenant_id_scheduled_start` exists, add `idx_jobs_customer_history` migration (tenant_id, customer_id, scheduled_start DESC, id DESC).
- [ ] Unit tests (customers.service.spec) + e2e (customers.e2e-spec): first page, second page via cursor, empty history, cross-tenant 404 unchanged.

## Dev Notes

- Follow the exact keyset pattern from jobs.service.ts#listJobs (or-predicate + limit N+1 + slice) — do not invent a new pagination style.
- Guard-order invariant (Epic 2 retro): genuine DB error → 500 FIRST, then empty → 404/empty-envelope.
- createAdmin() is the established client; keep the explicit tenant_id filters (defense-in-depth).
- Downstream consumer: fenzo-app Story 2.1 (`workspace/core/frontend/fenzo-app/_bmad-output/implementation-artifacts/2-1-customer-detail-with-job-history.md`) and the contract entry in fenzo-app `_bmad-output/planning-artifacts/api-contracts.md` §13 — update §13 when this merges.

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List

## Change Log
