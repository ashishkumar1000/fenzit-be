-- Invite SMS go-live (epic 21, requirement 2026-11-17): an activated member
-- must never be texted. The send path gains a last-line guard that skips the
-- SMS when the membership is no longer 'invited' at send time, and records
-- that as a new audit outcome, 'skipped_active'. Widen the outcome check to
-- accept it. Nothing else about the table changes.
--
-- DEPLOY ORDER: this migration must apply BEFORE the code that returns
-- 'skipped_active' deploys. The audit insert swallows its own errors, so an
-- early code deploy would skip the SMS correctly but silently lose every
-- skip-audit row against the old four-value check. (Applied to both
-- Supabase projects on 2026-11-17 via MCP.)

alter table public.invite_sms_audit
  drop constraint invite_sms_audit_outcome_check;

alter table public.invite_sms_audit
  add constraint invite_sms_audit_outcome_check
  check (
    outcome in ('sent', 'failed', 'refused_cap', 'not_configured', 'skipped_active')
  );
