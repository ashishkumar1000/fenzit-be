-- 20261126000003_drop_dead_holiday_rpcs.sql
--
-- The last two holiday RPCs follow the add/remove pair out (20261126000002 —
-- owner consent 2026-11-26 "yes remove all dead code"):
--
--   attendance_update_holiday — the TypeScript updateHoliday
--   (src/attendance/holidays.service.ts) does the same guarded tenant-scoped
--   UPDATE itself (rowCount 0 → 404 ATTENDANCE_HOLIDAY_NOT_FOUND, pinned in
--   holidays.service.spec.ts) across name, description, scope AND the date —
--   the console redesign made every field editable where the RPC was
--   name-only; the RPC has no callers.
--
--   attendance_holiday_impact — the GET /attendance/holidays/impact route
--   serves the AD-24 preview from the TypeScript read (getImpact,
--   holidays.service.ts) with the per-office staff counts and
--   tracked/unassigned tallies the RPC never grew (the RPC's own
--   approved-leave overlap, added 20261023000000, lives on verbatim).
--
-- pg_depend (queried 2026-11-26): no view, trigger or function body depends
-- on either; pg_proc shows exactly one overload each — update(uuid, uuid,
-- uuid, text), impact(uuid, date). Plain DROP (RESTRICT): a live dependency
-- would abort loudly rather than cascade. The rls-isolation
-- DROPPED_RPC_FUNCTIONS pin expects PGRST202 for both once this lands,
-- proving the PostgREST surface is gone.
--
-- With this, the whole 15-5 holiday RPC surface is TypeScript-only; the
-- attendance RPCs that remain are the ones src/ still calls (grep `.rpc(`):
-- setup/enrolment helpers, the weekly-off lifecycle, offices, locks,
-- attendance_today, reminders and the audit writer.

drop function if exists public.attendance_update_holiday(
  p_tenant_id uuid,
  p_holiday_id uuid,
  p_name text
);
drop function if exists public.attendance_holiday_impact(
  p_tenant_id uuid,
  p_date date
);
