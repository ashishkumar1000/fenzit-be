-- Composite index for the customer-detail job-history query (Story 2.4):
-- WHERE tenant_id = $1 AND customer_id = $2 ORDER BY scheduled_start DESC, id DESC
CREATE INDEX IF NOT EXISTS idx_jobs_customer_history
  ON jobs (tenant_id, customer_id, scheduled_start DESC, id DESC);
