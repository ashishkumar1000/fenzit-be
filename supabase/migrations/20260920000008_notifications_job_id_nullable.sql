-- Report notifications have no job (Epic 12, Story 12-3).
--
-- The notifications table (migration 20260909000002) requires job_id NOT NULL
-- because every notification so far came from a job transition. Report
-- terminal notifications (report_ready | report_failed) point at a
-- report_requests row, not a job — their payload carries the report id and
-- status, so the job link is meaningless there.
--
-- Pre-launch widening of the story 3-1 constraint: the FK and ON DELETE
-- CASCADE stay; job_id simply becomes optional. No backfill needed (existing
-- rows all have a job).

ALTER TABLE notifications ALTER COLUMN job_id DROP NOT NULL;