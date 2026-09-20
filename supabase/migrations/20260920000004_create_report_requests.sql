-- Report requests: state-machine table for owner PDF report generation
-- (Epic 12, Story 12-1). Lifecycle: queued → generating → ready | failed.
-- params is a jsonb object validated per report type by the app; the DB only
-- enforces that it IS an object. r2_key is unique because each request owns
-- exactly one artifact ({tenantId}/reports/{requestId}.pdf).

create table public.report_requests (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  requested_by    uuid not null references public.users(id) on delete restrict,
  report_type     text not null,
  params          jsonb not null default '{}'::jsonb,
  status          text not null default 'queued',
  locked_until    timestamptz,
  attempt_count   integer not null default 0,
  r2_key          text unique,
  file_size_bytes bigint,
  error_code      text,
  created_at      timestamptz not null default now(),
  completed_at    timestamptz,
  updated_at      timestamptz not null default now(),

  constraint report_requests_status_check
    check (status = any (array['queued'::text, 'generating'::text, 'ready'::text, 'failed'::text])),
  constraint report_requests_params_check
    check (jsonb_typeof(params) = 'object')
);

-- History list (keyset pagination, newest first) is the hot read path.
create index report_requests_tenant_created_idx
  on public.report_requests (tenant_id, created_at desc);

-- Worker poll: next queued requests only. Partial index keeps it tiny.
create index report_requests_queued_idx
  on public.report_requests (created_at)
  where status = 'queued';

-- Lease recovery scan: rows stranded in generating past their lease.
create index report_requests_generating_lease_idx
  on public.report_requests (locked_until)
  where status = 'generating';

-- Deny-by-default: no policy = no access. The single tenant-isolation policy
-- mirrors jobs/idempotency_log — every caller is scoped to the JWT's tenantId
-- claim. Role checks (owner-only endpoints) live in the service layer.
alter table public.report_requests enable row level security;

create policy report_requests_tenant_isolation on public.report_requests
  for all
  using (tenant_id = (auth.jwt() ->> 'tenantId')::uuid)
  with check (tenant_id = (auth.jwt() ->> 'tenantId')::uuid);

create trigger report_requests_updated_at
  before update on public.report_requests
  for each row execute function public.update_updated_at_column();