-- Institution staff: non-teaching roles in schools, colleges and universities
-- (housekeeping, gardening, security, hostel, mess and canteen, transport,
-- library, labs, IT, campus maintenance, admissions). These are skills for
-- staff and employees who work inside an institution. Developer-seeded like
-- the rest of the catalog. Each skill gets its own v1 workflow template, the
-- same 6-step chain as every other skill.
--
-- Icons are lucide names checked against the lucide-react-native typings the
-- app installs. Sort order 45 to 56 continues the catalog.

INSERT INTO skills (id, name, description, sort_order, icon) VALUES
  ('cfdc475e-ec3b-4e9c-b018-8e8860182041', 'Campus Housekeeping', 'Cleaning and sanitation of classrooms, washrooms and corridors', 45, 'broom'),
  ('86ad6ac0-3390-45eb-bcea-3fca4882d956', 'Gardening & Landscaping', 'Lawn, plant and garden upkeep across the campus', 46, 'trees'),
  ('88238c12-f7f4-440d-a9cb-4f36ed5c46a9', 'Security Guard Duty', 'Gate, patrol and night security for the campus', 47, 'shield-check'),
  ('0bc47053-e021-4112-aa8c-06c3ca845327', 'Visitor Management', 'Front desk visitor passes, entry logs and access', 48, 'id-card'),
  ('98804abe-d105-45a2-bc3b-a7ab90235d68', 'Hostel Management', 'Hostel rooms, discipline, hygiene and caretaker duties', 49, 'bed-double'),
  ('af936a43-0047-45ea-bc22-fa0eb2ec384a', 'Canteen & Mess Service', 'Mess and canteen cooking, serving and hygiene', 50, 'utensils'),
  ('bcda1dd0-6ad7-4d2d-9b4d-a29b5434f9a0', 'Campus Transport Driving', 'Staff and student bus or car driving', 51, 'bus'),
  ('dc0e4ca9-23f6-45fb-95b0-1b36d4f24644', 'Library Assistance', 'Book issue, return and library desk support', 52, 'library'),
  ('cdb29b28-06d1-4a97-a37d-5bf2856fbe0d', 'Lab Assistance', 'Setting up and maintaining lab equipment and supplies', 53, 'flask-conical'),
  ('f8168b6e-bdf0-461a-b23a-9d6443fed363', 'IT Support', 'Computer, network and projector support for staff and labs', 54, 'laptop'),
  ('914a4ae7-ddfa-47cd-8515-52e80d5b8451', 'Campus Maintenance', 'Electrical, plumbing and repair upkeep of campus buildings', 55, 'hard-hat'),
  ('298092ea-64a9-4ca5-bdf1-e51c5c8e51d0', 'Admissions & Records', 'Student admission files, certificates and records', 56, 'graduation-cap');

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
  ('ad3d4c7a-43ec-4020-a95f-6fb9b620f147', 'cfdc475e-ec3b-4e9c-b018-8e8860182041'),
  ('e64482ea-918d-45d7-9277-af049bd0b0e2', '86ad6ac0-3390-45eb-bcea-3fca4882d956'),
  ('41dad78d-a457-46e8-a407-3d13b2b466ee', '88238c12-f7f4-440d-a9cb-4f36ed5c46a9'),
  ('c0f02142-8854-4eea-9655-c32ac8384220', '0bc47053-e021-4112-aa8c-06c3ca845327'),
  ('e7ad231b-25ed-4578-ab05-3db12a3f779f', '98804abe-d105-45a2-bc3b-a7ab90235d68'),
  ('5346b262-ab2e-46ca-a112-ad861105b9ce', 'af936a43-0047-45ea-bc22-fa0eb2ec384a'),
  ('8ddd0888-8f5e-4b9b-bb03-6cb7070bdc2f', 'bcda1dd0-6ad7-4d2d-9b4d-a29b5434f9a0'),
  ('61d3b7aa-a35a-4faf-bf19-7b1e68e70804', 'dc0e4ca9-23f6-45fb-95b0-1b36d4f24644'),
  ('0ce933d1-4bc2-4cf3-aa11-be2d0159bfc4', 'cdb29b28-06d1-4a97-a37d-5bf2856fbe0d'),
  ('e741e5dc-4b73-4a0e-ae3c-8cdadeebe0c7', 'f8168b6e-bdf0-461a-b23a-9d6443fed363'),
  ('2867333c-0f81-478c-a8ca-4982f36247c6', '914a4ae7-ddfa-47cd-8515-52e80d5b8451'),
  ('29c4c00d-d516-44b4-ae1a-6e4c6f833c08', '298092ea-64a9-4ca5-bdf1-e51c5c8e51d0')
) AS t(id, skill_id)
JOIN skills s ON s.id = t.skill_id::uuid
CROSS JOIN v1_steps;

-- Closing guard: a JOIN miss inserts nothing and raises nothing, so check that
-- every new skill got exactly one v1 template.
DO $$
BEGIN
  IF (SELECT count(*) FROM workflow_templates wt
        JOIN skills s ON s.id = wt.skill_id
       WHERE s.sort_order BETWEEN 45 AND 56
         AND wt.version = 1) <> 12 THEN
    RAISE EXCEPTION 'institution skills: expected 12 v1 templates';
  END IF;
END $$;
