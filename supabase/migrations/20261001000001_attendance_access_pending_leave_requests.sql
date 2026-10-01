-- ─────────────────────────────────────────────────────────────────
-- Story 20-1 (2026-10-01): the owner's pending-leave attention count.
--
-- The Home "Today & needs attention" strip needs "how many leave
-- requests are waiting for me", and no surface holds it: the 10 AM
-- leave.pending_reminder is a notification event, the leave list is a
-- full-page read, and the access mirror carries only the four AD-17
-- facts (19-5a reads profile.attendance for the Home entry). Adding an
-- owner endpoint or a second boot call for one number is wire bloat —
-- the mirror is the read seam for exactly this class of first-load fact
-- (19-6 set the precedent with attendance_ended_on).
--
-- Definition: ONE row per REQUEST whose review is still owed —
-- count(distinct d.leave_request_id) over day rows (the state lives on
-- leave_request_days, never on leave_requests) still 'pending'. A
-- multi-day pending request is ONE review item, matching both the
-- owner leave list (LeaveRequestView) and the 19-4
-- leave.pending_reminder payload (20260929000004 counts distinct
-- request ids for the same queue). A partially-handled request (a
-- cancel split leaving pending dates) still counts.
--
-- Owner-branch gating: the count evaluates ONLY for the tenant's owner
-- while the module is on (enabled + setup completed) — every other
-- mirror row (technicians, module-off tenants, no-role users) reads 0.
-- AC 12 owns the count to the owner branch; zeroing the rest keeps the
-- owner's queue size off every technician's profile payload and keeps
-- one stable shape (never a role-conditional column).
--
-- Cost: the gated subquery runs at most once per distinct owner row of
-- the read. The partial index below (tenant_id where state='pending',
-- matching leave_request_days_active_uq's predicate shape) makes the
-- owner's boot probe an index-only count over the tenant.
--
-- Deploy order: this migration must be applied BEFORE the 20-1
-- backend deploys — getAttendanceAccess selects the column by name, so
-- a pre-migration NestJS boot would 500 on GET /users/me (applied to
-- the live project via Supabase MCP before the code push). The
-- 19-6/20260930000001 precedent mapped its column defensively; here
-- the select itself would fail, so fail-loud is kept and ordering is
-- the control.
--
-- Column list ORDER: the new column appends last (create or replace
-- can only append); security_invoker and the grants are re-asserted
-- below (create or replace does not re-grant — the house pattern,
-- 20260928000001/20260930000001).
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
  -- 19-6: the last tracked day, history_only only (see 20260930000001's
  -- header for the upper-exclusive arithmetic and the 'infinity' guard).
  case
    when cur.period_start is null and nx.next_start is null then
      (select max(upper(e.valid)) - 1
         from public.attendance_enrolments e
        where e.employee_id = u.id
          and upper(e.valid) <= public.attendance_today(u.tenant_id)
          and upper(e.valid) < 'infinity'::date)
    else null
  end as attendance_ended_on,
  -- 20-1: the review queue size — ONE row per pending request (distinct
  -- request ids), owner branch only. Zero for technicians: the owner's
  -- queue volume stays off their profile (the FE never shows them the
  -- strip anyway, gating on the owner role).
  case
    when coalesce(s.enabled, false) and s.setup_completed_at is not null
      and u.role = 'owner'
    then (select count(distinct d.leave_request_id)
            from public.leave_request_days d
           where d.tenant_id = u.tenant_id
             and d.state = 'pending')
    else 0
  end as pending_leave_requests
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

-- 20-1: the count's supporting index — every other index on
-- leave_request_days leads with employee_id or leave_request_id, so the
-- tenant-wide pending probe would sequence-scan. Partially indexed the
-- same way as the active_uq constraint so the predicate matches and the
-- planner can use it on the `state = 'pending'` search.
create index if not exists leave_request_days_tenant_pending_idx
  on public.leave_request_days (tenant_id)
  where state = 'pending';

-- Grants hygiene, re-asserted (see 20260930000001: the view must stay
-- invisible to PostgREST; only the backend's service_role reads it).
revoke all on public.attendance_access_state
  from anon, authenticated, service_role;
grant select on public.attendance_access_state to service_role;