import { plainToInstance } from 'class-transformer';
import { ValidationError, validateSync } from 'class-validator';
import { StructuredAddressDto } from '../../common/dto/structured-address.dto';
import { ImportStateDto } from './dto/import-state.dto';
import { hasInvalidCoordinates } from '../../common/utils/validate-coordinates';
import {
  ImportRowDraft,
  ImportRowFlag,
  ImportRowField,
  ImportRowReason,
  ImportRowValues,
  ReasonCode,
  ValidateOptions,
  reasonFor,
} from './import-rows.types';

const NAME_MAX_LENGTH = 120;
const ADDRESS_MAX_LENGTH = 255;
/** Same rule as CreateCustomerDto.phoneNumber. */
const PHONE_NUMBER_PATTERN = /^\d{6,15}$/;
const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

interface Parsed<T> {
  value: T | null;
  reason?: ImportRowReason;
}

const failed = <T>(field: ImportRowField, code: ReasonCode): Parsed<T> => ({
  value: null,
  reason: reasonFor(field, code),
});

interface PhoneValue {
  countryCode: string;
  phoneNumber: string;
  /** True when the row typed its own dial code. */
  ownCode: boolean;
}

/** Blank = missing, null, or whitespace only. */
function isBlank(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.trim() === '')
  );
}

/**
 * Counts characters as a person reads them: an emoji is one character, but
 * JavaScript .length counts it as two code units. The database limit counts
 * characters too, so the check must match it.
 */
const characterCount = (text: string): number => [...text].length;

function parseName(raw: unknown): Parsed<string> {
  if (isBlank(raw)) return failed('name', 'NAME_REQUIRED');
  if (typeof raw !== 'string') return failed('name', 'NAME_INVALID');
  const value = raw.trim();
  if (characterCount(value) > NAME_MAX_LENGTH) {
    return failed('name', 'NAME_TOO_LONG');
  }
  return { value };
}

/** Address is required: it is what "fetch location" works from. */
function parseAddress(raw: unknown): Parsed<string> {
  if (isBlank(raw)) return failed('address', 'ADDRESS_REQUIRED');
  if (typeof raw !== 'string') return failed('address', 'ADDRESS_INVALID');
  const value = raw.trim();
  if (characterCount(value) > ADDRESS_MAX_LENGTH) {
    return failed('address', 'ADDRESS_TOO_LONG');
  }
  return { value };
}

/**
 * Splits a phone cell into dial code and number. The longest dial code that
 * leaves a 6-15 digit number wins (so +1242 beats +1 when both fit).
 */
function parseDigitsWithDialCode(
  digits: string,
  dialCodes: readonly string[],
): Parsed<PhoneValue> {
  if (!/^\d+$/.test(digits)) return failed('phone', 'PHONE_INVALID');
  const candidates = dialCodes
    .map((code) => code.slice(1))
    .filter((code) => /^\d{1,4}$/.test(code) && digits.startsWith(code))
    .sort((a, b) => b.length - a.length);
  if (candidates.length === 0) {
    return failed('phone', 'PHONE_UNKNOWN_COUNTRY_CODE');
  }
  for (const code of candidates) {
    const rest = digits.slice(code.length);
    if (PHONE_NUMBER_PATTERN.test(rest)) {
      return {
        value: { countryCode: `+${code}`, phoneNumber: rest, ownCode: true },
      };
    }
  }
  return failed('phone', 'PHONE_INVALID');
}

function parsePhone(raw: unknown, opts: ValidateOptions): Parsed<PhoneValue> {
  if (isBlank(raw)) return failed('phone', 'PHONE_REQUIRED');
  if (typeof raw !== 'string') return failed('phone', 'PHONE_INVALID');
  // Spaces, dashes, brackets and dots are typing noise. A leading "00" is an
  // international prefix, the same convenience normalizePhone offers.
  const cleaned = raw.replace(/[\s\-().]/g, '').replace(/^00/, '+');
  if (cleaned.startsWith('+')) {
    return parseDigitsWithDialCode(cleaned.slice(1), opts.dialCodes);
  }
  if (!/^\d+$/.test(cleaned)) return failed('phone', 'PHONE_INVALID');
  if (opts.defaultCountryCode === null) {
    return failed('phone', 'PHONE_NO_DIAL_CODE');
  }
  if (!PHONE_NUMBER_PATTERN.test(cleaned)) {
    return failed('phone', 'PHONE_INVALID');
  }
  return {
    value: {
      countryCode: opts.defaultCountryCode,
      phoneNumber: cleaned,
      ownCode: false,
    },
  };
}

const EXTRA_FIELD_CODES: Record<
  string,
  { field: ImportRowField; code: ReasonCode }
> = {
  city: { field: 'city', code: 'CITY_INVALID' },
  state: { field: 'state', code: 'STATE_INVALID' },
  pincode: { field: 'pincode', code: 'PINCODE_INVALID' },
  addressDetails: { field: 'address_details', code: 'ADDRESS_DETAILS_INVALID' },
};

interface StructuredExtras {
  city: string | null;
  state: string | null;
  pincode: string | null;
  addressDetails: string | null;
  reasons: ImportRowReason[];
}

