-- Bug-bash 2026-10-02 finding B-BUG-1 (attendance-bug-bash-2026-10-02-session-b.md):
-- reminder arms could fire up to 30 seconds EARLY. PG's `::int` cast ROUNDS to
-- nearest, so a tick in [threshold - 30s, threshold) already read as the
-- threshold minute (09:14:59 -> 555) and satisfied every
-- `v_now_min >= threshold` gate — live-proven: p_now = 09:14:59+05:30 fired
-- the check-in + office-summary arms a minute before Start + Late cut-off.
-- The TS engine's minuteOfDayInTz TRUNCATES, so the two clocks disagreed by
-- construction.
--
-- Fix: floor() the three instant->minute conversions that carry seconds (the
-- tick clock, a check-in's late-minute, the enable-at grace minute). The
-- rule-time casts are exact-by-construction (time columns carry no seconds)
-- and stay as they are. CREATE OR REPLACE only — no data change; dedupe keys
-- make the deployment ordering and re-runs safe.

create or replace function public.attendance_run_reminders(
  p_now timestamptz default null
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tenant   record;
  v_tenant_id uuid;
  v_owner_id  uuid;
  v_tz        text;
  v_today     date;
  v_now_min   integer;  -- tenant wall-clock minute-of-day at tick time
  v_tick      timestamptz; -- coalesce(p_now, now()) — the injected clock
begin
  -- One pass per tenant with the module on (AD-25: enabled + completed
  -- setup); each tenant runs in its own BEGIN…EXCEPTION sub-block.
  for v_tenant in
    select t.id as tenant_id, t.owner_id, t.timezone
    from public.tenants t
    join public.attendance_settings s on s.tenant_id = t.id
    where s.enabled = true
      and s.setup_completed_at is not null
      and t.owner_id is not null
  loop
    begin
      v_tenant_id := v_tenant.tenant_id;
      v_owner_id  := v_tenant.owner_id;
      v_tz        := v_tenant.timezone;
      v_tick      := coalesce(p_now, now());
      v_today     := coalesce(
        (v_tick at time zone v_tz)::date,
        public.attendance_today(v_tenant_id)
      );
      v_now_min   := (floor(extract(epoch from (v_tick at time zone v_tz))
                          / 60))::int % 1440;

      -- ------------------------------------------------------------
      -- Pending-leave reminder: the owner, once per day at 10:00 tenant
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
          v_tenant_id, v_owner_id, null::uuid,
          'leave.pending_reminder',
          jsonb_build_object('pendingCount', pend.pending_count),
          null::text, null::uuid,
          v_tenant_id || ':leave.pending_reminder:' || v_owner_id
            || ':' || v_today
        from (
          select count(distinct lrd.leave_request_id) as pending_count
          from public.leave_request_days lrd
          where lrd.tenant_id = v_tenant_id
            and lrd.state = 'pending'
        ) pend
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
            || f.employee_id || ':' || v_today
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
          v_owner_id,
          'attendance.reminder_not_checked_in',
          jsonb_build_object(
            'officeName', f.office_name,
            'notCheckedInCount', count(*),
            'workDate', v_today
          ),
          'attendance',
          f.office_id,
          v_tenant_id || ':attendance.reminder_not_checked_in:'
            || v_owner_id || ':' || v_today || ':' || f.office_id
        from facts f
        where f.is_working_day
          and not f.full_day_leave
          and not f.adjudicated
          and not f.grace_skip
          and f.checkin_at is null
          and v_now_min >= f.start_min + f.cutoff
        group by f.office_id, f.office_name
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
