-- 20261126000002_drop_legacy_holiday_rpcs.sql
--
-- The holiday lifecycle's TypeScript service path owns add/remove now:
-- insertHolidayInTx (src/attendance/holidays.service.ts) writes the row and
-- drives the recipient fan-out directly through fanoutHolidayNotification
-- (src/attendance/holiday-notify.ts), whose dedupe key carries the holiday
-- DATE so a moved holiday re-notifies. No BE code has called these SECURITY
-- DEFINER RPCs since that cutover — the only remaining callers were the
-- real-DB probes, re-pointed at the service's primitives (direct row writes
-- + the exported fanoutHolidayNotification) in the same change.
--
-- Dead SECURITY DEFINER surface on a tenant-scoped write path is standing
-- risk with no payoff: drop the last remaining overloads (the actor-param
-- variants died in 20260927000005). attendance_update_holiday and
-- attendance_holiday_impact are NOT touched here — they are pinned by the
-- RLS revocation probe and stay until their own removal is agreed.
--
-- Plain DROP (RESTRICT default): a live dependency would abort loudly rather
-- than cascade. IF EXISTS matches these exact signatures, so a drifted
-- overload would silently no-op — verified 2026-11-26 via pg_proc that prod
-- carries exactly one overload each (add(uuid, date, text),
-- remove(uuid, uuid)); the rls-isolation DROPPED_RPC_FUNCTIONS pin expects
-- PGRST202 once this lands, which also proves the PostgREST surface is gone.
--
-- Owner consent 2026-11-26 ("yes drop legacy migration").

drop function if exists public.attendance_add_holiday(
  p_tenant_id uuid,
  p_holiday_date date,
  p_name text
);
drop function if exists public.attendance_remove_holiday(
  p_tenant_id uuid,
  p_holiday_id uuid
);
