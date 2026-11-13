-- Adds a request fingerprint to idempotency_log.
--
-- Plain-English contract:
--   request_hash  a SHA-256 of the request body, saved with the first answer.
--                 A retry sends the same body, so the hash matches and the saved
--                 answer is replayed. The same key with a different body is refused
--                 (422 IDEMPOTENCY_KEY_REUSED) instead of silently replaying the
--                 first request's answer.
-- Nullable on purpose: rows saved before this migration have no hash, so they keep
-- replaying exactly as before. Adding a nullable column changes no existing data.

alter table public.idempotency_log
  add column if not exists request_hash text;
