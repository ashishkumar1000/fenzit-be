-- ─────────────────────────────────────────────────────────────────
-- Story 19-6 (2026-09-30): the history_only end date on the wire.
--
-- The "Attendance tracking ended on {date}" note needs the date, and it
-- does not exist on any surface today: history_only is inferred from past
-- enrolment periods (max(upper(valid))), never selected. This adds ONE
-- final view column, attendance_ended_on — the LAST TRACKED DAY (upper is
-- exclusive, hence the -1) of the most recent closed period.
--
-- Gated to history_only by the view's own CASE precedence: the column is
-- non-null only when no enrolment covers today AND none starts in the
-- future (cur/nx below). An active or upcoming state answers null, so a
-- disable→re-enrol employee never carries a stale "ended" date. With no
-- closed period at all the aggregate is null (never-tracked history_only
-- is a defensive null, not a date). 'infinity'::date is excluded —
-- attendance_enrolments.valid is daterange and an open range's upper is
-- infinity, whose upper - 1 would raise.
--
-- Column list ORDER is preserved with the new column appended last
-- (create or replace can only append); security_invoker and the grants
-- are re-asserted below (create or replace does not re-grant — the house
-- pattern, 20260928000001).
-- ─────────────────────────────────────────────────────────────────

create or replace view public.attendance_access_state
with (security_invoker = true) as
select
  u.id as user_id,
  u.tenant_id,
  -- FR-1/FR-3: the kill switch is the module's off act — no attendance UI
  -- for anyone while it is off; history rows are untouched.
  (coalesce(s.enabled, false) and s.setup_completed_at is not null)
    as attendance_enabled,
  case
    when coalesce(s.enabled, false) is false
      or s.setup_completed_at is null then 'none'
    when cur.period_start is not null then 'active'
    when nx.next_start is not null then 'upcoming'
    when past.seen is not null then 'history_only'
    else 'none'
  end as access_state,
  case
    when cur.period_start is not null then cur.period_start
    when nx.next_start is not null then nx.next_start
  end as attendance_start_date,
  cur.enabled_at as enabled_at,
  ob.onboarded_at,
  a.office_id,
  o.name as office_name,
  -- 19-6: the last tracked day, history_only only (see header). A closed
  -- period's upper bound is exclusive; the employee's final tracked date
  -- is the day before it.
  case
    when cur.period_start is null and nx.next_start is null then
      (select max(upper(e.valid)) - 1
         from public.attendance_enrolments e
        where e.employee_id = u.id
          and upper(e.valid) <= public.attendance_today(u.tenant_id)
          and upper(e.valid) < 'infinity'::date)
    else null
  end as attendance_ended_on
from public.users u
left join public.attendance_settings s
  on s.tenant_id = u.tenant_id
left join public.attendance_onboarding ob
  on ob.employee_id = u.id
-- The period covering today (active).
left join lateral (
  select e.employee_id, lower(e.valid) as period_start, e.enabled_at
  from public.attendance_enrolments e
  where e.employee_id = u.id
    and e.valid @> public.attendance_today(u.tenant_id)
  limit 1
) cur on true
-- The next tracked period's start (upcoming).
left join lateral (
  select min(lower(e.valid)) as next_start
  from public.attendance_enrolments e
  where e.employee_id = u.id
    and lower(e.valid) > public.attendance_today(u.tenant_id)
) nx on true
-- Any closed period (history_only).
left join lateral (
  select 1 as seen
  from public.attendance_enrolments e
  where e.employee_id = u.id
    and upper(e.valid) <= public.attendance_today(u.tenant_id)
  limit 1
) past on true
-- The live assignment covering the relevant date: TODAY when active (a
-- reassignment moves the assignment forward while the enrolment period
-- start stays behind — anchoring at the period start kept reporting the
-- old office forever), the next period's start when upcoming. Writes
-- guarantee the assignment exists; a gap surfaces as a null office rather
-- than a wrong one.
left join lateral (
  select a.office_id
  from public.attendance_office_assignments a
  where a.employee_id = u.id
    and a.valid @> case
      when cur.period_start is not null
        then public.attendance_today(u.tenant_id)
      when nx.next_start is not null then nx.next_start
      else public.attendance_today(u.tenant_id)
    end
  limit 1
) a on true
left join public.attendance_offices o
  on o.id = a.office_id and o.archived_at is null
-- Tenant-qualified rows only: users.tenant_id is deliberately nullable
-- (pre-setup owners) and attendance_today(NULL) would raise. (Review
-- hardening; security_invoker above keeps the view behind the base tables'
-- RLS even if a future grant re-opens it.)
where u.tenant_id is not null;

-- Grants hygiene, re-asserted (see 20260927000007: Supabase default
-- privileges grant every table privilege to anon/authenticated/
-- service_role at creation; the view must be invisible to PostgREST).
revoke all on public.attendance_access_state
  from anon, authenticated, service_role;
grant select on public.attendance_access_state to service_role;
