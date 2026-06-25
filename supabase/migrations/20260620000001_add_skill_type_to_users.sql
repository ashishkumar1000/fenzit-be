-- Story 1.4: Technician invitation & auto-accept
-- Adds skill_type column to users table for technician invite records.
-- Nullable: existing owner rows stay NULL; CHECK enforced only on non-null values.

ALTER TABLE users
  ADD COLUMN skill_type TEXT
  CHECK (skill_type IN ('ac_technician', 'pest_control', 'plumbing', 'electrical', 'general'));
