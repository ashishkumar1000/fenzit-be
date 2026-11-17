-- Story 23-4 of spec-payroll (CAP-4, CAP-8): the payroll calendar and the
-- per-state rules-notified switch.
--
-- payroll_calendar: effective-dated policy rows per company — the LOP divisor
-- convention, the attendance cut-off day and the pay date. The row in effect
-- for a run month is the latest effective_from <= that month's first day
-- (month-start resolution, the structures idiom): a mid-month-dated change is
-- first used by the NEXT month's run, an unlocked re-run resolves its own
-- month, locked months keep run-time snapshots. A same-date save REPLACES the
-- dated row. When no row qualifies, the service answers the CoW-safe
-- defaults — fixed-26 divisor, cut-off the 25th, pay date the 1st — so the
-- table starts empty and the fixture's base policy needs no seed.
--   cut-off valid 1-28: months have fewer days than 29 (February), so a
--   29/30/31 cut-off would silently skip February entirely.
--   pay date valid 1-7: wages are payable before expiry of the 7th day of
--   the following month (CoW s.17) — the 7th itself is legal, the 8th a
--   breach; the service rejects 8+ naming the reason.
--
-- payroll_state_rules: one row per company carrying the per-state overlay
-- flag — whether the company's state has notified its Code on Wages state
-- rules (the product ships the central Form V template regardless). A
-- state-of-the-world fact, not month-effective policy: its own tenant-PK
-- table, absent row reads as false. updated_at is stamped by the service.
--
-- Zero new functions: every read and write goes through the NestJS service
-- with an explicit tenant filter.

create table public.payroll_calendar (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants (id) on delete cascade,
  effective_from    date not null,
  divisor_convention text not null default 'fixed-26',
  cutoff_day        smallint not null default 25,
  pay_date          smallint not null default 1,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint payroll_calendar_divisor_check
    check (divisor_convention in ('calendar', 'fixed-30', 'fixed-26')),
  constraint payroll_calendar_cutoff_check check (cutoff_day between 1 and 28),
  constraint payroll_calendar_pay_date_check check (pay_date between 1 and 7),
  -- One dated revision per month boundary (the structures idiom).
  constraint payroll_calendar_tenant_effective_uq unique (tenant_id, effective_from)
);

create table public.payroll_state_rules (
  tenant_id  uuid primary key references public.tenants (id) on delete cascade,
  notified   boolean not null default false,
  updated_at timestamptz not null default now()
);

comment on table public.payroll_calendar is
  'Effective-dated payroll policy per company (CAP-4/8): LOP divisor convention, attendance cut-off day (1-28) and pay date (1-7, the CoW s.17 window). Month-start resolution — the latest effective_from <= the run month''s first day governs; a same-date save replaces the row; no rows means the fixed-26/25/1 defaults.';
comment on column public.payroll_calendar.cutoff_day is
  'Attendance dates after this day of month M belong to M+1''s run as prior-period days. 1-28 only: February has fewer days than 29.';
comment on column public.payroll_calendar.pay_date is
  'The day of the following month wages are payable by. 1-7 only: CoW s.17 requires payment before expiry of the 7th day.';
comment on table public.payroll_state_rules is
  'Per-company overlay flag (SPEC legal constraint): whether the company''s state has notified its CoW state rules — the product ships the central Form V template either way.';
comment on column public.payroll_state_rules.notified is
  'false (or an absent row) = the state''s rules are not yet notified; payroll copy may need the central-rules caveat.';

-- Deny-by-default (house pattern): RLS on with no policies, every grant
-- cleared, service_role only.
alter table public.payroll_calendar enable row level security;
alter table public.payroll_state_rules enable row level security;

revoke all on public.payroll_calendar from public, anon, authenticated;
revoke all on public.payroll_state_rules from public, anon, authenticated;

grant select, insert, update, delete on public.payroll_calendar to service_role;
grant select, insert, update, delete on public.payroll_state_rules to service_role;
