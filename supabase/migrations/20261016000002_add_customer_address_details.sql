-- SPEC-customer-map-pin-picker CAP-5: user-entered extra location detail
-- (flat / building / floor / landmark) that a resolved address lacks, so a
-- technician can find the exact door. Nullable — every existing create path
-- (free-text, resolved snapshot, pin drop) is unaffected when it is absent.
-- Deliberately its own column: user text must never be merged into the
-- geocoded address/formatted_address at storage.
ALTER TABLE customers ADD COLUMN address_details VARCHAR(255);
