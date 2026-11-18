-- Story 23-9 (CAP-10): off-cycle staging hardening. DDL only — zero functions
-- and zero triggers.
--
-- 1. The zero-amount belt: the staging surface validates amount <> 0 (the
--    ledger-named gap; negatives are recovery by design and stay legal), and
--    this check keeps the invariant for any future writer.
-- 2. The re-run idempotency belt: a month's breaching re-run re-raises its
--    own excess under this unique — the engine's write path deletes its
--    untouched raised rows before inserting the fresh excess (23-9 plan,
--    decision 7), and the constraint keeps every other writer honest.

alter table public.payroll_off_cycle_lines
  add constraint payroll_off_cycle_lines_amount_nonzero check (amount <> 0);

alter table public.payroll_recovery_lines
  add constraint payroll_recovery_lines_month_raised_unique
  unique (tenant_id, membership_id, month_raised);
