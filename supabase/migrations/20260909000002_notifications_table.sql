-- Owner notifications, Phase 1 (Story 3.1).
-- The notifications table is the persisted source of truth for owner
-- notifications AND the future Phase 2 push outbox: every row carries a stable
-- event_type and a self-sufficient payload (title/body can be composed from
-- event_type + payload alone), and pushed_at is the delivery marker the Phase 2
-- push worker will set (nullable, never set in this story).
--
-- Rows are written ONLY by the advance_workflow_step RPC (SECURITY DEFINER) —
-- clients never INSERT/UPDATE, so there is deliberately no write policy; RLS
-- exposes a recipient-only SELECT.
--
-- Realtime delivery uses the "Broadcast from Database" pattern (Supabase's
-- recommended method; postgres_changes is discouraged for new apps): an AFTER
-- INSERT trigger calls realtime.broadcast_changes() to fan the event out to the
-- private topic user:<user_id>:notifications. Authorization for the Realtime
-- path is the policy on realtime.messages below — keyed on the JWT sub claim,
-- mirroring the TO public + sub-based convention used across this project
-- (fenzit-be's custom JWT carries role: 'owner'|'technician', so policies are
-- TO public and claims do the authorization).

CREATE TABLE notifications (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID        NOT NULL REFERENCES tenants(id),
  user_id    UUID        NOT NULL REFERENCES users(id),
  job_id     UUID        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  event_type TEXT        NOT NULL,
  payload    JSONB       NOT NULL DEFAULT '{}',
  read_at    TIMESTAMPTZ,
  pushed_at  TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unread-count and newest-first list reads (Story 3.2) hit this index.
CREATE INDEX idx_notifications_user_created_at ON notifications (user_id, created_at DESC);

-- A deleted job's notifications are dead rows — cascade keeps job deletes
-- unblocked (the "orphaned job" edge then only has to cover the unreachable case).

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- Recipient-only read. Sub-based, mirroring the live tenants_read_own precedent
-- (proven working with fenzit-be's custom JWT).
CREATE POLICY notifications_read_own ON notifications
  FOR SELECT
  TO public
  USING (auth.jwt() ->> 'sub' = user_id::text);

-- Trigger function: broadcast each new row to the recipient's private topic.
-- search_path = '' matches Supabase's own realtime functions — unqualified
-- realtime. calls would break under an empty search_path, so fully qualify.
-- TG_OP is passed as BOTH event_name and operation per the broadcast_changes
-- signature; the trigger is AFTER INSERT only, so the wire event name is
-- always 'INSERT' (the FE subscribes with on('broadcast', { event: 'INSERT' })).
CREATE FUNCTION notifications_broadcast_changes()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM realtime.broadcast_changes(
    'user:' || NEW.user_id || ':notifications',
    TG_OP, TG_OP, TG_TABLE_NAME, TG_TABLE_SCHEMA, NEW, OLD
  );
  RETURN NULL;
END $$;

CREATE TRIGGER notifications_broadcast
  AFTER INSERT ON notifications
  FOR EACH ROW
  EXECUTE FUNCTION notifications_broadcast_changes();

-- Realtime authorization for the broadcast topic: a connection may receive
-- events only on topics embedding its own sub. The anon key matches zero
-- topics — this is the RLS-as-security-boundary guarantee for the Realtime path.
-- First policy ever on realtime.messages (verified live 2026-09-09: zero policies).
CREATE POLICY notifications_topic_recipient_only ON realtime.messages
  FOR SELECT
  TO public
  USING (
    realtime.topic() LIKE 'user:%:notifications'
    AND split_part(realtime.topic(), ':', 2) = auth.jwt() ->> 'sub'
  );
