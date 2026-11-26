-- 24-3/CAP-4: the submission audit event records the resolved approver set at
-- submission time. Routing itself stays derived at action time — this column
-- answers "who should have decided this?" after a mid-flight reorg without
-- reintroducing a static binding.
alter table public.leave_events
  add column if not exists resolved_approvers uuid[];

comment on column public.leave_events.resolved_approvers is
  '24-3: the resolved approver set recorded when the request was filed (null for non-submission events).';
