-- 24-5b / CAP-4 + D7: the pending-leave reminder follows the approver branch.
--
-- Plain-English contract
--   The 10:00 digest used to go to EVERY active company admin, with one
--   tenant-wide count. It now goes to the RESOLVED approver set of each
--   pending request — the same walk the decide path runs
--   (src/attendance/approval-routing.ts, mirrored below) — and each recipient
--   sees only the requests THEY must decide.
--
--   Rules, in the order the TS walk applies them:
--     * An active, enabled company admin filing for themself decides it
--       themself (D11): nobody is reminded.
--     * Otherwise walk up `manager_id`: the nearest active, enabled member
--       decides, unless they are the ACTOR (the person who filed it — an
--       on-behalf filing never reminds its own author, D14).
--     * An inactive, removed or disabled member is climbed past; an unassigned
--       one (manager_id is null) or a chain that leaves the company falls back
--       to every active, enabled admin except the actor (D12).
--     * A loop or a chain deeper than the cap (20) resolves to nobody.
--   The reminder runs inside pg_cron with no Nest process, so the walk lives
--   here as a small helper; the TypeScript walk stays the source of truth.
--
--   `attendance.reminder_not_checked_in` deliberately stays an admin signal:
--   it aggregates a whole office, has no requester and therefore no resolved
--   approver set (recorded in the story plan).
--
-- The reminder function is patched as text (the 20261020000006/09 pattern):
-- the expected block must be found exactly once, or the migration raises
-- rather than silently leaving the old fan-out in place.

