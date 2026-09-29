-- Stories 18-1 + 18-2 review hardening (2026-09-29, BMAD code review) —
-- follows 20260929000002 exactly (grants/RLS untouched here).
--
-- 1. The missing at-rest XOR: 20260929000002's header says "the DB CHECKs
--    the content/pair rules", but only the content checks landed there —
--    no constraint rejected a row carrying BOTH a status and manual
--    instants. The API is XOR and `upsertOverride` (the sole writer) keeps
--    it; this carries the invariant into the schema so no future writer
--    can break it.
-- 2. Drop attendance_day_overrides_tenant_date_idx — the module's every
--    query filters employee_id + work_date, which the empdate_uq UNIQUE
--    already serves; the tenant rides the heap row. Dead write overhead.
-- 3. Replace attendance_corrections_created_idx — the history query
--    filters tenant + employee (+ optional work_date) and orders
--    created_at desc, id desc; without the employee prefix the index
--    cannot serve a per-employee page, so the page sorts after filtering.
--    The employee filter always precedes the keyset, so the new index is
--    the supporting one.

alter table public.attendance_day_overrides
  add constraint attendance_day_overrides_pair_check
  check (status is null
         or (manual_checkin_at is null and manual_checkout_at is null));

drop index if exists public.attendance_day_overrides_tenant_date_idx;

drop index if exists public.attendance_corrections_created_idx;
create index attendance_corrections_owner_page_idx
  on public.attendance_corrections (tenant_id, employee_id, created_at desc, id desc);
