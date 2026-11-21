-- Employee profile story (2026-11-21): memberships gain a `deactivated`
-- status, between `active` and `removed`. A deactivated member keeps their
-- row (jobs, attendance, leave, payslips untouched) but holds no live
-- membership for the auth resolver (`membership-resolver` counts only
-- `status = 'active'`), so they lose access on their next request until the
-- owner reinstates them. Constraint widening only — no new functions (no-RPC
-- rule), no grants to touch (memberships is service-only under deny-by-default RLS).

alter table public.memberships
  drop constraint memberships_status_check;

alter table public.memberships
  add constraint memberships_status_check
  check (status in ('invited', 'active', 'deactivated', 'removed'));
