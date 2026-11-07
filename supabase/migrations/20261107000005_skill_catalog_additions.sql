-- Catalog additions: one general skill, four home-service trades, seven
-- sales, marketing and collection skills, and four office skills. Developer-seeded, like the 28-skill
-- catalog (20260920000001). Each skill gets its own v1 workflow template, the
-- same 6-step chain as every other skill, because jobs read their template
-- from the skill they are tagged with.
--
-- Plain-English contract: a new row here shows up in the owner's skill
-- picker and the technician invite list straight away. "General Work" is only
-- a catalog row for now; it does not yet match every technician.
--
-- The icon is a lucide icon name (see 20260920000002). Names checked against
-- the lucide-react-native typings the app installs.

INSERT INTO skills (id, name, description, sort_order, icon) VALUES
  ('b5184bed-78bf-428b-9109-424d517d75ab', 'General Work', 'Small jobs that do not need a specific trade', 29, 'layout-grid'),
  ('606330d7-5762-43ec-93db-608d48800634', 'Carpentry', 'Wood work: doors, cupboards and shelves', 30, 'hammer'),
  ('48ee0b0b-a626-4f6f-ab09-a279343e6a97', 'Fan Repair', 'Repair and service ceiling fans', 31, 'fan'),
  ('fe7e51f0-9d15-48c2-99d8-3750a1d2f883', 'TV Repair', 'Repair LED and LCD TVs', 32, 'tv'),
  ('2de332fe-c38d-474a-a7bf-8e1a8bda9ce4', 'RO & Water Purifier Repair', 'Service and repair RO and water purifiers', 33, 'glass-water'),
  ('cb04599b-2e91-4805-9ff2-a73c39118a10', 'Field Sales', 'Meet customers in person and close sales', 34, 'briefcase'),
  ('c05afb4d-6111-4557-8b32-f1d44068827c', 'Telecalling', 'Call leads and customers to book or follow up', 35, 'phone-call'),
  ('f85d0e9d-5747-4b2d-a6c4-1136647b8060', 'Lead Generation', 'Find and qualify new potential customers', 36, 'target'),
  ('68f741bb-2525-4740-9d89-c700f7a523d0', 'Digital Marketing', 'Online ads, search and campaign work', 37, 'megaphone'),
  ('1cc0522e-9eb1-49eb-bb4c-69004e8d3715', 'Social Media', 'Create and manage social media posts', 38, 'share-2'),
  ('aafa2618-981b-4982-85b4-2881b2d344e7', 'Debt Collection', 'Recover overdue payments from customers', 39, 'banknote'),
  ('b3fbce99-f17b-45a8-a0a1-ad2f13c37aff', 'EMI & Payment Follow-up', 'Remind customers and track instalment payments', 40, 'receipt'),
  ('61b29dc0-dea3-4a55-b3b3-31e97e363d93', 'Customer Support', 'Answer customer calls, emails and complaints', 41, 'headset'),
  ('f77e1be9-3845-4467-a9de-e2316756fc60', 'Dispatch & Scheduling', 'Plan job slots and assign technicians to visits', 42, 'calendar-clock'),
  ('4425cb74-1a87-4bdd-b29a-cde42ab9d6a2', 'Billing & Accounts', 'Invoices, payments and ledger entries', 43, 'calculator'),
  ('7d4812e0-ef7c-4d96-af5d-d89dfb72791e', 'Office Admin', 'Records, filing, documents and general office work', 44, 'clipboard-list');

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
  ('56faea2c-5219-4354-b58a-ab5d049735df', 'b5184bed-78bf-428b-9109-424d517d75ab'),
  ('2754b943-487d-49e9-add7-7bcef75c4aa2', '606330d7-5762-43ec-93db-608d48800634'),
  ('c4ba2d2e-4ac9-4fc0-8910-96250722aea6', '48ee0b0b-a626-4f6f-ab09-a279343e6a97'),
  ('716297d4-3e77-4c0c-8b37-d70a60c515b6', 'fe7e51f0-9d15-48c2-99d8-3750a1d2f883'),
  ('7e39b4b3-9a5a-4abe-85ec-971b7b6b2dc5', '2de332fe-c38d-474a-a7bf-8e1a8bda9ce4'),
  ('de82c92d-ce62-40e2-be0c-82fd24a2b70e', 'cb04599b-2e91-4805-9ff2-a73c39118a10'),
  ('173ab51b-d719-45ef-9f52-a7d96a37da2c', 'c05afb4d-6111-4557-8b32-f1d44068827c'),
  ('b80447a0-8136-4ced-971b-68dcdd104bd0', 'f85d0e9d-5747-4b2d-a6c4-1136647b8060'),
  ('206c91f7-28e5-4875-ad0b-2995d306760f', '68f741bb-2525-4740-9d89-c700f7a523d0'),
  ('f0c2acb0-3b8a-4b16-a44f-b1a823d15a91', '1cc0522e-9eb1-49eb-bb4c-69004e8d3715'),
  ('727e404b-ff5e-474b-ae52-e1c5e2af740a', 'aafa2618-981b-4982-85b4-2881b2d344e7'),
  ('f64e7570-594f-4e5e-af45-4485a9650958', 'b3fbce99-f17b-45a8-a0a1-ad2f13c37aff'),
  ('579e6403-ce36-4636-8d4e-7e9f882a5c31', '61b29dc0-dea3-4a55-b3b3-31e97e363d93'),
  ('cbcaf523-6970-4db1-a672-673a072b3c60', 'f77e1be9-3845-4467-a9de-e2316756fc60'),
  ('b004ac77-db71-43e7-b379-8c5d90df611d', '4425cb74-1a87-4bdd-b29a-cde42ab9d6a2'),
  ('f3123035-38eb-4557-b3e9-540ff5aeface', '7d4812e0-ef7c-4d96-af5d-d89dfb72791e')
) AS t(id, skill_id)
JOIN skills s ON s.id = t.skill_id::uuid
CROSS JOIN v1_steps;

-- Closing guard: a JOIN miss inserts nothing and raises nothing, so check that
-- every new skill got exactly one v1 template.
DO $$
BEGIN
  IF (SELECT count(*) FROM workflow_templates wt
        JOIN skills s ON s.id = wt.skill_id
       WHERE s.sort_order BETWEEN 29 AND 44
         AND wt.version = 1) <> 16 THEN
    RAISE EXCEPTION 'skill catalog additions: expected 16 v1 templates';
  END IF;
END $$;
