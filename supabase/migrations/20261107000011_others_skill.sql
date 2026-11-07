-- "Others": a catch-all skill for work that no other skill covers. It sits at
-- sort order 0 so it is the first row in every picker. Gets a v1 workflow
-- template like every other skill.

INSERT INTO skills (id, name, description, sort_order, icon) VALUES
  ('7e53ce5b-1643-4620-a916-8fa0ca405c08', 'Others', 'Work that does not fit any skill in the list', 0, 'ellipsis');

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
  ('062c464c-b2a4-495f-832e-ba471b27492f', '7e53ce5b-1643-4620-a916-8fa0ca405c08')
) AS t(id, skill_id)
JOIN skills s ON s.id = t.skill_id::uuid
CROSS JOIN v1_steps;

DO $$
BEGIN
  IF (SELECT count(*) FROM workflow_templates wt
        JOIN skills s ON s.id = wt.skill_id
       WHERE s.sort_order = 0 AND wt.version = 1) <> 1 THEN
    RAISE EXCEPTION 'others skill: expected 1 v1 template';
  END IF;
END $$;
