-- Story 23-6 review follow-ups: one ACTIVE run per tenant-month (the
-- enqueue race backstop), and recovery lines ride the membership cascade.

create unique index payroll_runs_one_active_per_month
  on public.payroll_runs (tenant_id, month)
  where status in ('queued', 'running');

alter table public.payroll_recovery_lines
  add foreign key (membership_id, tenant_id)
    references public.memberships (id, tenant_id) on delete cascade;