/**
 * City, PIN code and address details are checked by the SAME decorators
 * manual customer creation uses (StructuredAddressDto), so the limits cannot
 * drift between the two entry points. Blank cells are "not given" (the DTO's
 * IsOptional skips undefined only). An Excel PIN stored as a number
 * (560001) is read as its digits, since spreadsheets often drop the text type.
 */
function parseStructuredExtras(row: Record<string, unknown>): StructuredExtras {
  const pick = (raw: unknown): unknown => (isBlank(raw) ? undefined : raw);
  const rawPincode = row.pincode;
  const pincodeAsText =
    typeof rawPincode === 'number' && Number.isInteger(rawPincode)
      ? String(rawPincode)
      : rawPincode;
  const structured = plainToInstance(StructuredAddressDto, {
    city: pick(row.city),
    pincode: pick(pincodeAsText),
    addressDetails: pick(row.address_details),
  });
  const stateOnly = plainToInstance(ImportStateDto, { state: pick(row.state) });
  const errors: ValidationError[] = [
    ...validateSync(structured),
    ...validateSync(stateOnly),
  ];
  const instance: Record<string, unknown> = { ...structured, ...stateOnly };
  const failedFields = new Set(errors.map((error) => error.property));
  const reasons = [...failedFields].flatMap((property) => {
    const mapped = EXTRA_FIELD_CODES[property];
    return mapped ? [reasonFor(mapped.field, mapped.code)] : [];
  });
  const valueOf = (property: keyof StructuredExtras & string) =>
    failedFields.has(property)
      ? null
      : ((instance[property] as string | undefined) ?? null);
  return {
    city: valueOf('city'),
    state: valueOf('state'),
    pincode: valueOf('pincode'),
    addressDetails: valueOf('addressDetails'),
    reasons,
  };
}

function toNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string' && DECIMAL_PATTERN.test(raw.trim())) {
    return Number(raw.trim());
  }
  return null;
}

/** Both or neither; numeric; in range. Blank pair means no map pin. */
function parseCoordinates(
  rawLatitude: unknown,
  rawLongitude: unknown,
): {
  latitude: number | null;
  longitude: number | null;
  reason?: ImportRowReason;
} {
  const latitudeBlank = isBlank(rawLatitude);
  const longitudeBlank = isBlank(rawLongitude);
  if (latitudeBlank && longitudeBlank) {
    return { latitude: null, longitude: null };
  }
  const fail = (code: ReasonCode) => ({
    latitude: null,
    longitude: null,
    reason: reasonFor('coordinates', code),
  });
  if (latitudeBlank || longitudeBlank) return fail('COORDINATES_INCOMPLETE');
  const latitude = toNumber(rawLatitude);
  const longitude = toNumber(rawLongitude);
  if (latitude === null || longitude === null) {
    return fail('COORDINATES_NOT_A_NUMBER');
  }
  if (hasInvalidCoordinates(latitude, longitude)) {
    return fail('COORDINATES_OUT_OF_RANGE');
  }
  return { latitude, longitude };
}

/** Checks one row on its own. Sheet-wide checks run in finaliseImportRows. */
export function validateImportRow(
  raw: unknown,
  rowIndex: number,
  opts: ValidateOptions,
): ImportRowDraft {
  const empty: ImportRowValues = {
    name: null,
    address: null,
    countryCode: null,
    phoneNumber: null,
    latitude: null,
    longitude: null,
    city: null,
    state: null,
    pincode: null,
    addressDetails: null,
  };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      rowIndex,
      values: empty,
      phoneKey: null,
      reasons: [reasonFor('row', 'ROW_NOT_AN_OBJECT')],
      flags: [],
    };
  }
  const row = raw as Record<string, unknown>;
  const name = parseName(row.name);
  const address = parseAddress(row.address);
  const phone = parsePhone(row.phone, opts);
  const coords = parseCoordinates(row.latitude, row.longitude);
  const extras = parseStructuredExtras(row);

  const reasons = [
    name.reason,
    address.reason,
    phone.reason,
    coords.reason,
    ...extras.reasons,
  ];
  const values: ImportRowValues = {
    name: name.value,
    address: address.value,
    countryCode: phone.value?.countryCode ?? null,
    phoneNumber: phone.value?.phoneNumber ?? null,
    latitude: coords.latitude,
    longitude: coords.longitude,
    city: extras.city,
    state: extras.state,
    pincode: extras.pincode,
    addressDetails: extras.addressDetails,
  };

  const flags: ImportRowFlag[] = [];
  if (values.latitude === null) {
    flags.push('no_map_pin');
  }
  if (
    phone.value?.ownCode &&
    opts.defaultCountryCode !== null &&
    phone.value.countryCode !== opts.defaultCountryCode
  ) {
    flags.push('country_code_differs');
  }

  return {
    rowIndex,
    values,
    phoneKey: phone.value
      ? `${phone.value.countryCode}|${phone.value.phoneNumber}`
      : null,
    reasons: reasons.filter((r): r is ImportRowReason => r !== undefined),
    flags,
  };
}

export function validateImportRows(
  rows: unknown[],
  opts: ValidateOptions,
): ImportRowDraft[] {
  return rows.map((raw, index) => validateImportRow(raw, index, opts));
}
