-- Roles and access, step 3: the database reads memberships instead of
-- users.tenant_id / users.role / users.status.
--
-- Plain-English contract
--   * Every person's company and role now come from `memberships`. The old
--     users columns are still there but nothing reads them any more; step 4
--     drops them.
--   * Existing company members are copied into `memberships` first (owner ->
--     company_admin, technician -> employee, same status, same employee code).
--   * The 15 attendance and leave keys that said "this employee belongs to this
--     company" now point at `memberships (user_id, tenant_id)`. A membership is
--     never deleted, so history stays valid.
--   * `tenants.owner_id` becomes `created_by` (history only, nothing uses it for
--     access). Deleting a user can no longer delete a company.
--   * Alerts that went to the one owner now go to every active company admin
--     (decision 36).
--   * Row-level security looks up the caller's company and role from
--     `memberships` through the helpers added in step 1, never from a token
--     claim. A viewer cannot write; only the report insert is open to a viewer.
--   * One identity per phone number across the whole `users` table.
--   * Four functions get a fixed search path (advisor findings).
--
-- Spec: artifacts/implementation-artifacts/roles-and-access-spec.md.

-- 0. Safety checks: stop here, before anything changes, if the data is not as expected.
do $$
begin
  if exists (select 1 from public.users u where u.tenant_id is not null
              and (u.status not in ('invited', 'active', 'removed')
                   or u.role not in ('owner', 'technician')
                   or u.employee_code is null)) then
    raise exception 'step 3 stopped: a company member has an unexpected status or role, or no employee code';
  end if;
  if exists (select 1 from public.users u group by u.country_code, u.phone_number having count(*) > 1) then
    raise exception 'step 3 stopped: two people share one phone number, merge them first';
  end if;
  if exists (select 1 from public.tenants t where not exists (
      select 1 from public.users u where u.tenant_id = t.id and u.role = 'owner' and u.status = 'active')) then
    raise exception 'step 3 stopped: a company has no active owner';
  end if;
end $$;

-- 1. Copy existing company members into memberships -------------------------------
insert into public.memberships (user_id, tenant_id, role, status, employee_code)
select u.id,
       u.tenant_id,
       case u.role when 'owner' then 'company_admin' else 'employee' end,
       u.status,
       u.employee_code
  from public.users u
 where u.tenant_id is not null;

-- 2. One identity per phone number ---------------------------------------------------
drop index public.users_phone_per_tenant_unique;
drop index public.users_phone_no_tenant_unique;
create unique index users_phone_key on public.users (country_code, phone_number);

-- 3. Repoint the 15 composite keys at memberships -------------------------------------
do $$
declare
  r record;
begin
  for r in
    select conrelid::regclass::text as tbl, conname, pg_get_constraintdef(oid) as def
      from pg_constraint
     where confrelid = 'public.users'::regclass
       and cardinality(conkey) = 2
  loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
    execute format(
      'alter table %s add constraint %I %s',
      r.tbl, r.conname,
      replace(r.def, 'REFERENCES users(id, tenant_id)', 'REFERENCES public.memberships(user_id, tenant_id)')
    );
  end loop;
end $$;

-- Prove the repoint worked: no composite key still points at users, and exactly 15 point at memberships.
do $$
begin
  if exists (select 1 from pg_constraint where confrelid = 'public.users'::regclass and cardinality(conkey) = 2) then
    raise exception 'step 3 stopped: a composite key still points at users';
  end if;
  if (select count(*) from pg_constraint where confrelid = 'public.memberships'::regclass and contype = 'f') <> 15 then
    raise exception 'step 3 stopped: expected exactly 15 keys on memberships';
  end if;
end $$;

-- 4. tenants.owner_id -> created_by (decisions 33 and 40) ------------------------------
drop policy tenants_read_own on public.tenants;
alter table public.tenants drop constraint tenants_owner_id_fkey;
alter table public.tenants drop constraint tenants_owner_id_key;
alter table public.tenants rename column owner_id to created_by;
alter index public.idx_tenants_owner_id rename to idx_tenants_created_by;
alter table public.tenants
  add constraint tenants_created_by_fkey
  foreign key (created_by) references public.users (id) on delete restrict;

-- 5. Employee code is generated on memberships ----------------------------------------
drop trigger users_set_employee_code on public.users;

-- 6. Functions ----------------------------------------------------------------------------
-- Rewritten from the 2026-10-20 snapshot with only the lines that read the old
-- columns changed. Each keeps its name, parameters and result.

