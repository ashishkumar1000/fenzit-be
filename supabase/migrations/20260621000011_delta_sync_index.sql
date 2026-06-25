-- Composite index for the delta sync query: WHERE technician_id = $1 AND updated_at > $2
-- Makes the filter sargable even with 50+ jobs per technician (AC-4 p95 < 500ms).
CREATE INDEX IF NOT EXISTS idx_jobs_technician_id_updated_at
  ON jobs (technician_id, updated_at DESC);

-- Auto-refresh updated_at on any UPDATE so delta sync timestamps stay accurate.
-- Existing RPCs set it explicitly; this trigger makes it foolproof for future paths.
CREATE OR REPLACE FUNCTION update_updated_at_column()
  RETURNS TRIGGER
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_jobs_updated_at ON jobs;
CREATE TRIGGER trg_jobs_updated_at
  BEFORE UPDATE ON jobs
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
