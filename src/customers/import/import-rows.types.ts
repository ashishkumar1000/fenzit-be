/** Row cap per import request (SPEC: 500 rows). The DTO enforces it with a 422. */
export const IMPORT_MAX_ROWS = 500;

export type ImportRowField =
  | 'row'
  | 'name'
  | 'address'
  | 'phone'
  | 'coordinates'
  | 'city'
  | 'state'
  | 'pincode'
  | 'address_details';

export interface ImportRowReason {
  field: ImportRowField;
  code: string;
  message: string;
}

export type ImportRowFlag =
  'no_map_pin' | 'updates_existing' | 'country_code_differs';

export interface ImportRowValues {
  name: string | null;
  address: string | null;
  countryCode: string | null;
  phoneNumber: string | null;
  latitude: number | null;
  longitude: number | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  addressDetails: string | null;
}

export interface ImportRowResult {
  rowIndex: number;
  status: 'valid' | 'invalid';
  normalised: ImportRowValues;
  reasons: ImportRowReason[];
  flags: ImportRowFlag[];
  existingCustomerId: string | null;
}

export interface ImportValidateResponse {
  rows: ImportRowResult[];
  summary: {
    total: number;
    valid: number;
    invalid: number;
    willUpdateExisting: number;
    noMapPin: number;
  };
}

/** One row after its own checks, before the sheet-wide duplicate checks. */
export interface ImportRowDraft {
  rowIndex: number;
  values: ImportRowValues;
  /** `countryCode|phoneNumber` when the phone parsed, else null. */
  phoneKey: string | null;
  reasons: ImportRowReason[];
  flags: ImportRowFlag[];
}

export interface ValidateOptions {
  /** Supported dial codes from country_codes, e.g. '+91'. */
  dialCodes: readonly string[];
  /** The country staff picked for the whole sheet, or null. */
  defaultCountryCode: string | null;
}

const MESSAGES = {
  ROW_NOT_AN_OBJECT: 'This row is not a set of values.',
  NAME_REQUIRED: 'Name is required.',
  NAME_INVALID: 'Name must be text.',
  NAME_TOO_LONG: 'Name must be 120 characters or fewer.',
  ADDRESS_REQUIRED: 'Address is required.',
  ADDRESS_INVALID: 'Address must be text.',
  ADDRESS_TOO_LONG: 'Address must be 255 characters or fewer.',
  // Same limits as manual customer creation (StructuredAddressDto).
  CITY_INVALID: 'City must be text of 100 characters or fewer.',
  STATE_INVALID: 'State must be text of 100 characters or fewer.',
  PINCODE_INVALID:
    'PIN code must be 6 digits and cannot start with 0, such as 560001.',
  ADDRESS_DETAILS_INVALID:
    'Address details must be text of 255 characters or fewer.',
  PHONE_REQUIRED: 'Phone is required.',
  PHONE_INVALID:
    'Phone must be 6 to 15 digits, with an optional country code such as +91.',
  PHONE_NO_DIAL_CODE:
    'Phone has no country code. Add one (such as +91), or pick a country for this sheet.',
  PHONE_UNKNOWN_COUNTRY_CODE: 'Country code is not one we support.',
  PHONE_DUPLICATE_IN_SHEET: 'This phone appears more than once in the sheet.',
  COORDINATES_INCOMPLETE:
    'Fill in both latitude and longitude, or leave both blank.',
  COORDINATES_NOT_A_NUMBER: 'Latitude and longitude must be numbers.',
  COORDINATES_OUT_OF_RANGE:
    'Latitude must be from -90 to 90, and longitude from -180 to 180.',
  // Commit-time outcomes (import-commit.writes.ts).
  PHONE_TAKEN_DURING_IMPORT:
    'This phone was added by someone else while the import ran. Check the sheet and try again.',
  ROW_SAVE_FAILED: 'This row could not be saved. Try again.',
} as const;

export type ReasonCode = keyof typeof MESSAGES;

export const reasonFor = (
  field: ImportRowField,
  code: ReasonCode,
): ImportRowReason => ({ field, code, message: MESSAGES[code] });
