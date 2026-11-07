import { plainToInstance } from 'class-transformer';
import { ValidationError, validateSync } from 'class-validator';
import { StructuredAddressDto } from '../../common/dto/structured-address.dto';
import { ImportStateDto } from './dto/import-state.dto';
import { Parsed, failed, isBlank } from './import-rows.parse';
import { parsePhone } from './import-rows.phone';
import { hasInvalidCoordinates } from '../../common/utils/validate-coordinates';
import { codePointCount } from '../../common/validators/max-code-points';
import {
  CUSTOMER_ADDRESS_MAX,
  CUSTOMER_NAME_MAX,
} from '../../common/constants/customer-field-limits';
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

const NAME_MAX_LENGTH = CUSTOMER_NAME_MAX;
const ADDRESS_MAX_LENGTH = CUSTOMER_ADDRESS_MAX;
const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

function parseName(raw: unknown): Parsed<string> {
  if (isBlank(raw)) return failed('name', 'NAME_REQUIRED');
  if (typeof raw !== 'string') return failed('name', 'NAME_INVALID');
  const value = raw.trim();
  if (codePointCount(value) > NAME_MAX_LENGTH) {
    return failed('name', 'NAME_TOO_LONG');
  }
  return { value };
}

/** Address is required: it is what "fetch location" works from. */
function parseAddress(raw: unknown): Parsed<string> {
  if (isBlank(raw)) return failed('address', 'ADDRESS_REQUIRED');
  if (typeof raw !== 'string') return failed('address', 'ADDRESS_INVALID');
  const value = raw.trim();
  if (codePointCount(value) > ADDRESS_MAX_LENGTH) {
    return failed('address', 'ADDRESS_TOO_LONG');
  }
  return { value };
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
