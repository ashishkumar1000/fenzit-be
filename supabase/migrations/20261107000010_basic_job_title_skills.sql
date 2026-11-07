-- Basic job-title names that users search for: Collection Agent, Survey Agent,
-- Sales Executive, Marketing Executive, Accountant, Receptionist, Driver, Nurse
-- and Delivery Boy. The specific skills (for example "Debt Collection") stay as
-- they are. Each skill gets its own v1 workflow template, the same 6-step chain
-- as every other skill. Sort order 100 to 108 continues the catalog.

INSERT INTO skills (id, name, description, sort_order, icon) VALUES
  ('c1e294fd-e33f-414b-a6db-40e6d5529173', 'Collection Agent', 'Visits or calls customers to collect dues and payments', 100, 'hand-coins'),
  ('ddce5943-183c-48c9-986f-1dd5ec4c0e8c', 'Survey Agent', 'Visits homes or sites to conduct surveys and record answers', 101, 'clipboard-check'),
  ('b6c68176-656a-4625-a2a8-ed8ba40e177d', 'Sales Executive', 'Finds customers, presents products and closes sales', 102, 'trending-up'),
  ('a8361bda-4e49-4061-8ea3-cfcdab5fc7a0', 'Marketing Executive', 'Plans and runs promotions, ads and marketing campaigns', 103, 'megaphone'),
  ('52a87c25-5dc2-43b5-b4cd-799d8dd6be1a', 'Accountant', 'Keeps books, prepares invoices and tracks payments', 104, 'file-spreadsheet'),
  ('486b923a-690d-48ce-9f2e-5b7f5d9f6e54', 'Receptionist', 'Greets visitors, answers calls and manages the front desk', 105, 'concierge-bell'),
  ('df7b3a9e-d730-45b3-9add-f7fff0a72f19', 'Driver', 'Drives a car, van or bus for trips and pickups', 106, 'car'),
  ('bbce938a-9d7f-474b-8e12-9aab641d5fcc', 'Nurse', 'Gives nursing care and patient support at home or in a clinic', 107, 'stethoscope'),
  ('7bd5e380-d092-4e94-b881-b9b40f050606', 'Delivery Boy', 'Delivers orders and parcels to customers on a route', 108, 'bike');

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
  ('ddffbad2-7da1-47a9-a2cc-0e1bd5d43483', 'c1e294fd-e33f-414b-a6db-40e6d5529173'),
  ('87e0ac87-277e-4b10-ab10-3367c8a2ab70', 'ddce5943-183c-48c9-986f-1dd5ec4c0e8c'),
  ('4a4d5bb9-ef43-48e1-9553-b2b6c8b73e3d', 'b6c68176-656a-4625-a2a8-ed8ba40e177d'),
  ('b81eb93e-bab1-48d6-9bd2-e76fddfe20f3', 'a8361bda-4e49-4061-8ea3-cfcdab5fc7a0'),
  ('59734bb0-ec03-4009-8fba-949c32291f3c', '52a87c25-5dc2-43b5-b4cd-799d8dd6be1a'),
  ('abdcb09d-9525-4948-a83d-934ca1d920ab', '486b923a-690d-48ce-9f2e-5b7f5d9f6e54'),
  ('4b21d7a2-d7aa-4da7-b69f-6dc65ee4266d', 'df7b3a9e-d730-45b3-9add-f7fff0a72f19'),
  ('c10dc471-ba5a-49d9-82df-02c33ee08677', 'bbce938a-9d7f-474b-8e12-9aab641d5fcc'),
  ('b6ca73bf-85ef-4288-8638-d7f636baa7ad', '7bd5e380-d092-4e94-b881-b9b40f050606')
) AS t(id, skill_id)
JOIN skills s ON s.id = t.skill_id::uuid
CROSS JOIN v1_steps;

-- Closing guard: a JOIN miss inserts nothing and raises nothing, so check that
-- every new skill got exactly one v1 template.
DO $$
BEGIN
  IF (SELECT count(*) FROM workflow_templates wt
        JOIN skills s ON s.id = wt.skill_id
       WHERE s.sort_order BETWEEN 100 AND 108
         AND wt.version = 1) <> 9 THEN
    RAISE EXCEPTION 'basic job titles: expected 9 v1 templates';
  END IF;
END $$;
