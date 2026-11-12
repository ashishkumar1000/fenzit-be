-- Indexes for the employee-created-jobs foreign keys (stories 2 and 3).
--
-- Plain-English contract:
--   jobs.created_by  finds one employee's jobs fast (owner report per-employee
--                    breakdown, employee report, employee's own pending list).
--   jobs.decided_by  finds the jobs one owner decided (decision history, and the
--                    foreign key check on delete restrict).
-- Both are plain b-tree indexes. Adding them changes no data and no behaviour.

create index if not exists jobs_created_by_idx on public.jobs (created_by);
create index if not exists jobs_decided_by_idx on public.jobs (decided_by);
