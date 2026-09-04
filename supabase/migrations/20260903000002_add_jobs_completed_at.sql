-- Story 3.7: add completed_at to jobs (nullable; NULL until a job actually completes).
-- Backfill: no completed-at event exists historically, so best-effort from updated_at
-- (updated_at is the last write on the row; for a completed job that is the completion).
ALTER TABLE jobs ADD COLUMN completed_at TIMESTAMPTZ;

-- completed_at IS NULL guard: a manual re-run must not overwrite completed_at
-- with a later updated_at for jobs that already carry a (backfilled) stamp.
UPDATE jobs SET completed_at = updated_at WHERE status = 'completed' AND completed_at IS NULL;
