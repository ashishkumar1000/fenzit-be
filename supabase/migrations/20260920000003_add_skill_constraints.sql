-- Product feedback 2026-09-20 (follow-up): guard the columns the app renders.
--
-- `skills.description` and `skills.icon` are owner-facing copy / icon names
-- the frontend renders verbatim (a blank description is a blank line under
-- the skill name; a malformed icon name silently falls back to a generic
-- glyph). NOT NULL alone allows empty strings and any junk in `icon`, so
-- these CHECKs pin the contract at the database instead of trusting every
-- future seed migration to get it right.
--
-- `icon` must be lowercase kebab-case (the lucide naming the app resolves —
-- 'droplets', 'shower-head'), which is also what the icon contract test in
-- fenzo-app assumes.

ALTER TABLE skills ADD CONSTRAINT skills_description_not_blank
  CHECK (length(btrim(description)) > 0);

ALTER TABLE skills ADD CONSTRAINT skills_icon_kebab_case
  CHECK (icon ~ '^[a-z0-9]+(-[a-z0-9]+)*$');