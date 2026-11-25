-- Drop the dead invite_member function, 2026-11-25 (consented step 4 of the
-- EMP-code collision fix).
--
-- The 2026-11-25 incident fix moved invite minting into the backend
-- TypeScript (AuthService.inviteMember, pgPool.withTransaction — commit
-- 1e1efc6, deployed and live-verified: a prod invite minted EMP-005 with the
-- TypeScript audit signature). Migration 20261125000001 restored this
-- function only as a bridge until that deploy landed; its single-mint body
-- still carries the drift risk that shipped the incident, and a dead
-- SECURITY DEFINER entry point is one future caller away from a regression.
-- Its real-DB rules coverage moved to the service path the same day
-- (test/integration/invite-service-rules.integration.spec.ts replaces the
-- member-functions-invite(-rules) suites).
--
-- Grants travel with the function (no separate revoke needed). The other four
-- member functions (change_member_role, remove_member, set_user_disabled,
-- setup_tenant_for_owner) are untouched — set_employee_code stays too (the
-- memberships trigger still mints codes for callers that pass none).

drop function if exists public.invite_member(
  uuid, uuid, text, text, text, text, uuid[]
);
