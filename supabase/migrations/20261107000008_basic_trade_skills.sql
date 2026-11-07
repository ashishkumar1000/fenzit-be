-- Basic trade names that users search for first (plumber, electrician, AC
-- technician, painter and so on). The specific skills already in the catalog
-- (for example "Pipe Leak Repair") stay as they are. These broad names sit next
-- to them, so a company can use either one. Each skill gets its own v1 workflow
-- template, the same 6-step chain as every other skill. Sort order 85 to 96
-- continues the catalog.

INSERT INTO skills (id, name, description, sort_order, icon) VALUES
  ('8a83cd58-22da-43eb-9eda-0be3702ce3a9', 'Plumber', 'Plumbing work: pipes, taps, toilets and water lines', 85, 'pipette'),
  ('e8614a49-bbd6-49a6-9502-379b4d58cf11', 'Electrician', 'Electrical work: wiring, switches, fuses and fittings', 86, 'zap'),
  ('aae95db1-ffa1-4d2e-afe8-24a5aedc39dd', 'AC Technician', 'Air conditioner install, repair and servicing', 87, 'air-vent'),
  ('6324e2d7-57fd-4d17-aab6-74df2af73507', 'Painter', 'Interior and exterior painting and wall finishing', 88, 'paint-roller'),
  ('05a19b62-955a-4c28-a357-118d734a1a24', 'Cleaner', 'General cleaning of homes and offices', 89, 'spray-can'),
  ('de8cfbac-aca8-409c-8e0c-962a05fd683f', 'Mason', 'Brickwork, plastering and small civil repairs', 90, 'brick-wall'),
  ('908b523a-8532-4b1f-ad5d-764f3592036c', 'Tile & Flooring Work', 'Laying and repairing tiles, marble and flooring', 91, 'grid-3x3'),
  ('8ad3d415-006c-4d4c-8bdb-7feda7a3f4e4', 'Welder', 'Metal gates, grills, railings and welding repairs', 92, 'flame'),
  ('842bc8d0-b062-4e0c-8a8e-b8bc7a749078', 'Car & Bike Mechanic', 'Servicing and repair of cars and two-wheelers', 93, 'car-front'),
  ('764cb87f-13a0-4240-b29e-44fb74b69404', 'Cook', 'Home or event cooking and meal preparation', 94, 'chef-hat'),
  ('2f11313f-24ff-4608-83af-63cea50ec9a2', 'Domestic Help', 'Maid, cook and household help for daily chores', 95, 'house'),
  ('7971bc23-676f-4ea9-bc00-dca8fcc733e0', 'Locksmith', 'Lock opening, key making and lock replacement', 96, 'key');

WITH v1_steps AS (
  SELECT '[
    {"key": "on_my_way", "label": "On My Way", "requires_photo": false, "requires_signature": false, "sets_status": "in_progress", "advances_on": null},
    {"key": "arrived", "label": "Arrived", "requires_photo": false, "requires_signature": false, "sets_status": null, "advances_on": null},
    {"key": "in_progress", "label": "In Progress", "requires_photo": false, "requires_signature": false, "sets_status": null, "advances_on": null},
    {"key": "photos_uploaded", "label": "Photos Uploaded", "requires_photo": true, "requires_signature": false, "sets_status": null, "advances_on": "photo_confirm"},
    {"key": "signature_captured", "label": "Signature Captured", "requires_photo": false, "requires_signature": true, "sets_status": null, "advances_on": null},
    {"key": "completed", "label": "Completed", "requires_photo": false, "requires_signature": false, "sets_status": "completed", "advances_on": null}
  ]'::jsonb AS steps
)
INSERT INTO workflow_templates (id, skill_id, version, steps)
SELECT t.id::uuid, s.id, 1, steps
FROM (VALUES
  ('b235bb9e-a574-4e7c-9088-c0050b5ca0f5', '8a83cd58-22da-43eb-9eda-0be3702ce3a9'),
  ('e9bbe365-1615-491a-80e7-68c7f5cde731', 'e8614a49-bbd6-49a6-9502-379b4d58cf11'),
  ('fdc957e2-eef6-457d-940f-ca860098b9b0', 'aae95db1-ffa1-4d2e-afe8-24a5aedc39dd'),
  ('0ca206ef-1f69-4f20-a58c-882b766b2a27', '6324e2d7-57fd-4d17-aab6-74df2af73507'),
  ('8467bd1b-5a54-48df-a8d0-a169391ce390', '05a19b62-955a-4c28-a357-118d734a1a24'),
  ('a701f6a2-0d9d-4b6c-9645-c1161e3e756f', 'de8cfbac-aca8-409c-8e0c-962a05fd683f'),
  ('209c9a23-732c-4abd-9d58-10d531af8ae6', '908b523a-8532-4b1f-ad5d-764f3592036c'),
  ('e9fbf8ef-9172-467b-8e46-833399fcfd52', '8ad3d415-006c-4d4c-8bdb-7feda7a3f4e4'),
  ('e42a9043-333e-49fb-8c24-2746686a62e5', '842bc8d0-b062-4e0c-8a8e-b8bc7a749078'),
  ('3d5fd6d0-1f90-4a67-89ea-b4e899b7e7f3', '764cb87f-13a0-4240-b29e-44fb74b69404'),
  ('0c465fe5-d3d9-426c-b7d4-00fc6d26a3f1', '2f11313f-24ff-4608-83af-63cea50ec9a2'),
  ('9f09b705-af54-462d-887a-40bb1b2efcd1', '7971bc23-676f-4ea9-bc00-dca8fcc733e0')
) AS t(id, skill_id)
JOIN skills s ON s.id = t.skill_id::uuid
CROSS JOIN v1_steps;

-- Closing guard: a JOIN miss inserts nothing and raises nothing, so check that
-- every new skill got exactly one v1 template.
DO $$
BEGIN
  IF (SELECT count(*) FROM workflow_templates wt
        JOIN skills s ON s.id = wt.skill_id
       WHERE s.sort_order BETWEEN 85 AND 96
         AND wt.version = 1) <> 12 THEN
    RAISE EXCEPTION 'basic trades: expected 12 v1 templates';
  END IF;
END $$;
