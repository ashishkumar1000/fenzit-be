-- Story 23-6 (CAP-3/5): the run engine's tables. DDL only — zero functions
-- and zero triggers (services stamp updated_at); deny-by-default RLS with
-- service_role-only grants on every table (house idiom).

create table public.payroll_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  month text not null check (month ~ '^\d{4}-\d{2}$'),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'completed', 'failed')),
  initiated_by uuid not null,
  started_at timestamptz,
  finished_at timestamptz,
  summary jsonb not null default '{}'::jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index payroll_runs_tenant_month_idx
  on public.payroll_runs (tenant_id, month, status);

create table public.payroll_payslips (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  membership_id uuid not null,
  user_id uuid not null,
  run_id uuid not null references public.payroll_runs (id) on delete cascade,
  salary_period text not null check (salary_period ~ '^\d{4}-\d{2}$'),
  slip_number text not null,
  -- Form V + product snapshot (CAP-7 renders from this row).
  employee_name text,
  employee_code text,
  father_name text,
  mother_name text,
  spouse_name text,
  designation text,
  department text,
  pan text,
  uan_number text,
  bank_account_number text,
  ifsc_code text,
  bank_name text,
  date_of_joining date,
  establishment_name text,
  wage_period_start date,
  wage_period_end date,
  divisor_convention text,
  cutoff_day int,
  pay_date int,
  payable_days numeric(6, 2) not null,
  lop_days numeric(6, 2) not null,
  paid_days numeric(6, 2) not null,
  gross_earnings numeric(18, 2) not null,
  pf_employee numeric(18, 2) not null default 0,
  pf_employer numeric(18, 2) not null default 0,
  tds numeric(18, 2) not null default 0,
  other_deductions numeric(18, 2) not null default 0,
  total_deductions numeric(18, 2) not null default 0,
  net_wages numeric(18, 2) not null,
  earning_lines jsonb not null default '[]'::jsonb,
  deduction_lines jsonb not null default '[]'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, salary_period, membership_id)
);

create table public.payroll_run_overrides (
  tenant_id uuid not null,
  membership_id uuid not null,
  month text not null check (month ~ '^\d{4}-\d{2}$'),
  field text not null check (field in ('pf_employee', 'tds')),
  amount numeric(18, 2) not null check (amount >= 0),
  acknowledged boolean not null check (acknowledged),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, membership_id, month, field)
);

create table public.payroll_recovery_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  membership_id uuid not null,
  month_raised text not null,
  original_amount numeric(18, 2) not null,
  outstanding_amount numeric(18, 2) not null check (outstanding_amount >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.payroll_slip_sequences (
  tenant_id uuid not null,
  salary_period text not null,
  last_seq int not null default 0,
  primary key (tenant_id, salary_period)
);

alter table public.payroll_payslips
  add foreign key (membership_id, tenant_id)
    references public.memberships (id, tenant_id) on delete cascade;

alter table public.payroll_runs enable row level security;
alter table public.payroll_payslips enable row level security;
alter table public.payroll_run_overrides enable row level security;
alter table public.payroll_recovery_lines enable row level security;
alter table public.payroll_slip_sequences enable row level security;

revoke all on public.payroll_runs from public, anon, authenticated;
revoke all on public.payroll_payslips from public, anon, authenticated;
revoke all on public.payroll_run_overrides from public, anon, authenticated;
revoke all on public.payroll_recovery_lines from public, anon, authenticated;
revoke all on public.payroll_slip_sequences from public, anon, authenticated;

grant select, insert, update, delete on public.payroll_runs to service_role;
grant select, insert, update, delete on public.payroll_payslips to service_role;
grant select, insert, update, delete on public.payroll_run_overrides to service_role;
grant select, insert, update, delete on public.payroll_recovery_lines to service_role;
grant select, insert, update, delete on public.payroll_slip_sequences to service_role;
