-- Story 23-7 review hardening for the lock + off-cycle tables: the review
-- round's verified DB-layer findings, landed additively after
-- 20261118020000. Tighter month format, real actor/tenant foreign keys,
-- a staged-count index for the lock confirmation's off-cycle read, and a
-- trimmed-label guard so the unique key cannot be dodged with whitespace.

-- 2026-13 is not a month: the API layer rejects it, so must the DB.
alter table public.payroll_month_locks
  drop constraint payroll_month_locks_month_check;
alter table public.payroll_month_locks
  add constraint payroll_month_locks_month_check
  check (month ~ '^\d{4}-(0[1-9]|1[0-2])$');

alter table public.payroll_off_cycle_lines
  drop constraint payroll_off_cycle_lines_month_check;
alter table public.payroll_off_cycle_lines
  add constraint payroll_off_cycle_lines_month_check
  check (month ~ '^\d{4}-(0[1-9]|1[0-2])$');

-- The lock is permanent and tamper-proof; its actor must be a real user,
-- and deleting the user must not orphan the identity (house pattern:
-- restrict, like the other created_by columns).
alter table public.payroll_month_locks
  add constraint payroll_month_locks_locked_by_fkey
  foreign key (locked_by) references public.users (id) on delete restrict;

alter table public.payroll_off_cycle_lines
  add constraint payroll_off_cycle_lines_tenant_id_fkey
  foreign key (tenant_id) references public.tenants (id) on delete cascade;

alter table public.payroll_off_cycle_lines
  add constraint payroll_off_cycle_lines_created_by_fkey
  foreign key (created_by) references public.users (id) on delete restrict;

-- ' Bonus ' validates against the length check but is a different unique
-- key than 'Bonus' — the label must be stored trimmed.
alter table public.payroll_off_cycle_lines
  add constraint payroll_off_cycle_lines_label_trimmed_check
  check (label = btrim(label));

-- The lock confirmation's staged-count read and story 9's staging surface
-- both filter tenant + month + status.
create index payroll_off_cycle_lines_tenant_month_status_idx
  on public.payroll_off_cycle_lines (tenant_id, month, status);
