-- Teaching role names: Teacher (school), Professor and Lecturer (college and
-- university). Basic role names that users search for. Each skill gets its own
-- v1 workflow template, the same 6-step chain as every other skill.
-- Sort order 97 to 99 continues the catalog.

INSERT INTO skills (id, name, description, sort_order, icon) VALUES
  ('8c2d8daa-7975-4be6-9151-f28a98bb8c56', 'Teacher', 'Teaches school students in a classroom or at home', 97, 'school'),
  ('5f43f078-5460-49fa-8819-6c59f3ff1140', 'Professor', 'Teaches and guides university-level courses and research', 98, 'landmark'),
  ('02de6010-eeae-4c77-930a-8576c0b8ec9b', 'Lecturer', 'Takes lectures and classes at a college or university', 99, 'book-user');

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
  ('470b45a1-da62-4d8e-b34d-1d93a36603e5', '8c2d8daa-7975-4be6-9151-f28a98bb8c56'),
  ('4bfcb2f1-f8d1-410f-a9fe-1418742e5508', '5f43f078-5460-49fa-8819-6c59f3ff1140'),
  ('be049f1b-3f2a-44aa-84a1-0851b5d01d30', '02de6010-eeae-4c77-930a-8576c0b8ec9b')
) AS t(id, skill_id)
JOIN skills s ON s.id = t.skill_id::uuid
CROSS JOIN v1_steps;

-- Closing guard: a JOIN miss inserts nothing and raises nothing, so check that
-- every new skill got exactly one v1 template.
DO $$
BEGIN
  IF (SELECT count(*) FROM workflow_templates wt
        JOIN skills s ON s.id = wt.skill_id
       WHERE s.sort_order BETWEEN 97 AND 99
         AND wt.version = 1) <> 3 THEN
    RAISE EXCEPTION 'teaching roles: expected 3 v1 templates';
  END IF;
END $$;
