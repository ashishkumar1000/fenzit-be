-- Product feedback 2026-09-20: expand the skill catalog from 6 broad trades
-- to 28 granular, description-carrying skills (flat — no category levels).
--
-- The New Job skill picker now searches the full catalog and shows one-line
-- descriptions per skill, so the catalog itself carries the copy (name +
-- description); per-skill icons follow in 20260920000002 — a `skills.icon`
-- column holding lucide icon names, resolved app-side by fenzo-app.
--
-- Pre-launch clean cutover (same posture as 20260911000001/2):
--   1) Wipe test jobs (TRUNCATE jobs CASCADE) — their skill_id FK RESTRICTs
--      against the rows being replaced.
--   2) Wipe technician skill tags (user_skills) — they reference the retired
--      Story 4.1 seed UUIDs; technicians get re-tagged against the new
--      catalog.
--   3) Wipe workflow_templates and skills, then reseed.
--   4) Add skills.description (NOT NULL — added after the delete, no
--      backfill).
--   5) Reseed the 28-skill catalog (fixed UUIDs) + one v1 workflow template
--      per skill, the same 6-step chain as 20260911000002.
--
-- The Story 4.1/4.3 "fixed seed UUIDs must never change" rule is superseded
-- by this migration by design — it IS the catalog replacement. The new UUIDs
-- below are now the fixed ones; later migrations may reference them.

-- 1) + 2) + 3) Dependent rows first, then the reference tables themselves
--    (workflow_templates RESTRICTs on skills; user_skills RESTRICTs too).
TRUNCATE jobs CASCADE;

DELETE FROM user_skills;
DELETE FROM workflow_templates;
DELETE FROM skills;

-- 4) Description rides on the catalog row itself (one line, owner-facing
--    copy rendered under the name in the picker).
ALTER TABLE skills ADD COLUMN description TEXT NOT NULL;

