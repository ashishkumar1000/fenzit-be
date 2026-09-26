-- Story 15-2 (Epic 15): Attendance module foundation — tenant timezone.
-- tenants.timezone: TEXT NOT NULL DEFAULT 'Asia/Kolkata' (AD-7). Validated by
-- a BEFORE INSERT OR UPDATE OF timezone trigger against pg_timezone_names —
-- Postgres cannot reference that catalog in a CHECK constraint. Invalid names
-- raise PT422 (PTxxx convention: last 3 digits = HTTP status) with a HINT
-- carrying the ErrorCode name, per the error convention in
-- 20260920000005_rpc_claim_report_request.sql.
--
-- Region-style names only (must contain '/'): offset-only zone names like
-- 'UTC' or 'GMT' are rejected so AT TIME ZONE maths and DST rules behave
-- predictably. 'Asia/Kolkata' is the seed default for all tenants.

alter table public.tenants
  add column timezone text not null default 'Asia/Kolkata';

-- AD-3: every function created by an attendance migration is SECURITY DEFINER
-- SET search_path = public with EXECUTE revoked from PUBLIC, anon,
-- authenticated (20260925000003 pattern), callable only via service_role.
create or replace function public.tenants_timezone_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_timezone_names
    where name = new.timezone
      and position('/' in name) > 0
  ) then
    raise exception 'invalid tenant timezone "%"', new.timezone
      using errcode = 'PT422',
            hint = 'ATTENDANCE_INVALID_TIMEZONE';
  end if;
  return new;
end;
$$;

revoke execute on function public.tenants_timezone_guard()
  from public, anon, authenticated;
grant execute on function public.tenants_timezone_guard() to service_role;

drop trigger if exists tenants_timezone_guard on public.tenants;
create trigger tenants_timezone_guard
  before insert or update of timezone on public.tenants
  for each row execute function public.tenants_timezone_guard();