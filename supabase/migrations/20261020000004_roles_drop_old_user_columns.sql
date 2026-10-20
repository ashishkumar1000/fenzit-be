-- Roles and access, step 4: a user record holds identity only.
--
-- Plain-English contract
--   * `users.role`, `users.tenant_id`, `users.status` and `users.employee_code`
--     are dropped, with their keys, indexes and checks. Company, role, status
--     and employee code live on `memberships` (steps 1 and 3).
--   * Nothing reads these columns any more: the functions and the attendance
--     view were rewritten in step 3, the policies in step 3, and the backend
--     reads memberships.
--   * Run only after step 3 and the backend that matches it.

-- Keys and indexes that only existed for the old columns. The 15 composite
-- keys that depended on users_id_tenant_id_key now point at memberships.
alter table public.users drop constraint users_tenant_id_fkey;
alter table public.users drop constraint users_id_tenant_id_key;
alter table public.users drop constraint users_tenant_employee_code_unique;
alter table public.users drop constraint users_role_check;
alter table public.users drop constraint users_status_check;

-- idx_users_tenant_id goes with the tenant_id column.
alter table public.users drop column role;
alter table public.users drop column tenant_id;
alter table public.users drop column status;
alter table public.users drop column employee_code;
