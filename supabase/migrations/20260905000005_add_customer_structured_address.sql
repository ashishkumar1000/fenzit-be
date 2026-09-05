-- Story 1.3: add structured-address columns to customers, populated from
-- Story 1.2's /places/resolve/:placeId ResolvedPlace shape. All nullable —
-- legacy free-text address/city requests are unaffected.
ALTER TABLE customers ADD COLUMN formatted_address TEXT;
ALTER TABLE customers ADD COLUMN pincode TEXT;
ALTER TABLE customers ADD COLUMN latitude DOUBLE PRECISION;
ALTER TABLE customers ADD COLUMN longitude DOUBLE PRECISION;
ALTER TABLE customers ADD COLUMN place_id TEXT;
