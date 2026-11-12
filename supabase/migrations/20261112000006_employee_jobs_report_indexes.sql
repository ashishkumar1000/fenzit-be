-- Indexes for story 6: the owner approval queue and the report windows.
--
-- Plain-English contract:
--   jobs_pending_queue_idx  the owner's approval queue reads only pending jobs of one
--                           company, oldest submission first. A partial index holds just
--                           those rows, so it stays small as approved jobs pile up.
--   jobs_tenant_created_idx the owner and employee reports read every job of one company
--                           created inside a date window.
-- Plain b-tree indexes. Adding them changes no data and no behaviour.

create index if not exists jobs_pending_queue_idx
  on public.jobs (tenant_id, created_at, id)
  where status = 'pending_approval';

create index if not exists jobs_tenant_created_idx
  on public.jobs (tenant_id, created_at);
