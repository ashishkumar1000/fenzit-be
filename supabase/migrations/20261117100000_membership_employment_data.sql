-- Story 23-1 of spec-payroll (CAP-13): employment data for payroll.
--
-- The Form V field set moves onto the membership row, one copy per person per
-- company, because a payslip is about one employment. Fields stay on
-- memberships (deny-by-default RLS, service-only access) — never on users,
-- which still carries the legacy JWT-claim policies. No new functions: the
-- reads and writes go through the NestJS service (zero-RPC rule).
--
-- Backfill, set-based, in tenant time:
--   join_date  = the date part of the membership's created_at in the tenant's
--                timezone (an employee who joined at 2026-10-20 09:30 IST has
--                joined 2026-10-20).
--   exit_date  = the latest member.remove audit date for that person in that
--                company, but only on a removed membership (a re-invited row
--                is an ongoing employment, its old exit stays history) and
--                only when that date is not before join_date. A remove date
--                that would invert the window is simply dropped — the row
--                keeps exit_date NULL, never inverted; there is no flag in
--                the database, the apply-time probe lists such rows. The
--                clamp lives in this UPDATE's WHERE, so the exit >= join
--                CHECK below can never trip.
--
-- Validation split: the API rejects bad input with plain-English messages
-- before it reaches here; the CHECKs below are only a backstop against a
-- writer that skips the service.

alter table public.memberships
  add column join_date           date,
  add column exit_date           date,
  add column pan                 varchar(10),
  add column date_of_birth       date,
  add column father_name         varchar(100),
  add column mother_name         varchar(100),
  add column spouse_name         varchar(100),
  add column pf_account_number   varchar(50),
  add column uan_number          varchar(20),
  add column designation         varchar(100),
  add column department          varchar(100),
  add column bank_account_number varchar(35),
  add column ifsc_code           varchar(11),
  add column bank_name           varchar(100);

-- An exit only means something inside an employment window.
alter table public.memberships
  add constraint memberships_exit_needs_join_check
    check (exit_date is null or join_date is not null),
  add constraint memberships_exit_not_before_join_check
    check (exit_date is null or join_date is null or exit_date >= join_date),
  add constraint memberships_pan_shape_check
    check (pan is null or pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  add constraint memberships_ifsc_shape_check
    check (ifsc_code is null or ifsc_code ~ '^[A-Z]{4}[A-Z0-9]{7}$');

comment on column public.memberships.join_date is
  'Date of joining, in the tenant timezone. Editable by the owner; NULL on an active membership is the payroll run''s skip-with-warning path.';
comment on column public.memberships.exit_date is
  'Date of leaving, in the tenant timezone. An ACTIVE membership may carry one too (a future leaver — payroll prorates to it, fixture variant C2); the owner sets or edits it through the employment API. The migration backfill fills it only on removed memberships, from the member.remove audit row, and only when that date does not predate join_date.';
comment on column public.memberships.pan is
  'Income-tax PAN of the employee, uppercase, 5 letters + 4 digits + 1 letter. Blank (not fabricated) on the payslip when missing.';
comment on column public.memberships.date_of_birth is
  'The employee''s date of birth (Form V); never exposed to other employees.';
comment on column public.memberships.father_name is
  'Father''s name for the statutory wage slip (Form V).';
comment on column public.memberships.mother_name is
  'Mother''s name for the statutory wage slip (Form V).';
comment on column public.memberships.spouse_name is
  'Spouse''s name for the statutory wage slip (Form V).';
comment on column public.memberships.pf_account_number is
  'EPF member account number (e.g. PY/ABC/12345/000). A populated value or a UAN marks the employee PF-covered regardless of the company switch.';
comment on column public.memberships.uan_number is
  'Universal Account Number (EPFO). Never exposed to other employees.';
comment on column public.memberships.designation is
  'Job title printed on the wage slip (Form V).';
comment on column public.memberships.department is
  'The company''s own department label for the employee.';
comment on column public.memberships.bank_account_number is
  'Salary bank account number. Never exposed to other employees.';
comment on column public.memberships.ifsc_code is
  'Bank branch IFSC: 4 letters + 7 letters/digits.';
comment on column public.memberships.bank_name is
  'Name of the salary bank. Never exposed to other employees.';

-- 1. Every membership learns its join date from its own creation, in the
--    company's timezone.
update public.memberships m
   set join_date = (m.created_at at time zone t.timezone)::date
  from public.tenants t
 where m.tenant_id = t.id;

-- 2. Removed memberships take their exit date from their member.remove audit
--    row, latest one, in the company's timezone — dropped when it would fall
--    before the join date (the row keeps NULL instead of storing an inverted
--    window; the apply-time probe lists such rows, there is no in-DB flag).
update public.memberships m
   set exit_date = removed.exit_date
  from (
    select a.tenant_id,
           a.target_user_id,
           max((a.created_at at time zone t.timezone)::date) as exit_date
      from public.audit_log a
      join public.tenants t on t.id = a.tenant_id
     where a.action = 'member.remove'
       and a.target_user_id is not null
     group by a.tenant_id, a.target_user_id
  ) removed
 where m.tenant_id = removed.tenant_id
   and m.user_id = removed.target_user_id
   and m.status = 'removed'
   and m.join_date is not null
   and removed.exit_date >= m.join_date;
