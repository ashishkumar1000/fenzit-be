-- Story 3.8: per-job flag gating whether a customer signature must be captured
-- before the job can complete (mirrors require_completion_photo). Default false —
-- existing jobs become signature-optional (accepted: pre-launch, no real users).
ALTER TABLE jobs ADD COLUMN require_completion_signature BOOLEAN NOT NULL DEFAULT false;
