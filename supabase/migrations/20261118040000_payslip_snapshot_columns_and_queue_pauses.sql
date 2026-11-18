-- 23-8: payslip snapshot columns + the per-tenant report-queue pause table.
-- Applied to the live project via Supabase MCP on 2026-11-18 (out-of-band,
-- mid-build); this file makes the change replayable in a fresh environment —
-- every clause is guarded so replaying on the already-migrated DB is a no-op.

-- The Form V snapshot gains the two fields the PDF renders from the tenant
-- and the attendance grid (establishment address; the "days worked" bucket).
alter table public.payroll_payslips
  add column if not exists establishment_address text,
  add column if not exists days_worked numeric(6, 2);

-- The report-queue pause, per tenant: one row per company (the pause API's
-- storage and every worker's paused-tenant read). A tenant's delete removes
-- its row; RLS stays deny-by-default — only the service role touches it.
create table if not exists public.report_queue_pauses (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  paused boolean not null default false,
  paused_until timestamptz,
  paused_by uuid references public.users (id),
  paused_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.report_queue_pauses enable row level security;
