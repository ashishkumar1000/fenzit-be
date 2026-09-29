-- Story 18-5 (Epic 18, folded into the Epic 19 backend spec): the office
-- rule gate — the fenzit-be half of 18-5 ("office rule mandatory"). The
-- fenzo-app half is the office form's prefilled defaults (09:30 / 18:30,
-- alongside the existing cutoff-15/8/4 prefill) — that change ships in the
-- fenzo-app repo per the cross-repo ordering (this gate, and Epic 19, deploy
-- first).
--
-- attendance_complete_setup gains GATE 3: every ACTIVE office must have an
-- office-rule row covering today. The wizard's Add-Office flow always seeds
-- a [today, ∞) rule at creation and every edit is effective-dated from
-- tomorrow (AD-8: delete from effective_from, re-clip, append [tomorrow, ∞))
-- so a sanctioned path can never strand a rule-less office — gate 3 is the
-- drift guard (spec-18-1's D2 hardening): tracking can never turn on
-- against a rule-less office no matter which client completes the wizard.
-- From completion onward, the day-status engine's permissive no-rule arm +
-- its logger.warn remain the drift DETECTOR (18-x).
--
-- Same gates 1-2 predicates unchanged (20260927000008); PT422 + the
-- ATTENDANCE_SETUP_INCOMPLETE hint family (the FE wizard maps the hint, so
-- gate 3 surfaces through the same error path). Per D3's review decision
-- (user-ratified 2026-09-29) the three rejection MESSAGES are
-- owner-friendly — "attendance setup could not be completed: <reason>.
-- <action>, then try again." — with the tenant-id plumbing in `detail`
-- and gate 3 naming the offending office.
--
-- AD-5: tenant lock unchanged; SECURITY DEFINER + search_path = public and
-- REVOKE/GRANT hygiene re-applied here (create or replace resets nothing,
 -- but the hygiene stays per the rls-isolation scan).

create or replace function public.attendance_complete_setup(
  p_tenant_id uuid,
  p_actor_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_today date;
  v_offending_office_name text;
begin
  -- Tenant-wide RPC: exclusive tenant lock first (AD-5). No employee rows
  -- are changed here, so no employee locks.
  perform public.attendance_lock_tenant(p_tenant_id, true);

  -- Setup must have started and not already be completed.
  if not exists (
    select 1 from public.attendance_settings
    where tenant_id = p_tenant_id and setup_completed_at is null
  ) then
    raise exception 'attendance setup for tenant % not in progress', p_tenant_id
      using errcode = 'PT409',
            hint = 'ATTENDANCE_SETUP_ALREADY_COMPLETED';
  end if;

  v_today := public.attendance_today(p_tenant_id);

  -- Gate 1: at least one active office.
  -- D3 (user decision 2026-09-29): the message tells the owner WHY the
  -- completion failed and WHAT to do next; the tenant-id plumbing moves
  -- to `detail` so support logs still correlate the rejection.
  if not exists (
    select 1 from public.attendance_offices o
    where o.tenant_id = p_tenant_id
      and o.archived_at is null
  ) then
    raise exception 'attendance setup could not be completed: no office has been added yet. Add an office, then try again.'
      using errcode = 'PT422',
            hint = 'ATTENDANCE_SETUP_INCOMPLETE',
            detail = format('tenant %s has no active office', p_tenant_id);
  end if;

  -- Gate 2: at least one tracked employee whose live office assignment
  -- covers today (the 15-7 reconciliation: enrolment covers the date AND
  -- the covering assignment's office is not archived).
  if not exists (
    select 1
    from public.attendance_enrolments e
    join public.attendance_office_assignments a on a.employee_id = e.employee_id
    join public.attendance_offices o on o.id = a.office_id
    join public.users u on u.id = e.employee_id
    where u.tenant_id = p_tenant_id
      and e.valid @> v_today
      and a.valid @> v_today
      and o.archived_at is null
  ) then
    raise exception 'attendance setup could not be completed: no employee is enrolled for today with a live office assignment. Enrol an employee and assign them to an office, then try again.'
      using errcode = 'PT422',
            hint = 'ATTENDANCE_SETUP_INCOMPLETE',
            detail = format('tenant %s has no tracked employee with an office assignment', p_tenant_id);
  end if;

  -- Gate 3 (18-5): every active office must carry a rule covering today —
  -- an owner-facing timing rule for FR-7's thresholds must exist at the
  -- moment tracking turns on, whatever the client did (the wizard's own
  -- liveOfficesMissingRule===0 gate is FE-side; this is the DB guard).
  -- D3 (user decision 2026-09-29): the rejection names the FIRST
  -- offending office so the owner knows where to act; the earlier
  -- `exists` probe is replaced by this named pick (one scan, no double
  -- query, and the message stays exact for the FE's hint-mapped error).
  select coalesce(nullif(o.name, ''), '(unnamed office)')
    into v_offending_office_name
    from public.attendance_offices o
    where o.tenant_id = p_tenant_id
      and o.archived_at is null
      and not exists (
        select 1
        from public.attendance_office_rules r
        where r.office_id = o.id
          and r.valid @> v_today
      )
    limit 1;

  if v_offending_office_name is not null then
    raise exception 'attendance setup could not be completed: office «%» has no timing rule covering today. Add a rule for this office, then try again.', v_offending_office_name
      using errcode = 'PT422',
            hint = 'ATTENDANCE_SETUP_INCOMPLETE',
            detail = format('tenant %s has an active office without a rule', p_tenant_id);
  end if;

  -- Completing setup turns the module on (PRD: the wizard IS the enable
  -- act); enabled=false remains the kill switch from then on.
  update public.attendance_settings
    set setup_completed_at = now(),
        enabled = true
    where tenant_id = p_tenant_id;
end;
$$;

-- AD-3 grant triple hygiene (create or replace keeps the pg_proc grants,
-- but re-assert them so any drift the rls-isolation scan would catch is
-- impossible in the same change).
revoke all on function public.attendance_complete_setup(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.attendance_complete_setup(uuid, uuid)
  to service_role;
