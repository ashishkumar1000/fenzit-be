-- Story 23-7 (CAP-9/11): the permanent month lock and the off-cycle-lines
-- table (story 9 builds its surface on this). DDL only — zero functions and
-- zero triggers; deny-by-default RLS with service_role-only grants.

create table public.payroll_month_locks (
  tenant_id    uuid not null references public.tenants (id) on delete cascade,
  month        text not null check (month ~ '^\d{4}-\d{2}$'),
  locked_by    uuid not null,
  locked_at    timestamptz not null default now(),
  confirmation jsonb not null default '{}'::jsonb,
  primary key (tenant_id, month)
);

create table public.payroll_off_cycle_lines (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  membership_id uuid not null,
  month         text not null check (month ~ '^\d{4}-\d{2}$'),
  label         text not null check (length(btrim(label)) between 1 and 80),
  amount        numeric(18, 2) not null,
  tag           text not null check (tag in ('wage', 'bonus')),
  status        text not null default 'staged' check (status in ('staged', 'applied')),
  acknowledged  boolean not null default false,
  created_by    uuid not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, membership_id, month, label),
  foreign key (membership_id, tenant_id)
    references public.memberships (id, tenant_id) on delete cascade
);

alter table public.payroll_month_locks enable row level security;
alter table public.payroll_off_cycle_lines enable row level security;

revoke all on public.payroll_month_locks from public, anon, authenticated;
revoke all on public.payroll_off_cycle_lines from public, anon, authenticated;

grant select, insert, update, delete on public.payroll_month_locks to service_role;
grant select, insert, update, delete on public.payroll_off_cycle_lines to service_role;
