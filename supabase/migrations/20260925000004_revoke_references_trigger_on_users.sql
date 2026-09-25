-- Story 14-1 code review (2026-09-25), user-sanctioned scope widening:
-- Revoke the two residual table privileges on public.users that no client
-- flow can use — REFERENCES and TRIGGER.
--
-- Live role_table_grants (checked 2026-09-25) showed anon AND authenticated
-- both holding REFERENCES and TRIGGER on users alongside the SELECT/INSERT/
-- DELETE/TRUNCATE grants story 14-1 deliberately left alone. Least privilege:
-- the app needs neither from a client JWT — every users write routes through
-- createAdmin() (service-role); creating an FK constraint or a trigger
-- requires schema CREATE privileges the client roles do not hold, so these
-- grants were pure attack surface with no reachability. SELECT/INSERT/
-- DELETE/TRUNCATE stay as-is (the story's frozen boundary for them is
-- untouched).

revoke references on public.users from anon;
revoke references on public.users from authenticated;
revoke trigger on public.users from anon;
revoke trigger on public.users from authenticated;

-- Belt-and-braces matching 20260925000003's treatment of table UPDATE:
-- strip any residual PUBLIC-level grant of the same two privileges.
revoke references on public.users from public;
revoke trigger on public.users from public;
