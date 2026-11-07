-- Bulk customer import, follow-up to 20261107000015 (review decisions).
--
-- Plain-English contract:
--   * status says whether an import run finished. 'running' while rows are
--     being written; 'completed' once the batch counts and the audit entry
--     are written. A run that stops part-way stays 'running', so staff can
--     see it did not finish. Existing rows: none exist yet (pre-launch).
--   * When a staff user is deleted (the super CLI purge does this), the
--     import run keeps its counts and file name, and actor_user_id becomes
--     NULL. Before, the delete was blocked by the foreign key. The purge
--     check only blocks RESTRICT / NO ACTION keys, so this needs no change
--     to the purge tool.

ALTER TABLE public.import_batches
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed'));

ALTER TABLE public.import_batches
  ALTER COLUMN actor_user_id DROP NOT NULL;

ALTER TABLE public.import_batches
  DROP CONSTRAINT IF EXISTS import_batches_actor_user_id_fkey;

ALTER TABLE public.import_batches
  ADD CONSTRAINT import_batches_actor_user_id_fkey
  FOREIGN KEY (actor_user_id) REFERENCES public.users (id) ON DELETE SET NULL;