-- 5a) The 28-skill catalog. Seed order matches the New Job grid: first five
--     tiles are the first five rows (plumbing, then AC per the design mock).
INSERT INTO skills (id, name, description, sort_order)
SELECT id::uuid, name, description, sort_order
FROM (VALUES
  ('34d565e9-0619-4614-a83f-d38b8caea613', 'Pipe Leak Repair',               'Locate and fix leaking or burst pipes',                        1),
  ('e685bfdf-93a4-4cef-a38b-2fdc1dde87a2', 'Drain Cleaning & Unclog',        'Clear blocked drains, sinks and toilets',                      2),
  ('5cd5ed90-9db2-4ef7-af1f-eb1756efa13f', 'Water Heater Service',           'Install, repair and service geysers',                          3),
  ('e498f0e1-f9e0-4fe0-aa8c-3cf3fce7aaa5', 'Tap & Sanitary Fitting',         'Install or repair taps, showers and sanitary fittings',        4),
  ('c5195783-4446-4fa0-b7b9-ac0fc55230c0', 'AC Installation & Removal',      'Install or uninstall split and window ACs',                    5),
  ('081b8ee9-13be-4cdb-937e-1aeba0bf179d', 'Gas Charging & Leak Check',      'Refrigerant top-up and leak detection',                        6),
  ('9b7543bd-465d-433a-b8ec-30772b89c346', 'Duct & Coil Cleaning',           'Deep-clean AC filters, coils and ducts',                       7),
  ('f10601f0-5af2-48d3-a787-f01af9d75405', 'AC General Service',             'Routine AC servicing and performance check',                   8),
  ('25b8dbad-8996-4d01-a26c-4dc57ee5596f', 'Electrical Wiring & Repair',     'New wiring and electrical fault repair',                       9),
  ('05ea0db3-3384-4d5a-9281-e239eb96fe38', 'Switchboard & Socket Installation', 'Install or repair switchboards, sockets and MCBs',          10),
  ('8f8af0c2-247f-4c59-a021-eec0881d506c', 'Fan & Light Installation',       'Mount fans, chandeliers and light fittings',                   11),
  ('23b18871-c021-4dd7-9482-ba72e6d3a203', 'Inverter & Stabilizer Setup',    'Install and service inverters and stabilizers',                12),
  ('e3628fb0-4882-4f6d-aef3-a48ddcce0de3', 'General Pest Control',           'Cockroaches, ants and common household pests',                 13),
  ('0041b89b-ce09-49fb-a986-255e482fffbb', 'Termite Treatment',              'Pre- and post-construction termite control',                   14),
  ('c57b0371-f527-4c1c-a6e1-c4dc5ff4a079', 'Bed Bug & Mosquito Treatment',   'Targeted fumigation for bed bugs and mosquitoes',              15),
  ('62adb4d5-b6ee-435c-9038-b9a0e2939cd0', 'Deep Home Cleaning',             'Full-house deep cleaning, room by room',                       16),
  ('03a67044-f127-4717-b4d7-5e943f206022', 'Bathroom & Kitchen Cleaning',    'Targeted cleaning of wet areas and appliances',                17),
  ('a85864e7-2036-4cdf-9022-bc1f0e8025a3', 'Sofa & Carpet Cleaning',         'Upholstery shampooing and stain removal',                      18),
  ('1d1c21c7-1d0e-47d0-8887-b11f7db62210', 'Water Tank Cleaning',            'Overhead and underground tank cleaning',                       19),
  ('415e5292-f5b1-45c6-877d-421d652f24a9', 'Furniture Repair & Assembly',    'Fix, polish or assemble furniture',                            20),
  ('03c9b376-cec8-41a3-8156-8fb23cab81ad', 'Door & Lock Repair',             'Doors, hinges, locks and latches',                             21),
  ('0942a949-3471-4c52-8863-ddc0b168b862', 'Interior Painting',              'Wall putty and interior painting',                             22),
  ('f5d98075-f641-4a05-9ab4-4b663f144c9c', 'Waterproofing',                  'Terrace and wall leakage sealing',                             23),
  ('1e92d729-46e0-432d-a3f6-76d6c8f6f625', 'Washing Machine Repair',         'Repair and service all washing machine types',                 24),
  ('7fc82c84-375d-4e7c-a991-bd5986cfc1c7', 'Refrigerator Repair',            'Repair and service fridges and deep freezers',                 25),
  ('4073e7b5-a3c8-4b9b-bce5-7ba783858390', 'Microwave & Chimney Repair',     'Repair kitchen appliances and chimneys',                       26),
  ('580ffdf7-637e-491a-bcee-60acc5d99c38', 'CCTV & Doorbell Installation',   'Install cameras, video doorbells and smart locks',             27),
  ('a539a0b5-8ac4-47c1-8dcb-e5aaa03e1606', 'Handyman Visit',                 'One visit for small miscellaneous jobs',                       28)
) AS seed(id, name, description, sort_order);

