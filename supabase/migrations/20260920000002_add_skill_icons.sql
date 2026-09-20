-- Product feedback 2026-09-20 (follow-up): per-skill icon, stored in the DB.
--
-- The icon is the lucide (https://lucide.dev/icons) icon NAME — a string the
-- app resolves against its bundled lucide icon set (unknown names fall back
-- to a neutral glyph). Storing the name here keeps the catalog fully
-- data-driven: the FE renders whatever GET /skills returns, and a future
-- skill added by seed migration picks its icon in the same row.
--
-- Names verified against the lucide-react-native version fenzo-app installs.

ALTER TABLE skills ADD COLUMN icon TEXT;

UPDATE skills SET icon = v.icon
FROM (VALUES
  ('34d565e9-0619-4614-a83f-d38b8caea613', 'droplets'),           -- Pipe Leak Repair
  ('e685bfdf-93a4-4cef-a38b-2fdc1dde87a2', 'brush-cleaning'),     -- Drain Cleaning & Unclog
  ('5cd5ed90-9db2-4ef7-af1f-eb1756efa13f', 'heater'),             -- Water Heater Service
  ('e498f0e1-f9e0-4fe0-aa8c-3cf3fce7aaa5', 'shower-head'),        -- Tap & Sanitary Fitting
  ('c5195783-4446-4fa0-b7b9-ac0fc55230c0', 'snowflake'),          -- AC Installation & Removal
  ('081b8ee9-13be-4cdb-937e-1aeba0bf179d', 'gauge'),              -- Gas Charging & Leak Check
  ('9b7543bd-465d-433a-b8ec-30772b89c346', 'fan'),                -- Duct & Coil Cleaning
  ('f10601f0-5af2-48d3-a787-f01af9d75405', 'air-vent'),           -- AC General Service
  ('25b8dbad-8996-4d01-a26c-4dc57ee5596f', 'cable'),              -- Electrical Wiring & Repair
  ('05ea0db3-3384-4d5a-9281-e239eb96fe38', 'plug'),               -- Switchboard & Socket Installation
  ('8f8af0c2-247f-4c59-a021-eec0881d506c', 'lightbulb'),          -- Fan & Light Installation
  ('23b18871-c021-4dd7-9482-ba72e6d3a203', 'battery-charging'),   -- Inverter & Stabilizer Setup
  ('e3628fb0-4882-4f6d-aef3-a48ddcce0de3', 'bug'),                -- General Pest Control
  ('0041b89b-ce09-49fb-a986-255e482fffbb', 'bug-off'),            -- Termite Treatment
  ('c57b0371-f527-4c1c-a6e1-c4dc5ff4a079', 'spray-can'),          -- Bed Bug & Mosquito Treatment
  ('62adb4d5-b6ee-435c-9038-b9a0e2939cd0', 'sparkles'),           -- Deep Home Cleaning
  ('03a67044-f127-4717-b4d7-5e943f206022', 'bath'),               -- Bathroom & Kitchen Cleaning
  ('a85864e7-2036-4cdf-9022-bc1f0e8025a3', 'sofa'),               -- Sofa & Carpet Cleaning
  ('1d1c21c7-1d0e-47d0-8887-b11f7db62210', 'barrel'),             -- Water Tank Cleaning
  ('415e5292-f5b1-45c6-877d-421d652f24a9', 'hammer'),             -- Furniture Repair & Assembly
  ('03c9b376-cec8-41a3-8156-8fb23cab81ad', 'door-closed-locked'), -- Door & Lock Repair
  ('0942a949-3471-4c52-8863-ddc0b168b862', 'paint-roller'),       -- Interior Painting
  ('f5d98075-f641-4a05-9ab4-4b663f144c9c', 'umbrella'),           -- Waterproofing
  ('1e92d729-46e0-432d-a3f6-76d6c8f6f625', 'washing-machine'),    -- Washing Machine Repair
  ('7fc82c84-375d-4e7c-a991-bd5986cfc1c7', 'refrigerator'),       -- Refrigerator Repair
  ('4073e7b5-a3c8-4b9b-bce5-7ba783858390', 'microwave'),          -- Microwave & Chimney Repair
  ('580ffdf7-637e-491a-bcee-60acc5d99c38', 'cctv'),               -- CCTV & Doorbell Installation
  ('a539a0b5-8ac4-47c1-8dcb-e5aaa03e1606', 'wrench')              -- Handyman Visit
) AS v(id, icon)
WHERE skills.id = v.id::uuid;

-- Backfilled above, then locked down — ADD COLUMN ... NOT NULL would fail on
-- the populated table (nulls in existing rows before the UPDATE).
ALTER TABLE skills ALTER COLUMN icon SET NOT NULL;
