-- ─────────────────────────────────────────────────────────────────
-- Story 15-9 pre-patch (2026-09-28): attendance_access_state must anchor
-- the office join at TODAY for active employees, not the enrolment's
-- original period start.
--
-- Defect (found in the 15-9 spec review, verified against the shipped
-- 20260927000007 body): the assignment join anchored at
--   coalesce(cur.period_start, nx.next_start, attendance_today(...))
-- despite its comment saying "today when active". For an employee enrolled
-- 15 Sep and reassigned (FR-6, assignments-only write — the enrolment
-- period start never moves), the assignments after the AD-8 plan are
-- [15 Sep, 28 Sep) old + [28 Sep, ∞) new, and the period_start anchor kept
-- returning the OLD office in every read surface: the owner roster GET,
-- me/access, and the /users/me mirror — forever, even after the move date.
-- That would also hand Epic 16's check-in the wrong office radius. The
-- only real-DB coverage enrolled its probe at `today`, the single case
-- where period_start = today masks the bug.
--
-- Fix: active → the assignment covering attendance_today (the coverage
-- guard's exact endpoint chaining guarantees one exists for every enrolled
-- date, today included); upcoming → the next period's start (unchanged);
-- no enrolment → today finds nothing, office stays null (unchanged).
-- Column list, order, security_invoker and the grants are preserved
-- (re-asserted below defensively — create or replace does not re-grant,
-- but the 15-7 corrective apply showed default-privilege drift is the
-- failure mode to guard against).
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
  o.name as office_name
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
