-- Enforce "one signature per job" as a DB invariant (Story 3.6, AC#7).
-- The confirm_attachment RPC signature branch does UPDATE-then-INSERT to upsert
-- the signature, but without a unique constraint two genuinely concurrent
-- signature confirms can both miss the existing row and both INSERT, leaving a
-- job with two signature attachments. A partial unique index makes the upsert
-- atomic (the second INSERT raises 23505) and makes the single-signature rule
-- authoritative at the database level.
--
-- Photos are intentionally NOT covered (a job may have up to 5); the photo cap
-- is enforced inside the RPC's photo branch.

CREATE UNIQUE INDEX uniq_attachments_signature_per_job
  ON attachments (job_id)
  WHERE attachment_type = 'signature';
