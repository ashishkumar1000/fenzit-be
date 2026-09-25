-- Story 14.2: additive entity/dedupe columns on notifications (AD-13).
--
-- Three nullable columns that later attendance/leave epics need:
--   entity_type / entity_id — polymorphic deep-link target (entity_id is UUID
--     but has no FK on purpose: it can point at attendance_sessions, leave
--     requests, reports, etc. depending on entity_type — a single FK is
--     impossible for a polymorphic reference).
--   dedupe_key — DB-guaranteed dedupe for reminders / repeated-event
--     notifications: the partial unique index rejects a second INSERT with the
--     same non-null key. NULL keys (all current job/report inserts) never
--     collide, so existing insert paths are untouched.
--
-- Additive only: no existing column or row changes; existing job/report
-- notification rows keep their shape with the new columns NULL. No new insert
-- path, no new function — just columns + index (rule 6: no new DB functions).

ALTER TABLE public.notifications
  ADD COLUMN entity_type TEXT,
  ADD COLUMN entity_id   UUID,
  ADD COLUMN dedupe_key  TEXT;

-- Partial unique index: uniqueness applies only where a dedupe key is set.
--
-- MANDATORY KEY FORMAT (Story 14-2 review): the index is global on dedupe_key
-- alone, so key TEXT must be unique across ALL tenants. Every future inserter
-- MUST derive keys in the tenant-recipient-prefixed form
--   '<tenantId>:<eventType>:<entityId>'
-- (or equivalent recipient-prefixed form) — two tenants deriving the same
-- key text would otherwise collide here with 23505. No insert path sets
-- dedupe_key yet; scoping is enforced by convention until the AD-13 event
-- registry epic adds the guarded inserter.
CREATE UNIQUE INDEX notifications_dedupe_key_uniq
  ON public.notifications (dedupe_key)
  WHERE dedupe_key IS NOT NULL;