-- 1. The resolved approver set of one pending request -------------------------
create or replace function public.attendance_leave_approvers(
  p_tenant_id    uuid,
  p_requester_id uuid,
  p_actor_id     uuid
)
returns uuid[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  -- Mirrors MAX_HIERARCHY_DEPTH + 1 in src/common/members/hierarchy.ts.
  v_max_steps          constant integer := 21;
  v_requester          public.memberships%rowtype;
  v_requester_disabled boolean;
  v_current            uuid;
  v_member             public.memberships%rowtype;
  v_member_disabled    boolean;
  -- Seeded with the requester, like approval-routing.ts: a corrupt chain that
  -- climbs back to them resolves to nobody, never "the requester decides
  -- their own on-behalf filing".
  v_seen               uuid[] := array[p_requester_id];
  v_steps              integer := 0;
begin
  select * into v_requester
    from public.memberships
   where tenant_id = p_tenant_id
     and user_id = p_requester_id;
  if not found then
    -- Corrupt: no membership at all. UNRESOLVED (null), never "nobody to
    -- notify" — the caller warns on it.
    return null;
  end if;

  select u.disabled into v_requester_disabled
    from public.users u
   where u.id = p_requester_id;

  -- An active, enabled admin decides their own filing (D11), and a submission
  -- notifies no one. An empty array means "nothing to do", not "unresolved".
  if coalesce(v_requester_disabled, true) is false
     and v_requester.status = 'active'
     and v_requester.role = 'company_admin' then
    return array[]::uuid[];
  end if;

  v_current := v_requester.manager_id;
  while v_current is not null loop
    v_steps := v_steps + 1;
    if v_steps > v_max_steps or v_current = any (v_seen) then
      return null; -- corrupt loop or a chain past the cap
    end if;
    v_seen := v_seen || v_current;

    select * into v_member
      from public.memberships
     where tenant_id = p_tenant_id
       and user_id = v_current;
    if not found then
      exit; -- the chain leaves the company
    end if;

    select u.disabled into v_member_disabled
      from public.users u
     where u.id = v_current;

    if coalesce(v_member_disabled, true) is false
       and v_member.status = 'active'
       and v_current <> p_actor_id then
      return array[v_current];
    end if;

    if v_member.manager_id is null then
      exit; -- the walk stepped up past an unassigned member
    end if;
    v_current := v_member.manager_id;
  end loop;

  -- Fallback (D12): every active, enabled admin except the actor (D14). A
  -- company with no admin left answers NULL (unresolved) — the caller warns,
  -- because an admin must fix it; an EMPTY array is reserved for the admin
  -- self-filing above, which needs no reminder and no warning.
  return (
    select array_agg(m.user_id order by m.user_id)
      from public.memberships m
      join public.users u on u.id = m.user_id
     where m.tenant_id = p_tenant_id
       and m.role = 'company_admin'
       and m.status = 'active'
       and not u.disabled
       and m.user_id <> p_actor_id
  );
end;
$$;

comment on function public.attendance_leave_approvers(uuid, uuid, uuid) is
  '24-5b: the resolved approver set of one pending leave request. NULL = unresolved (nobody decides); empty = nobody to notify (an admin self-filing). Mirrors src/attendance/approval-routing.ts.';

-- The reminder runs as its definer; a PostgREST caller must not reach a
-- company's approver map through /rest/v1/rpc.
revoke all on function public.attendance_leave_approvers(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.attendance_leave_approvers(uuid, uuid, uuid)
  to service_role;

-- 2. Route the pending digest to that set -------------------------------------
do $outer$
declare
  v_def   text;
  v_count integer;
  v_old   text;
  v_new   text;
begin
  v_def := pg_get_functiondef(
    'public.attendance_run_reminders(timestamp with time zone)'::regprocedure
  );

  -- 2a. The comment block: the behaviour it describes changed.
  v_old := $old$
      -- Pending-leave reminder: every active company admin, once per day at 10:00 tenant
      -- wall time (FR-23), when any pending leave day exists (a request's
      -- state lives on its per-day rows; count distinct requests). One
      -- insert per day per owner via the dedupe key — requests arriving
      -- after 10:00 stay silent until tomorrow (FR-23's "once a day").
      -- The (entity_type, entity_id) deep-link pair stays all-NULL
      -- (notifications_entity_pair_chk): the payload aggregates a count
      -- over MANY requests, so no single request is a deep-link target.$old$;
  v_new := $new$
      -- Pending-leave reminder: the RESOLVED approver set of each pending
      -- request (24-5b, CAP-4/D7), once per day at 10:00 tenant wall time
      -- (FR-23). attendance_leave_approvers mirrors the decision walk
      -- (src/attendance/approval-routing.ts): an admin's own filing notifies
      -- nobody, an on-behalf filing routes from the subject and excludes its
      -- author, and an unassigned employee falls back to every active admin
      -- except the author. pendingCount is what THIS recipient must decide,
      -- never the tenant's whole queue. One insert per day per recipient via
      -- the dedupe key — requests arriving after 10:00 stay silent until
      -- tomorrow (FR-23's "once a day").
      -- The (entity_type, entity_id) deep-link pair stays all-NULL
      -- (notifications_entity_pair_chk): the payload aggregates a count
      -- over MANY requests, so no single request is a deep-link target.$new$;
  v_count := (length(v_def) - length(replace(v_def, v_old, '')))
    / length(v_old);
  if v_count <> 1 then
    raise exception
      'attendance_run_reminders: pending-leave comment found % times, nothing patched',
      v_count;
  end if;
  v_def := replace(v_def, v_old, v_new);

  -- 2b. The fan-out itself: one row per resolved approver, count per person.
  v_old := $old$
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
            and exists (
              select 1 from public.memberships pm
              join public.users pu on pu.id = pm.user_id
              where pm.user_id = lrd.employee_id
                and pm.tenant_id = v_tenant_id
                and pm.status = 'active'
                and not pu.disabled
            )
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
        where pend.pending_count > 0$old$;
  v_new := $new$
        select
          v_tenant_id, rec.recipient_id, null::uuid,
          'leave.pending_reminder',
          jsonb_build_object('pendingCount', rec.pending_count),
          null::text, null::uuid,
          v_tenant_id || ':leave.pending_reminder:' || rec.recipient_id
            || ':' || v_today
        from (
          select a.approver_id as recipient_id,
                 count(distinct lr.id) as pending_count
          from public.leave_requests lr
          cross join lateral unnest(
            coalesce(
              public.attendance_leave_approvers(
                v_tenant_id, lr.employee_id, lr.created_by
              ),
              array[]::uuid[]
            )
          ) as a(approver_id)
          where lr.tenant_id = v_tenant_id
            and exists (
              select 1 from public.leave_request_days lrd
              where lrd.leave_request_id = lr.id
                and lrd.state = 'pending'
            )
            and exists (
              select 1 from public.memberships pm
              join public.users pu on pu.id = pm.user_id
              where pm.user_id = lr.employee_id
                and pm.tenant_id = v_tenant_id
                and pm.status = 'active'
                and not pu.disabled
            )
          group by a.approver_id
        ) rec
        where rec.pending_count > 0$new$;
  v_count := (length(v_def) - length(replace(v_def, v_old, '')))
    / length(v_old);
  if v_count <> 1 then
    raise exception
      'attendance_run_reminders: pending-leave fan-out found % times, nothing patched',
      v_count;
  end if;
  v_def := replace(v_def, v_old, v_new);

  execute v_def;
end $outer$;

-- 3. One warning per tenant per day when a pending request has no approver ----
-- (Unresolved is rare and an admin must fix the reporting line; the submission
-- path already answers APPROVER_UNRESOLVED, so this only keeps the cron honest
-- without logging once per request.) The cron ticks every five minutes and the
-- digest arm runs all afternoon, so the probe is gated to the 10:00 tick (and a
-- slightly late one): a diagnostic line, not 168 scans and warnings a day.
create or replace function public.attendance_warn_unresolved_leave(
  p_tenant_id uuid
)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if exists (
    select 1
      from public.leave_requests lr
     where lr.tenant_id = p_tenant_id
       and exists (
         select 1 from public.leave_request_days lrd
         where lrd.leave_request_id = lr.id
           and lrd.state = 'pending'
       )
       and exists (
         select 1 from public.memberships pm
         join public.users pu on pu.id = pm.user_id
         where pm.user_id = lr.employee_id
           and pm.tenant_id = p_tenant_id
           and pm.status = 'active'
           and not pu.disabled
       )
       and public.attendance_leave_approvers(
         p_tenant_id, lr.employee_id, lr.created_by
       ) is null
  ) then
    raise warning
      'attendance_run_reminders: tenant % has pending leave with no resolved approver',
      p_tenant_id;
  end if;
end;
$$;

revoke all on function public.attendance_warn_unresolved_leave(uuid)
  from public, anon, authenticated;
grant execute on function public.attendance_warn_unresolved_leave(uuid)
  to service_role;

do $warn$
declare
  v_def text;
  v_old text;
  v_new text;
  v_count integer;
begin
  v_def := pg_get_functiondef(
    'public.attendance_run_reminders(timestamp with time zone)'::regprocedure
  );
  -- The probe runs on the 10:00 tick only, inside the digest arm: the arm
  -- itself runs on every five-minute tick after 10:00, and the digest inserts
  -- dedupe on their key, but a warning would repeat all afternoon.
  v_old := $old$      if v_now_min >= (extract(epoch from time '10:00') / 60)::int then$old$;
  v_new := $new$      if v_now_min >= (extract(epoch from time '10:00') / 60)::int then
        if v_now_min < (extract(epoch from time '10:05') / 60)::int then
          perform public.attendance_warn_unresolved_leave(v_tenant_id);
        end if;$new$;
  v_count := (length(v_def) - length(replace(v_def, v_old, '')))
    / length(v_old);
  if v_count <> 1 then
    raise exception
      'attendance_run_reminders: pending-leave guard found % times, nothing patched',
      v_count;
  end if;
  execute replace(v_def, v_old, v_new);
end $warn$;
