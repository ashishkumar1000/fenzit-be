-- Story 23-5 (CAP-6): deduction heads, PF-covered switch, per-employee PF
-- exclusions. DDL only — zero functions/triggers; all logic is NestJS-first.
-- Deny-by-default RLS on every table: enabled, no policies, all privileges
-- revoked from public/anon/authenticated, service_role granted (house idiom).

create table public.payroll_deduction_heads (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('flat', 'percent')),
  -- flat: a money figure ("200.00"); percent: "2.00" with 0 < p <= 100 —
  -- the service owns the shape rules, the DB only backstops non-empty text.
  amount text not null check (length(trim(amount)) > 0),
  basis text check (basis in ('basic', 'gross')),
  effective_from date not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, name, effective_from)
);

create table public.payroll_pf_config (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  effective_from date not null,
  covered boolean not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, effective_from)
);

create table public.payroll_pf_exclusions (
  tenant_id uuid not null,
  membership_id uuid not null,
  excluded boolean not null,
  updated_at timestamptz not null default now(),
  unique (tenant_id, membership_id),
  foreign key (membership_id, tenant_id)
    references public.memberships (id, tenant_id) on delete cascade
);

alter table public.payroll_deduction_heads enable row level security;
alter table public.payroll_pf_config enable row level security;
alter table public.payroll_pf_exclusions enable row level security;

revoke all on public.payroll_deduction_heads from public, anon, authenticated;
revoke all on public.payroll_pf_config from public, anon, authenticated;
revoke all on public.payroll_pf_exclusions from public, anon, authenticated;

grant select, insert, update, delete on public.payroll_deduction_heads to service_role;
grant select, insert, update, delete on public.payroll_pf_config to service_role;
grant select, insert, update, delete on public.payroll_pf_exclusions to service_role;
