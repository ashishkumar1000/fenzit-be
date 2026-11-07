-- Wider service catalog from market research (teaching and training, other
-- on-site home and business services, and field and office roles). Each skill
-- is developer-seeded and gets its own v1 workflow template, the same 6-step
-- chain as every other skill. Sort order 57 to 84 continues the catalog.
--
-- Names checked against the catalog so none duplicates an existing skill.
-- Icons are lucide names checked against the lucide-react-native typings the
-- app installs.

INSERT INTO skills (id, name, description, sort_order, icon) VALUES
  ('1834b87c-31da-4413-b7c3-63c9936d88d3', 'Maths Tuition', 'Helps school students with maths lessons, homework and exam practice', 57, 'sigma'),
  ('b2277ee5-7420-4a79-b294-e15f9ec88165', 'Science Tuition', 'Teaches school science topics with homework and test practice', 58, 'atom'),
  ('2241f243-fa56-4b37-91ef-a6e529be36bf', 'Accounts & Commerce Tuition', 'Teaches accounts and business subjects for school and college students', 59, 'book-open'),
  ('7ae4931f-72ac-47b4-a3f8-422083f4773e', 'English Language Tuition', 'Helps students with English reading, writing and grammar', 60, 'languages'),
  ('163b76f7-3b90-4d7e-bb9b-da9adaf23298', 'Spoken English Tutor', 'Helps adults and students speak English with confidence', 61, 'mic'),
  ('00e5d35e-8fcf-4756-b48b-ff0571f21a4a', 'Music Lessons', 'Teaches singing or instruments for beginners and advanced learners', 62, 'music'),
  ('24de2f9c-152e-4428-a3ce-d15b7e38500c', 'Dance Classes', 'Teaches classical, folk and western dance styles', 63, 'person-standing'),
  ('049b52bc-a1dd-4cce-a6cb-3e960b709af8', 'Coding Tutor', 'Teaches programming basics to school students and beginners', 64, 'code'),
  ('6dd5edfd-ef95-4f43-a254-bf0b8df47e58', 'Corporate Trainer', 'Runs staff training and employee development sessions', 65, 'presentation'),
  ('c0fc3247-477a-4b7f-9c71-16009abbe8e7', 'Salon At Home', 'Beauty and salon services at the customer''s home', 66, 'scissors'),
  ('b24ea19e-8f04-4dce-8567-8d07d25f4a06', 'Massage At Home', 'Relaxation and therapy massage at the customer''s home', 67, 'hand'),
  ('cf7b0f97-a12e-4136-839e-e762d4e663fc', 'Elderly Nursing Care', 'Trained caregivers support seniors and patients at home', 68, 'heart-pulse'),
  ('2933c88a-f601-4715-8080-19287ec5c432', 'Babysitter & Nanny', 'Vetted babysitters and nannies, booked by the hour', 69, 'baby'),
  ('f7ae8a88-7adb-402f-a124-0c2c42992e98', 'Pet Grooming At Home', 'Bathing, haircuts and nail care for pets at home', 70, 'dog'),
  ('4400e028-fff1-41c3-a732-135420fef211', 'Solar Panel Cleaning', 'Cleans rooftop solar panels to restore power output', 71, 'sun'),
  ('17b2cdef-a682-46b5-8135-aed766413645', 'Borewell & Tank Cleaning', 'Cleans and sanitises water tanks, sumps and borewells', 72, 'droplet'),
  ('632775e7-6013-47cb-9aa0-6e9c4dc263be', 'Packers & Movers', 'Packing, loading and transport for home or office moves', 73, 'truck'),
  ('ad80b59e-1758-43a0-a658-7b1f01e73009', 'Modular Kitchen Fitting', 'Installs custom modular kitchen units in homes and offices', 74, 'cooking-pot'),
  ('31d04bd7-bd11-43b5-8b63-a52937533927', 'Last-Mile Delivery Partner', 'Delivers parcels and orders on daily assigned routes', 75, 'package'),
  ('87b84794-18c9-433e-87ab-a7fa0ad66839', 'Cab & Chauffeur Driving', 'Drives cabs or company vehicles for trips and pickups', 76, 'car'),
  ('7a36e185-a974-498f-945d-8c3b4412744c', 'Medicine Delivery Rider', 'Delivers medicine orders from pharmacies to patients'' homes', 77, 'pill'),
  ('6c2dd091-42cf-4bbb-8741-138a015accf6', 'Warehouse & Store Keeping', 'Receives, stores and issues goods in warehouses and stores', 78, 'warehouse'),
  ('edd13b07-5a5f-444a-a259-73fc69485d01', 'Purchase & Vendor Management', 'Buys supplies and manages vendor orders and deliveries', 79, 'shopping-cart'),
  ('5e101e18-8d55-4aa6-bd2a-3d57670adea5', 'HR & Recruitment', 'Finds, screens and hires staff for businesses', 80, 'users'),
  ('83442c97-96fa-4450-9443-572c4c0f1fc2', 'Payroll Processing', 'Calculates salaries, deductions and monthly payslips', 81, 'wallet'),
  ('f2e41ca9-b8a1-47b4-8632-4e87a84bffa8', 'Meter Reading', 'Visits homes and businesses to read and record utility meters', 82, 'zap'),
  ('880deb69-9fed-4f19-80a3-5af5e4aedcd7', 'Home Sample Collection', 'Collects lab samples from patients at their homes', 83, 'test-tube'),
  ('5446d1c8-fd7a-4df1-91e9-58c725efe911', 'Field Survey & Data Collection', 'Visits households or sites to gather and record survey data', 84, 'map-pin');

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
  ('063553d7-549d-46a2-b19a-31f3836ae244', '1834b87c-31da-4413-b7c3-63c9936d88d3'),
  ('858f19cf-aa07-49a2-b7a5-840395c0ff28', 'b2277ee5-7420-4a79-b294-e15f9ec88165'),
  ('7897b471-df25-4201-bdb5-0ad6cff3093f', '2241f243-fa56-4b37-91ef-a6e529be36bf'),
  ('b3f503e2-4d61-41c3-8068-96c78ba07048', '7ae4931f-72ac-47b4-a3f8-422083f4773e'),
  ('957029fc-13a9-4068-b988-ba56acfd4417', '163b76f7-3b90-4d7e-bb9b-da9adaf23298'),
  ('fc1ffd50-555c-45b4-8237-da8b09d52da5', '00e5d35e-8fcf-4756-b48b-ff0571f21a4a'),
  ('e5737e77-ce6b-4de3-8122-001fa02dc6d6', '24de2f9c-152e-4428-a3ce-d15b7e38500c'),
  ('4e0bde53-ccc7-4eb8-96b6-d308f95f19e4', '049b52bc-a1dd-4cce-a6cb-3e960b709af8'),
  ('0aa39270-2081-47dd-b958-7f516ebcdfea', '6dd5edfd-ef95-4f43-a254-bf0b8df47e58'),
  ('6b235643-c126-4a4f-b51f-3f79d449e502', 'c0fc3247-477a-4b7f-9c71-16009abbe8e7'),
  ('8bfc9ff2-0bd7-4e87-8bfe-0b94a5b3c211', 'b24ea19e-8f04-4dce-8567-8d07d25f4a06'),
  ('386b15d3-fb03-4368-ab35-adbfd4ebb094', 'cf7b0f97-a12e-4136-839e-e762d4e663fc'),
  ('df907394-cb65-4853-94ec-892c60689511', '2933c88a-f601-4715-8080-19287ec5c432'),
  ('e7a5c310-2ba7-40e1-8924-ee471ac54ed5', 'f7ae8a88-7adb-402f-a124-0c2c42992e98'),
  ('480291c5-566b-4ac0-a9b8-658fe309a397', '4400e028-fff1-41c3-a732-135420fef211'),
  ('6aa12dfa-d71b-4229-8665-05690055b309', '17b2cdef-a682-46b5-8135-aed766413645'),
  ('a2972c38-a779-4720-8541-4f83cef65e9b', '632775e7-6013-47cb-9aa0-6e9c4dc263be'),
  ('c2e212d4-c008-45ac-a334-e1728ae8a702', 'ad80b59e-1758-43a0-a658-7b1f01e73009'),
  ('50a4cc2d-7beb-4e4b-9263-be9d216fcefa', '31d04bd7-bd11-43b5-8b63-a52937533927'),
  ('353681f9-8ce1-43dd-86a8-2c9d69b3b1a7', '87b84794-18c9-433e-87ab-a7fa0ad66839'),
  ('7a304808-ca36-4991-bcb3-712708db24b1', '7a36e185-a974-498f-945d-8c3b4412744c'),
  ('9f7681e1-cf90-49fa-a361-1bca95ac1a13', '6c2dd091-42cf-4bbb-8741-138a015accf6'),
  ('3a89e350-f69a-47ce-b9ae-ff02f380a6d3', 'edd13b07-5a5f-444a-a259-73fc69485d01'),
  ('18b98cb5-98c4-42db-b236-70c3009a93bc', '5e101e18-8d55-4aa6-bd2a-3d57670adea5'),
  ('0060b86e-b22f-496d-99ed-4d23833678e0', '83442c97-96fa-4450-9443-572c4c0f1fc2'),
  ('bdfc8d5f-44aa-413a-ae2d-d020d71115d4', 'f2e41ca9-b8a1-47b4-8632-4e87a84bffa8'),
  ('81e002c4-6153-4712-9975-96bdeafba8fc', '880deb69-9fed-4f19-80a3-5af5e4aedcd7'),
  ('99f14fc7-867d-40bf-8e4c-a676e1ef08c2', '5446d1c8-fd7a-4df1-91e9-58c725efe911')
) AS t(id, skill_id)
JOIN skills s ON s.id = t.skill_id::uuid
CROSS JOIN v1_steps;

-- Closing guard: a JOIN miss inserts nothing and raises nothing, so check that
-- every new skill got exactly one v1 template.
DO $$
BEGIN
  IF (SELECT count(*) FROM workflow_templates wt
        JOIN skills s ON s.id = wt.skill_id
       WHERE s.sort_order BETWEEN 57 AND 84
         AND wt.version = 1) <> 28 THEN
    RAISE EXCEPTION 'wider catalog: expected 28 v1 templates';
  END IF;
END $$;
