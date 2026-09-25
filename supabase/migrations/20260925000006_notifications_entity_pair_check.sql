-- Story 14.2 (review patch, 2026-09-25): the polymorphic deep-link pair
-- (entity_type, entity_id) is meaningless half-set — a kind without a target
-- id (or a target id without a kind) can never be deep-linked, so this CHECK
-- requires the pair to be all-NULL or all-set. Existing rows are all
-- both-NULL and pass. Additive only; no function, no insert path change.
ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_entity_pair_chk
  CHECK ((entity_type IS NULL) = (entity_id IS NULL));