CREATE OR REPLACE FUNCTION "public"."advance_workflow_step"("p_job_id" "uuid", "p_tenant_id" "uuid", "p_actor_id" "uuid", "p_step" "text", "p_new_status" "text", "p_expected_current_step" "text", "p_latitude" double precision DEFAULT NULL::double precision, "p_longitude" double precision DEFAULT NULL::double precision, "p_accuracy" double precision DEFAULT NULL::double precision, "p_location_captured" boolean DEFAULT NULL::boolean, "p_reason" "text" DEFAULT NULL::"text", "p_accuracy_flagged" boolean DEFAULT NULL::boolean) RETURNS SETOF "public"."jobs"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_job jobs%ROWTYPE;
BEGIN
  -- Tenant-scoped row lock. A missing/cross-tenant row returns the empty set,
  -- which the app maps to 404 (cross-tenant is indistinguishable from not-found).
  SELECT * INTO v_job
  FROM jobs
  WHERE id = p_job_id AND tenant_id = p_tenant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- A finished/cancelled job cannot advance. Custom SQLSTATE the app maps to
  -- 409 JOB_NOT_MODIFIABLE (PTxxx convention: last 3 digits = HTTP status; the
  -- app reads error.code directly).
  IF v_job.status NOT IN ('scheduled', 'in_progress') THEN
    RAISE EXCEPTION 'job % not advanceable in status %', p_job_id, v_job.status
      USING ERRCODE = 'PT409';
  END IF;

  -- Compare-and-set: if current_step moved between the service's read and now
  -- (a concurrent advance / offline replay), reject the stale write. IS DISTINCT
  -- FROM is null-safe (the first on_my_way advance expects current_step = NULL).
  IF v_job.current_step IS DISTINCT FROM p_expected_current_step THEN
    RAISE EXCEPTION 'workflow step changed concurrently (expected %, found %)',
      p_expected_current_step, v_job.current_step
      USING ERRCODE = 'PT409';
  END IF;

  -- p_new_status is 'in_progress' for on_my_way, 'completed' for completed,
  -- else NULL (COALESCE leaves status unchanged at in_progress).
  UPDATE jobs
  SET current_step = p_step,
      status       = COALESCE(p_new_status, status),
      completed_at = CASE WHEN p_new_status = 'completed' THEN now() ELSE completed_at END,
      updated_at   = now()
  WHERE id = p_job_id;

  -- Every step appends an immutable activity-log entry (FR-11). tenant_id and
  -- actor_id are NOT NULL on activity_logs, so both must be supplied.
  -- Merge location data into metadata: lat/long must arrive together or not at all.
  INSERT INTO activity_logs (job_id, tenant_id, event_type, actor_id, metadata)
  VALUES (
    p_job_id, p_tenant_id, 'step_' || p_step, p_actor_id,
    CASE
      WHEN p_latitude IS NOT NULL AND p_longitude IS NOT NULL THEN
        jsonb_strip_nulls(jsonb_build_object(
          'latitude', p_latitude,
          'longitude', p_longitude,
          'accuracy', p_accuracy,
          'locationCaptured', p_location_captured,
          'reason', p_reason,
          'accuracyFlagged', p_accuracy_flagged
        ))
      WHEN p_location_captured IS NOT NULL THEN
        jsonb_strip_nulls(jsonb_build_object(
          'locationCaptured', p_location_captured,
          'reason', p_reason
        ))
      ELSE NULL
    END
  );

  -- Notify every active company admin of the company (decision 36). Self-
  -- notification guard: an admin advancing their own job must not notify
  -- themselves.
  INSERT INTO notifications (tenant_id, user_id, job_id, event_type, payload)
  SELECT p_tenant_id,
         m.user_id,
         p_job_id,
         p_step,
         jsonb_build_object(
           'job_number', v_job.job_number,
           'step', p_step,
           'technician_name', COALESCE(NULLIF(u.name, ''), 'A technician')
         )
  FROM memberships m
  JOIN users au ON au.id = m.user_id
  LEFT JOIN users u ON u.id = p_actor_id
  WHERE m.tenant_id = p_tenant_id
    AND m.role = 'company_admin'
    AND m.status = 'active'
    AND NOT au.disabled
    AND m.user_id <> p_actor_id;

  RETURN QUERY SELECT * FROM jobs WHERE id = p_job_id AND tenant_id = p_tenant_id;
END $$;

