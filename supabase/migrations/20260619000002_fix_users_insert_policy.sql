DROP POLICY IF EXISTS users_insert_allow_any ON users;
DROP POLICY IF EXISTS users_insert_only_service_role ON users;
CREATE POLICY users_insert_only_service_role ON users FOR INSERT WITH CHECK (false);