-- 5b) One v1 template per skill — the identical 6-step chain every skill got
--     in 20260911000002. The engine, RPC and advance flow are untouched.
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
  ('61819fa0-7bb5-4af0-b801-dc791779f04d', '34d565e9-0619-4614-a83f-d38b8caea613'),
  ('dced24ce-5ca4-4d03-ac8e-95b15194e174', 'e685bfdf-93a4-4cef-a38b-2fdc1dde87a2'),
  ('3a37b8f7-1c14-40ed-a965-6a9973863d19', '5cd5ed90-9db2-4ef7-af1f-eb1756efa13f'),
  ('466377e0-1944-4509-b275-9f974da5ff00', 'e498f0e1-f9e0-4fe0-aa8c-3cf3fce7aaa5'),
  ('6fa9824c-3ac7-4c44-9ace-3ef3ed41a147', 'c5195783-4446-4fa0-b7b9-ac0fc55230c0'),
  ('3fb3d299-c86f-4ba3-9e97-8fd5e7ad2002', '081b8ee9-13be-4cdb-937e-1aeba0bf179d'),
  ('89e25212-4f91-45a2-990f-928c9988df63', '9b7543bd-465d-433a-b8ec-30772b89c346'),
  ('c615c047-bc1b-4d38-b3a1-7b877210bea8', 'f10601f0-5af2-48d3-a787-f01af9d75405'),
  ('19bd2724-9d0a-4bba-a383-99c66be1693a', '25b8dbad-8996-4d01-a26c-4dc57ee5596f'),
  ('7121222a-3cfc-4bf3-b012-fa378e00c185', '05ea0db3-3384-4d5a-9281-e239eb96fe38'),
  ('fbb0a1e5-3002-44eb-b32d-d956bba17efd', '8f8af0c2-247f-4c59-a021-eec0881d506c'),
  ('48c96750-cdeb-43d1-9044-a40259072ab6', '23b18871-c021-4dd7-9482-ba72e6d3a203'),
  ('7b27661e-0dd4-4fbc-bfb2-b3dbef32094c', 'e3628fb0-4882-4f6d-aef3-a48ddcce0de3'),
  ('f0177d04-0753-483f-a6e2-f97d8bc3b557', '0041b89b-ce09-49fb-a986-255e482fffbb'),
  ('9bd1722f-a7bc-4113-8785-3f13522849a9', 'c57b0371-f527-4c1c-a6e1-c4dc5ff4a079'),
  ('b246a498-a826-42e3-9606-e5df85fe14ef', '62adb4d5-b6ee-435c-9038-b9a0e2939cd0'),
  ('401d0f00-c1c2-4ee3-b1a8-68c4511f2d2d', '03a67044-f127-4717-b4d7-5e943f206022'),
  ('7d6b1d5d-43f1-4ea5-b60b-eb8c54bd342e', 'a85864e7-2036-4cdf-9022-bc1f0e8025a3'),
  ('11e13e59-74a8-46fc-9633-68d366f248f8', '1d1c21c7-1d0e-47d0-8887-b11f7db62210'),
  ('31016816-6062-46db-bd29-2ac5842f0c58', '415e5292-f5b1-45c6-877d-421d652f24a9'),
  ('44795604-b344-4dc1-b8fd-75d6af980a27', '03c9b376-cec8-41a3-8156-8fb23cab81ad'),
  ('5756dadf-3a2b-42f5-b4cf-94ed62a62d7e', '0942a949-3471-4c52-8863-ddc0b168b862'),
  ('70c1e4e7-cae9-4327-babd-aa5d153235eb', 'f5d98075-f641-4a05-9ab4-4b663f144c9c'),
  ('a9b267b1-150f-42f5-8322-a6231bfce116', '1e92d729-46e0-432d-a3f6-76d6c8f6f625'),
  ('380e6e19-13f6-4d29-86e9-f5aac29f1307', '7fc82c84-375d-4e7c-a991-bd5986cfc1c7'),
  ('4e7cafec-c0a4-441f-bde6-0c6ff4ce104c', '4073e7b5-a3c8-4b9b-bce5-7ba783858390'),
  ('43519d6f-9335-486c-9b97-21e0d9863137', '580ffdf7-637e-491a-bcee-60acc5d99c38'),
  ('5fb0102f-3ed3-4a65-894d-0796cff24ea4', 'a539a0b5-8ac4-47c1-8dcb-e5aaa03e1606')
) AS t(id, skill_id)
JOIN skills s ON s.id = t.skill_id::uuid
CROSS JOIN v1_steps;

-- 5c) Closing guard: the INSERT above JOINs on hard-coded UUIDs, so a typo
--     would silently DROP a row (a JOIN miss inserts nothing, no error).
--     Fail loudly on a partial reseed instead of shipping a catalog where a
--     skill has no workflow template (job creation would fail at runtime).
DO $$
BEGIN
  IF (SELECT count(*) FROM skills) <> 28 THEN
    RAISE EXCEPTION 'skill reseed produced % rows, expected 28', (SELECT count(*) FROM skills);
  END IF;
  IF (SELECT count(*) FROM workflow_templates) <> 28 THEN
    RAISE EXCEPTION 'workflow template reseed produced % rows, expected 28', (SELECT count(*) FROM workflow_templates);
  END IF;
END $$;