CREATE OR REPLACE FUNCTION "public"."attendance_add_holiday"("p_tenant_id" "uuid", "p_holiday_date" "date", "p_name" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_today      date;
  v_holiday_id uuid;
begin
  perform public.attendance_lock_tenant(p_tenant_id, true);

  v_today := public.attendance_today(p_tenant_id);

  begin
    insert into public.holidays (tenant_id, holiday_date, name)
      values (p_tenant_id, p_holiday_date, p_name)
      returning id into v_holiday_id;
  exception
    when unique_violation then
      raise exception 'a holiday on % already exists in tenant %', p_holiday_date, p_tenant_id
        using errcode = 'PT409',
              hint = 'ATTENDANCE_HOLIDAY_TAKEN';
  end;

  -- Future dates broadcast to tracked employees (AD-13); past dates are
  -- silent. Gated on setup COMPLETED and the module still enabled — the
  -- kill switch is the module's off act (FR-1): no fan-out while off.
  if p_holiday_date > v_today then
    if exists (
      select 1 from public.attendance_settings
      where tenant_id = p_tenant_id
        and setup_completed_at is not null
        and enabled
    ) then
      insert into public.notifications
        (tenant_id, user_id, job_id, event_type, payload,
         entity_type, entity_id, dedupe_key)
      select p_tenant_id,
             e.employee_id,
             null,
             'attendance.holiday_added',
             jsonb_build_object(
               'holidayName', p_name,
               'holidayDate', to_char(p_holiday_date, 'YYYY-MM-DD')
             ),
             'attendance',
             v_holiday_id,
             p_tenant_id::text || ':attendance.holiday_added:'
               || e.employee_id::text || ':' || v_holiday_id::text
      from public.attendance_enrolments e
      join public.memberships u on u.user_id = e.employee_id
      join public.attendance_office_assignments a
        on a.employee_id = e.employee_id
       and a.valid @> p_holiday_date
      join public.attendance_offices o
        on o.id = a.office_id and o.archived_at is null
      where u.tenant_id = p_tenant_id
        and u.status <> 'removed'
        and e.valid @> p_holiday_date;
    end if;
  end if;

  return v_holiday_id;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."attendance_remove_holiday"("p_tenant_id" "uuid", "p_holiday_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_today        date;
  v_holiday_date date;
  v_holiday_name text;
begin
  perform public.attendance_lock_tenant(p_tenant_id, true);

  v_today := public.attendance_today(p_tenant_id);

  select holiday_date, name into v_holiday_date, v_holiday_name
  from public.holidays
  where id = p_holiday_id
    and tenant_id = p_tenant_id;

  if v_holiday_date is null then
    raise exception 'holiday % not found in tenant %', p_holiday_id, p_tenant_id
      using errcode = 'PT404',
            hint = 'ATTENDANCE_HOLIDAY_NOT_FOUND';
  end if;

  delete from public.holidays
    where id = p_holiday_id
      and tenant_id = p_tenant_id;

  -- Same completed+enabled gate as add (kill-switch asymmetry finding).
  if v_holiday_date > v_today then
    if exists (
      select 1 from public.attendance_settings
      where tenant_id = p_tenant_id
        and setup_completed_at is not null
        and enabled
    ) then
      insert into public.notifications
        (tenant_id, user_id, job_id, event_type, payload,
         entity_type, entity_id, dedupe_key)
      select p_tenant_id,
             e.employee_id,
             null,
             'attendance.holiday_removed',
             jsonb_build_object(
               'holidayName', v_holiday_name,
               'holidayDate', to_char(v_holiday_date, 'YYYY-MM-DD')
             ),
             'attendance',
             p_holiday_id,
             p_tenant_id::text || ':attendance.holiday_removed:'
               || e.employee_id::text || ':' || p_holiday_id::text
      from public.attendance_enrolments e
      join public.memberships u on u.user_id = e.employee_id
      join public.attendance_office_assignments a
        on a.employee_id = e.employee_id
       and a.valid @> v_holiday_date
      join public.attendance_offices o
        on o.id = a.office_id and o.archived_at is null
      where u.tenant_id = p_tenant_id
        and u.status <> 'removed'
        and e.valid @> v_holiday_date;
    end if;
  end if;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."attendance_complete_setup"("p_tenant_id" "uuid", "p_actor_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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
    join public.memberships u on u.user_id = e.employee_id
    where u.tenant_id = p_tenant_id
      and u.status <> 'removed'
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

CREATE OR REPLACE FUNCTION "public"."attendance_enrolment_coverage_guard"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare
  v_employee_id uuid;
  v_open_end constant date := date '9999-12-31';
begin
  v_employee_id := coalesce(new.employee_id, old.employee_id);

  -- No assignment may reach outside an enrolment (any office state).
  if exists (
    select 1
    from public.attendance_office_assignments a
    where a.employee_id = v_employee_id
      and not exists (
        select 1
        from public.attendance_enrolments e
        where e.employee_id = a.employee_id
          and e.valid @> a.valid
      )
  ) then
    raise exception
      'employee % has an office assignment outside any enrolment',
      v_employee_id
      using errcode = '23514',
            hint = 'ATTENDANCE_ASSIGNMENT_GAP';
  end if;

  -- Coverage = exact endpoint chaining (any office state — archived offices
  -- still cover the past they once served, FR-5): the first leg starts at
  -- the period start, every next leg starts where the previous ended, and
  -- the chain reaches the period's end (sentinel for open ranges).
  if exists (
    select 1
    from public.attendance_enrolments e
    cross join lateral (
      with legs as (
        select lower(a.valid) as s,
               coalesce(upper(a.valid), v_open_end) as t,
               lag(coalesce(upper(a.valid), v_open_end)) over (order by lower(a.valid)) as prev_t
        from public.attendance_office_assignments a
        where a.employee_id = e.employee_id
          and a.valid <@ e.valid
      )
      select (select min(s) from legs) is distinct from lower(e.valid) as gap_start,
             coalesce((select bool_or(prev_t is not null and prev_t <> s) from legs), false) as gap_mid,
             (select max(t) from legs) is distinct from coalesce(upper(e.valid), v_open_end) as gap_end
    ) g
    where e.employee_id = v_employee_id
      and (g.gap_start or g.gap_mid or g.gap_end)
  ) then
    raise exception
      'employee % has an enrolled date without an office assignment',
      v_employee_id
      using errcode = '23514',
            hint = 'ATTENDANCE_ASSIGNMENT_GAP';
  end if;

  -- CURRENT-OR-FUTURE periods must be chained over LIVE assignments — an
  -- archived office can never serve a check-in. Closed history is exempt:
  -- after office A is archived, the employee can still be disabled,
  -- reassigned and re-enabled.
  if exists (
    select 1
    from public.attendance_enrolments e
    join public.memberships u on u.user_id = e.employee_id and u.tenant_id = e.tenant_id
    cross join lateral (
      with legs as (
        select lower(a.valid) as s,
               coalesce(upper(a.valid), v_open_end) as t,
               lag(coalesce(upper(a.valid), v_open_end)) over (order by lower(a.valid)) as prev_t
        from public.attendance_office_assignments a
        join public.attendance_offices o on o.id = a.office_id
        where a.employee_id = e.employee_id
          and o.archived_at is null
          and a.valid <@ e.valid
      )
      select (select min(s) from legs) is distinct from lower(e.valid) as gap_start,
             coalesce((select bool_or(prev_t is not null and prev_t <> s) from legs), false) as gap_mid,
             (select max(t) from legs) is distinct from coalesce(upper(e.valid), v_open_end) as gap_end
    ) g
    where e.employee_id = v_employee_id
      and coalesce(upper(e.valid), v_open_end) > public.attendance_today(u.tenant_id)
      and (g.gap_start or g.gap_mid or g.gap_end)
  ) then
    raise exception
      'employee % has a current or future enrolled date without a live office assignment',
      v_employee_id
      using errcode = '23514',
            hint = 'ATTENDANCE_ASSIGNMENT_GAP';
  end if;

  return null;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."attendance_holiday_impact"("p_tenant_id" "uuid", "p_date" "date") RETURNS TABLE("employee_id" "uuid", "employee_name" "text")
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  perform public.attendance_today(p_tenant_id);

  return query
    select e.employee_id,
           coalesce(
             nullif(u.name, ''),
             u.country_code || u.phone_number,
             'Unknown employee'
           ) as employee_name
    from public.attendance_enrolments e
    join public.users u on u.id = e.employee_id
    join public.memberships m
      on m.user_id = e.employee_id
     and m.tenant_id = p_tenant_id
     and m.status <> 'removed'
    join public.attendance_office_assignments a
      on a.employee_id = e.employee_id
     and a.valid @> p_date
    join public.attendance_offices o
      on o.id = a.office_id and o.archived_at is null
    where e.valid @> p_date;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."attendance_office_archive_blockers"("p_tenant_id" "uuid", "p_office_id" "uuid") RETURNS TABLE("employee_id" "uuid", "employee_name" "text")
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_today date;
begin
  v_today := public.attendance_today(p_tenant_id);

  return query
    select distinct a.employee_id,
           coalesce(
             nullif(u.name, ''),
             u.country_code || u.phone_number,
             'Unknown employee'
           ) as employee_name
    from public.attendance_office_assignments a
    join public.users u on u.id = a.employee_id
    join public.memberships m
      on m.user_id = a.employee_id
     and m.tenant_id = p_tenant_id
     and m.status <> 'removed'
    where a.office_id = p_office_id
      and coalesce(upper(a.valid), 'infinity'::date) > v_today
      and exists (
        select 1
        from public.attendance_enrolments e
        where e.employee_id = a.employee_id
          and e.valid @> lower(a.valid)
      )
    order by 2;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."attendance_remove_weekly_off_override"("p_tenant_id" "uuid", "p_employee_id" "uuid", "p_effective_from" "date") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_today          date;
  v_effective_from date;
begin
  perform public.attendance_lock_tenant(p_tenant_id, true);

  v_today := public.attendance_today(p_tenant_id);
  v_effective_from := greatest(coalesce(p_effective_from, v_today), v_today);

  if not exists (
    select 1 from public.memberships
    where user_id = p_employee_id
      and tenant_id = p_tenant_id
      and status <> 'removed'
  ) then
    raise exception 'employee % not found in tenant %', p_employee_id, p_tenant_id
      using errcode = 'PT404',
            hint = 'ATTENDANCE_EMPLOYEE_NOT_FOUND';
  end if;

  delete from public.attendance_weekly_off_overrides
    where employee_id = p_employee_id
      and lower(valid) >= v_effective_from;

  update public.attendance_weekly_off_overrides
    set valid = daterange(lower(valid), v_effective_from, '[)')
    where employee_id = p_employee_id
      and valid @> v_effective_from;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."attendance_set_weekly_off_override"("p_tenant_id" "uuid", "p_employee_id" "uuid", "p_days" integer[], "p_effective_from" "date") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_today          date;
  v_effective_from date;
  v_days           integer[];
  v_queued_from    date;
begin
  if p_days is null then
    raise exception 'days is required (use an empty array for no day off)'
      using errcode = '23514';
  end if;

  perform public.attendance_lock_tenant(p_tenant_id, true);

  v_today := public.attendance_today(p_tenant_id);
  v_effective_from := greatest(coalesce(p_effective_from, v_today), v_today);

  if not exists (
    select 1 from public.memberships
    where user_id = p_employee_id
      and tenant_id = p_tenant_id
      and status <> 'removed'
  ) then
    raise exception 'employee % not found in tenant %', p_employee_id, p_tenant_id
      using errcode = 'PT404',
            hint = 'ATTENDANCE_EMPLOYEE_NOT_FOUND';
  end if;

  if not exists (
    select 1 from public.memberships
    where user_id = p_employee_id
      and tenant_id = p_tenant_id
      and status = 'active'
  ) then
    raise exception 'employee % is not active in tenant %', p_employee_id, p_tenant_id
      using errcode = 'PT422',
            hint = 'ATTENDANCE_EMPLOYEE_NOT_ACTIVE';
  end if;

  v_days := coalesce(
    (select array_agg(distinct d order by d) from unnest(p_days) as d),
    '{}'::integer[]
  );

  if cardinality(v_days) = 7 then
    raise exception 'all seven days cannot be weekly offs'
      using errcode = 'PT422',
            hint = 'ATTENDANCE_NO_WORKING_DAYS';
  end if;

  select lower(valid) into v_queued_from
    from public.attendance_weekly_off_overrides
    where employee_id = p_employee_id
      and lower(valid) > v_today
      and lower(valid) < v_effective_from
      and valid @> v_effective_from
      and days = v_days;

  if v_queued_from is not null then
    delete from public.attendance_weekly_off_overrides
      where employee_id = p_employee_id
        and lower(valid) = v_queued_from;

    update public.attendance_weekly_off_overrides
      set valid = daterange(lower(valid), v_effective_from, '[)')
      where employee_id = p_employee_id
        and upper(valid) = v_queued_from;
  end if;

  delete from public.attendance_weekly_off_overrides
    where employee_id = p_employee_id
      and lower(valid) >= v_effective_from;

  update public.attendance_weekly_off_overrides
    set valid = daterange(lower(valid), v_effective_from, '[)')
    where employee_id = p_employee_id
      and valid @> v_effective_from;

  insert into public.attendance_weekly_off_overrides
    (tenant_id, employee_id, valid, days)
    values (p_tenant_id, p_employee_id, daterange(v_effective_from, null, '[)'), v_days);
end;
$$;

CREATE OR REPLACE FUNCTION "public"."attendance_run_reminders"("p_now" timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant   record;
  v_tenant_id uuid;
  v_tz        text;
  v_today     date;
  v_now_min   integer;  -- tenant wall-clock minute-of-day at tick time
  v_tick      timestamptz; -- coalesce(p_now, now()) — the injected clock
begin
  -- One pass per tenant with the module on (AD-25: enabled + completed
  -- setup); each tenant runs in its own BEGIN…EXCEPTION sub-block.
  for v_tenant in
    select t.id as tenant_id, t.timezone
    from public.tenants t
    join public.attendance_settings s on s.tenant_id = t.id
    where s.enabled = true
      and s.setup_completed_at is not null
  loop
    begin
      v_tenant_id := v_tenant.tenant_id;
      v_tz        := v_tenant.timezone;
      v_tick      := coalesce(p_now, now());
      v_today     := coalesce(
        (v_tick at time zone v_tz)::date,
        public.attendance_today(v_tenant_id)
      );
      -- floor(), not PG's rounding ::int cast: a tick in
      -- [threshold - 30s, threshold) must still read the PREVIOUS minute
      -- (bug-bash 2026-10-02 B-BUG-1 — 09:14:59 fired arms a minute early).
      v_now_min   := (floor(extract(epoch from (v_tick at time zone v_tz))
                          / 60))::int % 1440;

      -- ------------------------------------------------------------
      -- Pending-leave reminder: every active company admin, once per day at 10:00 tenant
      -- wall time (FR-23), when any pending leave day exists (a request's
      -- state lives on its per-day rows; count distinct requests). One
      -- insert per day per owner via the dedupe key — requests arriving
      -- after 10:00 stay silent until tomorrow (FR-23's "once a day").
      -- The (entity_type, entity_id) deep-link pair stays all-NULL
      -- (notifications_entity_pair_chk): the payload aggregates a count
      -- over MANY requests, so no single request is a deep-link target.
      -- ------------------------------------------------------------
      if v_now_min >= (extract(epoch from time '10:00') / 60)::int then
        insert into public.notifications
          (tenant_id, user_id, job_id, event_type, payload,
           entity_type, entity_id, dedupe_key)
        select
          v_tenant_id, adm.user_id, null::uuid,
          'leave.pending_reminder',
          jsonb_build_object('pendingCount', pend.pending_count),
          null::text, null::uuid,
          v_tenant_id || ':leave.pending_reminder:' || adm.user_id
            || ':' || v_today
        from (
          select count(distinct lrd.leave_request_id) as pending_count
          from public.leave_request_days lrd
          where lrd.tenant_id = v_tenant_id
            and lrd.state = 'pending'
        ) pend
        cross join (
          select m.user_id
          from public.memberships m
          join public.users au on au.id = m.user_id
          where m.tenant_id = v_tenant_id
            and m.role = 'company_admin'
            and m.status = 'active'
            and not au.disabled
        ) adm
        where pend.pending_count > 0
        on conflict (dedupe_key) where dedupe_key is not null do nothing;
      end if;

      -- ------------------------------------------------------------
      -- Employee + office-summary reminders over ONE shared fact CTE
      -- mirroring the TS day-context reads for today (AD-22 subset).
      -- No covering rule for the date → the employee drops out of facts
      -- entirely (AD-22: no rule → no thresholds to be late against).
      -- Enrolments dedupe to ONE row per employee — oldest valid period
      -- wins, the same pick as the TS read and the monthly roster's
      -- `distinct on`; without it a re-enrolment's overlapping rows
      -- MULTIPLY facts and arm 3's count(*) overstates the office
      -- summary (the audit's inflated-count finding). Arms 1/2 are
      -- unaffected in effect (the dedupe key swallows repeats), but one
      -- set of facts keeps every arm on the same input.
      -- ------------------------------------------------------------
      with facts as (
        select
          f.employee_id,
          f.office_id,
          f.office_name,
          f.start_min,
          f.end_min,
          f.cutoff,
          f.midpoint_min,
          f.is_working_day,
          f.full_day_leave,
          f.first_half_leave,
          f.second_half_leave,
          f.adjudicated,
          f.checkin_at,
          f.checkout_at,
          f.late_min,
          f.grace_skip
        from (
          select distinct on (inner_facts.employee_id)
            inner_facts.*
          from (
            select
              e.employee_id,
              a.office_id,
              o.name as office_name,
              (extract(epoch from r.start_time) / 60)::int as start_min,
              (extract(epoch from r.end_time)   / 60)::int as end_min,
              r.late_cutoff_minutes as cutoff,
              -- midpointMinute parity with DayContext: start + floor((end-start)/2)
              (extract(epoch from r.start_time) / 60)::int
                + (((extract(epoch from r.end_time) / 60)::int
                    - (extract(epoch from r.start_time) / 60)::int) / 2)
                as midpoint_min,
              -- Working day = not a tenant holiday today AND not the employee's
              -- effective weekly off today (the override REPLACES the tenant
              -- default when one covers the date — the pickWeeklyOffDays
              -- contract; days[] is ISO weekday 1=Mon..7=Sun, isodow matches).
              (not exists (
                 select 1 from public.holidays h
                 where h.tenant_id = v_tenant_id
                   and h.holiday_date = v_today
               )
               and not coalesce(
                 (select extract(isodow from v_today)::int = any (wov.days)
                  from public.attendance_weekly_off_overrides wov
                  where wov.employee_id = e.employee_id
                    and wov.valid @> v_today
                  limit 1),
                 (select extract(isodow from v_today)::int = any (wdef.days)
                  from public.attendance_weekly_off_defaults wdef
                  where wdef.tenant_id = v_tenant_id
                    and wdef.valid @> v_today
                  limit 1),
                 false)) as is_working_day,
              -- Active leave facts for today (at most one per day — the
              -- leave_request_days_active_uq partial unique index); the
              -- leave part rides the parent request (full_day | first_half |
              -- second_half). Only APPROVED shifts or suppresses (AD-14).
              -- IS TRUE (not a bare boolean): an employee with no leave day
              -- at all reads ld.state as NULL, and a NULL flag would make
              -- `not full_day_leave` NULL — silently dropping EVERY
              -- no-leave employee from the check-in/summary arms.
              ((ld.state = 'approved' and lr.part = 'full_day') is true)
                as full_day_leave,
              ((ld.state = 'approved' and lr.part = 'first_half') is true)
                as first_half_leave,
              ((ld.state = 'approved' and lr.part = 'second_half') is true)
                as second_half_leave,
              -- Rule 1 short-circuit: an active status-only override is an
              -- owner adjudication of this day.
              (ovd.id is not null and ovd.status is not null) as adjudicated,
              -- Effective instants: the override's manual instant REPLACES the
              -- record's (times-only overrides continue through the rules); an
              -- adjudicating status override contributes no instants.
              coalesce(ovd.manual_checkin_at, rec.checkin_at)  as checkin_at,
              coalesce(ovd.manual_checkout_at, rec.checkout_at) as checkout_at,
              -- floor() here too (same rounding class as v_now_min): a
              -- seconds-carrying check-in instant must truncate to its wall
              -- minute, matching the TS engine's minuteOfDayInTz.
              greatest(0,
                (floor(extract(epoch from
                     (coalesce(ovd.manual_checkin_at, rec.checkin_at)
                      at time zone v_tz)) / 60))::int % 1440
                - ((extract(epoch from r.start_time) / 60)::int + r.late_cutoff_minutes)
              ) as late_min,
              -- FR-2 enable-day grace mirrored from day-context.ts computeTracked:
              -- enabled_at on the work date AND its wall-minute > Start AND no
              -- check-in yet → not tracked for reminders today.
              (date(e.enabled_at at time zone v_tz) = v_today
                and (floor(extract(epoch from (e.enabled_at at time zone v_tz))
                          / 60))::int % 1440
                    > (extract(epoch from r.start_time) / 60)::int
                and coalesce(ovd.manual_checkin_at, rec.checkin_at) is null
              ) as grace_skip,
              -- The enrolment pick the outer dedupe makes (exposed only so
              -- `distinct on` can order deterministically — never used in
              -- the reminder arms).
              lower(e.valid) as enrol_from
            from public.attendance_enrolments e
            join public.attendance_office_assignments a
              on a.employee_id = e.employee_id
             and a.tenant_id = v_tenant_id
             and a.valid @> v_today
            join public.attendance_offices o
              on o.id = a.office_id and o.archived_at is null
            join lateral (
              select rrow.*
              from public.attendance_office_rules rrow
              where rrow.office_id = a.office_id
                and rrow.valid @> v_today
              limit 1
            ) r on true
            left join lateral (
              select lrd.state, lrd.leave_request_id
              from public.leave_request_days lrd
              where lrd.employee_id = e.employee_id
                and lrd.leave_date = v_today
                and lrd.state in ('pending', 'approved')
              limit 1
            ) ld on true
            left join public.leave_requests lr
              on lr.id = ld.leave_request_id
             and lr.tenant_id = v_tenant_id
            left join public.attendance_records rec
              on rec.employee_id = e.employee_id
             and rec.work_date = v_today
            left join public.attendance_day_overrides ovd
              on ovd.employee_id = e.employee_id
             and ovd.work_date = v_today
             and ovd.deleted_at is null
            where e.tenant_id = v_tenant_id
              and e.valid @> v_today
          ) inner_facts
          -- Oldest covering period wins (the enrolment pick the TS
          -- reader makes; `distinct on` needs this deterministic tie).
          order by inner_facts.employee_id, inner_facts.enrol_from asc
        ) f
      )
      insert into public.notifications
        (tenant_id, user_id, job_id, event_type, payload,
         entity_type, entity_id, dedupe_key)
      select
        v_tenant_id,
        rem.recipient_id,
        null::uuid,
        rem.event_type,
        rem.payload,
        rem.entity_type,
        rem.entity_id,
        rem.dedupe_key
      from (
        -- SCOPE NOTE (user decision 2026-09-29): reminders model rules
        -- whose Start/Expected end fall inside ONE tenant-local day.
        -- Midnight-crossing schedules are declared OUT OF SCOPE — every
        -- minute here is a wall-minute of v_today compared with
        -- v_now_min of the same local day, so an end past 24:00 would
        -- mis-fire against the wrong half of the day (D1's wrap-around
        -- gap). If that requirement ever lands, add the wrap arms then.
        -- Arm 1: check-in reminder — Start + Late cut-off; Midpoint +
        -- Late cut-off on an approved first-half leave day; approved
        -- full-day leave suppresses; pending leave never suppresses.
        select
          f.employee_id as recipient_id,
          'attendance.reminder_checkin' as event_type,
          jsonb_build_object('workDate', v_today) as payload,
          'attendance' as entity_type,
          f.employee_id as entity_id,
          v_tenant_id || ':attendance.reminder_checkin:'
            || f.employee_id || ':' || v_today as dedupe_key
        from facts f
        where f.is_working_day
          and not f.full_day_leave
          and not f.adjudicated
          and not f.grace_skip
          and f.checkin_at is null
          and v_now_min >= (
            case when f.first_half_leave
                 then f.midpoint_min + f.cutoff
                 else f.start_min + f.cutoff end
          )

        union all

        -- Arm 2: check-out reminder — Expected end + actual late minutes
        -- (late = 0 → due at Expected end; user decision 2026-09-29),
        -- Midpoint + late minutes on an approved second-half leave day.
        select
          f.employee_id,
          'attendance.reminder_checkout',
          jsonb_build_object(
            'workDate', v_today,
            'checkinAt',
            to_char(f.checkin_at at time zone v_tz,
                    'YYYY-MM-DD"T"HH24:MI:SSOF')
          ),
          'attendance',
          f.employee_id,
          v_tenant_id || ':attendance.reminder_checkout:'
            || f.employee_id || ':' || v_today as dedupe_key
        from facts f
        where f.is_working_day
          and not f.adjudicated
          and f.checkin_at is not null
          and f.checkout_at is null
          and f.late_min is not null
          and v_now_min >= (
            case when f.second_half_leave
                 then f.midpoint_min + f.late_min
                 else f.end_min + f.late_min end
          )

        union all

        -- Arm 3: office summary for the owner — at Start + Late cut-off,
        -- one per office per day: how many tracked employees of that
        -- office are on a working day with no check-in and no approved
        -- full-day leave (first-half-leave employees count — their own
        -- reminder just fires later at Midpoint + cut-off).
        select
          adm.user_id,
          'attendance.reminder_not_checked_in',
          jsonb_build_object(
            'officeName', f.office_name,
            'notCheckedInCount', count(*),
            'workDate', v_today
          ),
          'attendance',
          f.office_id,
          v_tenant_id || ':attendance.reminder_not_checked_in:'
            || adm.user_id || ':' || v_today || ':' || f.office_id
        from facts f
        cross join (
          select m.user_id
          from public.memberships m
          join public.users au on au.id = m.user_id
          where m.tenant_id = v_tenant_id
            and m.role = 'company_admin'
            and m.status = 'active'
            and not au.disabled
        ) adm
        where f.is_working_day
          and not f.full_day_leave
          and not f.adjudicated
          and not f.grace_skip
          and f.checkin_at is null
          and v_now_min >= f.start_min + f.cutoff
        group by adm.user_id, f.office_id, f.office_name
        having count(*) > 0
      ) rem
      on conflict (dedupe_key) where dedupe_key is not null do nothing;
    exception
      when others then
        -- One tenant's failure never stops the others (AD-14). The
        -- warning carries the tenant id only — reminders involve no
        -- coordinates (NFR-9/11 hygiene).
        raise warning 'attendance_run_reminders: tenant % failed: %',
          v_tenant_id, sqlerrm;
    end;
  end loop;
end;
$$;

CREATE OR REPLACE FUNCTION public.set_employee_code() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_seq INT;
BEGIN
  -- The code now lives on memberships (decision 25). A caller that already
  -- supplied one (invite_member does) keeps it.
  IF NEW.employee_code IS NOT NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.employee_sequences (tenant_id, last_seq)
  VALUES (NEW.tenant_id, 1)
  ON CONFLICT (tenant_id)
  DO UPDATE SET last_seq = public.employee_sequences.last_seq + 1
  RETURNING last_seq INTO v_seq;

  NEW.employee_code := 'EMP-' || lpad(v_seq::text, GREATEST(3, length(v_seq::text)), '0');
  RETURN NEW;
END $$;

create trigger memberships_set_employee_code
  before insert on public.memberships
  for each row execute function public.set_employee_code();

-- Company setup. Plain English: creates the company and its first company_admin
-- membership as one all-or-nothing step. A repeat call by the company's own
-- admin only updates the company profile. It refuses a person who is a platform
-- admin, a disabled person, or a person who already belongs to a company as
-- anything other than its active admin.
drop function public.setup_tenant_for_owner(uuid, text, text, text, text, text);

create function public.setup_tenant_for_owner(
  p_user_id      uuid,
  p_company_name text,
  p_gstin        text,
  p_address      text,
  p_state_code   text,
  p_upi_vpa      text
)
returns table (
  id           uuid,
  created_by   uuid,
  company_name text,
  gstin        text,
  address      text,
  state_code   text,
  upi_vpa      text,
  created_at   timestamptz,
  updated_at   timestamptz,
  inserted     boolean
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_user       public.users%rowtype;
  v_member     public.memberships%rowtype;
  v_tenant_id  uuid;
  v_inserted   boolean := false;
begin
  -- Lock the person's row so two setups by the same person cannot interleave.
  select * into v_user from public.users u where u.id = p_user_id for update;
  if not found then
    raise exception 'user % not found', p_user_id
      using errcode = 'PT404', hint = 'RESOURCE_NOT_FOUND';
  end if;
  if v_user.disabled or v_user.platform_admin then
    raise exception 'this account cannot create a company'
      using errcode = 'PT403', hint = 'FORBIDDEN';
  end if;

  select * into v_member
    from public.memberships m
   where m.user_id = p_user_id and m.status <> 'removed';

  if found then
    if v_member.role <> 'company_admin' or v_member.status <> 'active' then
      raise exception 'this person already belongs to a company'
        using errcode = 'PT409', hint = 'DUPLICATE_RESOURCE';
    end if;
    v_tenant_id := v_member.tenant_id;
    update public.tenants t
       set company_name = p_company_name,
           gstin        = p_gstin,
           address      = p_address,
           state_code   = p_state_code,
           upi_vpa      = p_upi_vpa,
           updated_at   = now()
     where t.id = v_tenant_id;
  else
    insert into public.tenants (created_by, company_name, gstin, address, state_code, upi_vpa)
    values (p_user_id, p_company_name, p_gstin, p_address, p_state_code, p_upi_vpa)
    returning tenants.id into v_tenant_id;

    -- The employee code is filled in by the memberships trigger.
    insert into public.memberships (user_id, tenant_id, role, status)
    values (p_user_id, v_tenant_id, 'company_admin', 'active');
    v_inserted := true;
  end if;

  return query
    select t.id, t.created_by, t.company_name, t.gstin, t.address, t.state_code,
           t.upi_vpa, t.created_at, t.updated_at, v_inserted
      from public.tenants t
     where t.id = v_tenant_id;
end $$;

revoke all on function public.setup_tenant_for_owner(uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.setup_tenant_for_owner(uuid, text, text, text, text, text) to service_role;

-- 7. Search-path fixes (advisor findings) -----------------------------------------------------
alter function public.update_updated_at_column() set search_path = '';
alter function public.leave_request_days_state_guard() set search_path = '';
alter function public.workflow_steps_valid(jsonb) set search_path = '';

-- 8. The attendance access view reads memberships -----------------------------------------
create or replace view public.attendance_access_state
with (security_invoker = true) as
 select m.user_id,
        m.tenant_id,
        (coalesce(s.enabled, false) and s.setup_completed_at is not null) as attendance_enabled,
        case
            when coalesce(s.enabled, false) is false or s.setup_completed_at is null then 'none'::text
            when cur.period_start is not null then 'active'::text
            when nx.next_start is not null then 'upcoming'::text
            when past.seen is not null then 'history_only'::text
            else 'none'::text
        end as access_state,
        case
            when cur.period_start is not null then cur.period_start
            when nx.next_start is not null then nx.next_start
            else null::date
        end as attendance_start_date,
        cur.enabled_at,
        ob.onboarded_at,
        a.office_id,
        o.name as office_name,
        case
            when cur.period_start is null and nx.next_start is null then (
                select max(upper(e.valid)) - 1
                  from public.attendance_enrolments e
                 where e.employee_id = m.user_id
                   and upper(e.valid) <= public.attendance_today(m.tenant_id)
                   and upper(e.valid) < 'infinity'::date)
            else null::date
        end as attendance_ended_on,
        case
            when coalesce(s.enabled, false) and s.setup_completed_at is not null and m.role = 'company_admin' then (
                select count(distinct d.leave_request_id)
                  from public.leave_request_days d
                 where d.tenant_id = m.tenant_id and d.state = 'pending')
            else 0::bigint
        end as pending_leave_requests
   from public.memberships m
   left join public.attendance_settings s on s.tenant_id = m.tenant_id
   left join public.attendance_onboarding ob on ob.employee_id = m.user_id
   left join lateral (
        select e.employee_id, lower(e.valid) as period_start, e.enabled_at
          from public.attendance_enrolments e
         where e.employee_id = m.user_id
           and e.valid @> public.attendance_today(m.tenant_id)
         limit 1) cur on true
   left join lateral (
        select min(lower(e.valid)) as next_start
          from public.attendance_enrolments e
         where e.employee_id = m.user_id
           and lower(e.valid) > public.attendance_today(m.tenant_id)) nx on true
   left join lateral (
        select 1 as seen
          from public.attendance_enrolments e
         where e.employee_id = m.user_id
           and upper(e.valid) <= public.attendance_today(m.tenant_id)
         limit 1) past on true
   left join lateral (
        select a_1.office_id
          from public.attendance_office_assignments a_1
         where a_1.employee_id = m.user_id
           and a_1.valid @>
               case
                   when cur.period_start is not null then public.attendance_today(m.tenant_id)
                   when nx.next_start is not null then nx.next_start
                   else public.attendance_today(m.tenant_id)
               end
         limit 1) a on true
   left join public.attendance_offices o on o.id = a.office_id and o.archived_at is null
  where m.status <> 'removed';

-- 9. Row-level security reads memberships --------------------------------------------------------
-- A policy runs as the caller, who cannot read `memberships`. This helper
-- (security definer, private schema) answers "is this user in my company?".
create function private.user_in_my_company(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.memberships m
     where m.user_id = p_user_id
       and m.tenant_id = (select private.current_company_id())
       and m.status <> 'removed'
  )
$$;
revoke all on function private.user_in_my_company(uuid) from public, anon, authenticated;
grant execute on function private.user_in_my_company(uuid) to authenticated, service_role;

-- Company tables. Read: any member of the company. Write: not a viewer.
-- (customers: company admin only; report_requests: a viewer may insert, decision 39.)
do $$
declare
  t record;
begin
  for t in
    select * from (values
      ('activity_logs',      array['company_admin','employee'],           array['company_admin','employee']),
      ('attachment_uploads', array['company_admin','employee'],           array['company_admin','employee']),
      ('attachments',        array['company_admin','employee'],           array['company_admin','employee']),
      ('customers',          array['company_admin'],                      array['company_admin']),
      ('idempotency_log',    array['company_admin','employee'],           array['company_admin','employee']),
      ('jobs',               array['company_admin','employee'],           array['company_admin','employee']),
      ('report_requests',    array['company_admin','employee','viewer'],  array['company_admin','employee'])
    ) as v(tbl, insert_roles, change_roles)
  loop
    execute format('drop policy %I on public.%I', t.tbl || '_tenant_isolation', t.tbl);

    execute format($f$create policy %I on public.%I for select to authenticated
      using (tenant_id = (select private.current_company_id()))$f$,
      t.tbl || '_member_read', t.tbl);

    execute format($f$create policy %I on public.%I for insert to authenticated
      with check (tenant_id = (select private.current_company_id())
                  and (select private.current_member_role()) = any (%L::text[]))$f$,
      t.tbl || '_member_insert', t.tbl, t.insert_roles);

    execute format($f$create policy %I on public.%I for update to authenticated
      using (tenant_id = (select private.current_company_id())
             and (select private.current_member_role()) = any (%L::text[]))
      with check (tenant_id = (select private.current_company_id())
                  and (select private.current_member_role()) = any (%L::text[]))$f$,
      t.tbl || '_member_update', t.tbl, t.change_roles, t.change_roles);

    execute format($f$create policy %I on public.%I for delete to authenticated
      using (tenant_id = (select private.current_company_id())
             and (select private.current_member_role()) = any (%L::text[]))$f$,
      t.tbl || '_member_delete', t.tbl, t.change_roles);
  end loop;
end $$;

-- user_skills: people of my company. Write: not a viewer.
drop policy user_skills_tenant_isolation on public.user_skills;
create policy user_skills_member_read on public.user_skills for select to authenticated
  using ((select private.user_in_my_company(user_id)));
create policy user_skills_member_write on public.user_skills for all to authenticated
  using ((select private.user_in_my_company(user_id))
         and (select private.current_member_role()) in ('company_admin', 'employee'))
  with check ((select private.user_in_my_company(user_id))
              and (select private.current_member_role()) in ('company_admin', 'employee'));

-- users: my own row, plus people in my company. The old policy also exposed
-- every row with no company (and their phone numbers): correction 6.
drop policy users_read_own_or_null_tenant on public.users;
create policy users_read_own_or_company on public.users for select to authenticated
  using (id = nullif(auth.jwt() ->> 'sub', '')::uuid
         or (select private.user_in_my_company(id)));

-- tenants: my company, through my active membership (decision 33).
create policy tenants_member_read on public.tenants for select to authenticated
  using (id = (select private.current_company_id()));
