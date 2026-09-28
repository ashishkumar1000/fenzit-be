-- Story 16-1 + 16-2 (Epic 16): Check-in & check-out — storage tables.
--
-- attendance_attempts: EVERY check-in/out call writes exactly one row,
--   accepted or rejected (AD-6). The UNIQUE (tenant_id, request_id) makes
--   idempotency a row-level guarantee — a replay reads the stored outcome
--   and writes nothing. Counted rejections (too_far / low_accuracy /
--   mocked / stale_fix) feed the shared rate-limit budget (AD-15); the 5th
--   inside the window carries blocked_until on its own row. Rejected rows
--   keep their coordinates for the owner's dispute view; AD-26's 90-day
--   coordinate prune arrives with Epic 19's pg_cron work.
--
-- attendance_records: one row per employee per work_date (AD-9 snapshot
--   shape) — office, rule and radius snapshotted at write time so later
--   rule/archive changes never rewrite history; check-in and check-out
--   location/accuracy/distance snapshots in the same row; server now() is
--   the only clock. Late minutes / early checkout are computed on read
--   (AD-9/AD-10) — the pure math ships in src/attendance/day-context.ts
--   and Epic 18's day-status function imports the same helpers.
--
-- NO new functions, triggers beyond updated_at, or RPCs (user decision
-- 2026-09-27/28, AD-3 amendment: Epic 16-19 are NestJS-first). The write
-- paths are single pg transactions in fenzit-be (src/attendance/
-- check-in-out.service.ts) reusing the existing attendance_lock_tenant /
-- attendance_lock_employee / attendance_today helpers from 20260926000003.
--
-- Access (15-7 grants hygiene): RLS enabled with NO policies — deny by
-- default; Supabase's default privileges would hand anon/authenticated
-- inert table grants at creation, so REVOKE ALL clears them and only
-- service_role is granted the privileges the backend uses.

create table public.attendance_attempts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  employee_id   uuid not null,
  request_id    uuid not null,
  kind          text not null,
  outcome       text not null,
  latitude      double precision,
  longitude     double precision,
  accuracy_m    double precision,
  distance_m    double precision,
  radius_m      integer,
  mocked        boolean,
  provider      text,
  fix_age_ms    integer,
  blocked_until timestamptz,
  attempted_at  timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint attendance_attempts_kind_check
    check (kind = any (array['check_in'::text, 'check_out'::text])),
  constraint attendance_attempts_outcome_check
    check (outcome = any (array[
      'ok'::text, 'too_far'::text, 'low_accuracy'::text, 'mocked'::text,
      'stale_fix'::text, 'rate_limited'::text, 'not_tracked'::text,
      'already_checked_in'::text, 'already_checked_out'::text,
      'not_checked_in'::text, 'leave_confirmation_required'::text
    ])),
  -- AD-6: the idempotency guarantee is this row-level uniqueness — a
  -- replayed (tenant_id, request_id) cannot create a second attempt.
  constraint attendance_attempts_tenant_request_uq
    unique (tenant_id, request_id)
);

alter table public.attendance_attempts
  add constraint attendance_attempts_employee_tenant_fkey
  foreign key (employee_id, tenant_id)
  references public.users (id, tenant_id) on delete restrict;

create index attendance_attempts_employee_time_idx
  on public.attendance_attempts (employee_id, attempted_at desc);

create table public.attendance_records (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants (id) on delete cascade,
  employee_id         uuid not null,
  work_date           date not null,
  office_id           uuid not null,
  office_rules_id     uuid,
  radius_m            integer not null,
  checkin_at          timestamptz not null,
  checkin_attempt_id  uuid not null,
  checkin_lat         double precision not null,
  checkin_lng         double precision not null,
  checkin_accuracy_m  double precision not null,
  checkin_distance_m  double precision not null,
  checkin_mocked      boolean not null,
  checkin_provider    text,
  checkout_at         timestamptz,
  checkout_attempt_id uuid,
  checkout_lat        double precision,
  checkout_lng        double precision,
  checkout_accuracy_m double precision,
  checkout_distance_m double precision,
  checkout_mocked     boolean,
  checkout_provider   text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- AD-6's last guard: one attendance record per employee per day. The
  -- service pre-checks under the exclusive employee lock; this constraint
  -- is the race backstop.
  constraint attendance_records_employee_work_date_uq
    unique (employee_id, work_date),
  -- check-out fields are written together, or not at all.
  constraint attendance_records_checkout_pair_check
    check ((checkout_at is null) = (checkout_attempt_id is null))
);

alter table public.attendance_records
  add constraint attendance_records_employee_tenant_fkey
  foreign key (employee_id, tenant_id)
  references public.users (id, tenant_id) on delete restrict;

-- offices carries UNIQUE (id, tenant_id) since 20260926000007.
alter table public.attendance_records
  add constraint attendance_records_office_tenant_fkey
  foreign key (office_id, tenant_id)
  references public.attendance_offices (id, tenant_id) on delete restrict;

alter table public.attendance_records
  add constraint attendance_records_office_rules_fkey
  foreign key (office_rules_id)
  references public.attendance_office_rules (id) on delete restrict;

alter table public.attendance_records
  add constraint attendance_records_checkin_attempt_fkey
  foreign key (checkin_attempt_id)
  references public.attendance_attempts (id) on delete restrict;

alter table public.attendance_records
  add constraint attendance_records_checkout_attempt_fkey
  foreign key (checkout_attempt_id)
  references public.attendance_attempts (id) on delete restrict;

create index attendance_records_checkout_attempt_idx
  on public.attendance_records (checkout_attempt_id);

-- The AD-6 ok-replay rebuild reads by the check-in attempt too (review nit).
create index attendance_records_checkin_attempt_idx
  on public.attendance_records (checkin_attempt_id);

alter table public.attendance_attempts         enable row level security;
alter table public.attendance_records          enable row level security;
-- No policies: deny-by-default (the pg pool's service credentials are the
-- only writer; reads of attempts/records ship with later epics' routes).

revoke all on public.attendance_attempts, public.attendance_records
  from anon, authenticated;
grant select, insert, update on public.attendance_attempts to service_role;
grant select, insert, update on public.attendance_records  to service_role;

create trigger set_updated_at_attendance_attempts
  before update on public.attendance_attempts
  for each row execute function public.update_updated_at_column();
create trigger set_updated_at_attendance_records
  before update on public.attendance_records
  for each row execute function public.update_updated_at_column();
