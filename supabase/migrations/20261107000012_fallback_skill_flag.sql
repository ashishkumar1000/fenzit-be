-- Fallback skill flag: marks the catch-all skill ("Others") that every picker
-- keeps visible, even when a search matches nothing else. The flag lives in
-- the database so the app and the API agree on which skill it is.
--
-- At most one skill can be the fallback (partial unique index), so a second
-- catch-all cannot be added by accident.

ALTER TABLE skills ADD COLUMN is_fallback BOOLEAN NOT NULL DEFAULT false;

UPDATE skills SET is_fallback = true WHERE name = 'Others';

CREATE UNIQUE INDEX skills_one_fallback ON skills (is_fallback) WHERE is_fallback;

DO $$
BEGIN
  IF (SELECT count(*) FROM skills WHERE is_fallback) <> 1 THEN
    RAISE EXCEPTION 'fallback skill flag: expected exactly one fallback skill';
  END IF;
END $$;
