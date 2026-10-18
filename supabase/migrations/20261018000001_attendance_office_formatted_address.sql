-- Office pin address: the human-readable address of the office pin
-- (e.g. "Koramangala, Bengaluru"), so the app can show a place instead of raw
-- coordinates when an office is reopened.
--
-- Display text only — latitude/longitude on this row stay the single source of
-- truth for geofence checks. Nullable: offices saved before this column (and
-- pins with no address lookup) simply have none, and the app falls back to
-- coordinates. The API clears it whenever the pin moves without a new address,
-- so it can never describe a different place than the coordinates.
-- No RPC change: the create RPC is untouched; the address is written by a
-- guarded single-row UPDATE right after it (same pattern as the profile PATCH).
alter table public.attendance_offices
  add column formatted_address text,
  add constraint attendance_offices_formatted_address_len
    check (formatted_address is null or char_length(btrim(formatted_address)) between 1 and 500);

comment on column public.attendance_offices.formatted_address is
  'Display address of the office pin (client-supplied, never used for geofence checks); null when none was saved.';
