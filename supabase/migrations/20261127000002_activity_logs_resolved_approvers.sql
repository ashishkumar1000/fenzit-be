-- 24-4/CAP-4: the job submission audit row records the resolved approver set
-- at submission time. Routing itself stays derived at action time — this
-- column answers "who should have decided this?" after a mid-flight reorg.
-- The create RPC is untouched (24-4 moves the DECISION off RPC, not the
-- create path); the NestJS service stamps this column right after create.
alter table public.activity_logs
  add column if not exists resolved_approvers uuid[];

comment on column public.activity_logs.resolved_approvers is
  '24-4: the resolved approver set recorded when a pending job was submitted (null for non-submission rows).';
