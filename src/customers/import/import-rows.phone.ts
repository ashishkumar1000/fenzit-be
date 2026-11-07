import { ValidateOptions } from './import-rows.types';
import { Parsed, failed, isBlank } from './import-rows.parse';

/** Same rule as CreateCustomerDto.phoneNumber. */
const PHONE_NUMBER_PATTERN = /^\d{6,15}$/;
/** Digits in a typical national number (India, US and UK all use 10). */
const USUAL_NATIONAL_DIGITS = 10;

export interface PhoneValue {
  countryCode: string;
  phoneNumber: string;
  /** True when the row typed its own dial code. */
  ownCode: boolean;
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
    // A trunk "0" after a dial code (+91 09876543210) is never part of the
    // international number, so it is dropped rather than stored.
    const afterCode = digits.slice(code.length);
    const rest = afterCode.startsWith('0') ? afterCode.slice(1) : afterCode;
    if (PHONE_NUMBER_PATTERN.test(rest)) {
      return {
        value: { countryCode: `+${code}`, phoneNumber: rest, ownCode: true },
      };
    }
  }
  return failed('phone', 'PHONE_INVALID');
}

/**
 * A spreadsheet often stores a phone as a number (9876543210). Read it as its
 * digits. Only a whole, positive number is a phone; a fraction, a negative
 * number, or one too large to be exact (1e21 prints as "1e+21") is refused.
 * Note: Excel drops a leading 0 when it stores a phone as a number.
 */
function phoneCellText(raw: unknown): string | null {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) {
    return String(raw);
  }
  return null;
}

export function parsePhone(
  raw: unknown,
  opts: ValidateOptions,
): Parsed<PhoneValue> {
  if (isBlank(raw)) return failed('phone', 'PHONE_REQUIRED');
  const text = phoneCellText(raw);
  if (text === null) return failed('phone', 'PHONE_INVALID');
  // Spaces, dashes, brackets and dots are typing noise. A leading "00" is an
  // international prefix, the same convenience normalizePhone offers.
  const cleaned = text.replace(/[\s\-().]/g, '').replace(/^00/, '+');
  if (cleaned.startsWith('+')) {
    return parseDigitsWithDialCode(cleaned.slice(1), opts.dialCodes);
  }
  if (!/^\d+$/.test(cleaned)) return failed('phone', 'PHONE_INVALID');
  if (opts.defaultCountryCode === null) {
    return failed('phone', 'PHONE_NO_DIAL_CODE');
  }
  // Trunk prefix: a domestic "0" before the number (09876543210). Only one
  // "0" goes. "00" was already read as an international prefix above.
  const national = /^0\d/.test(cleaned) ? cleaned.slice(1) : cleaned;
  if (!PHONE_NUMBER_PATTERN.test(national)) {
    return failed('phone', 'PHONE_INVALID');
  }
  // A longer number that starts with the default dial code (919876543210 with
  // +91) is a full international number typed without its "+". Storing it
  // under the default code doubles the code, so refuse it and ask for the
  // "+" or the national number instead.
  const defaultDigits = opts.defaultCountryCode.slice(1);
  if (
    national.length > USUAL_NATIONAL_DIGITS &&
    national.startsWith(defaultDigits)
  ) {
    return failed('phone', 'PHONE_INVALID');
  }
  return {
    value: {
      countryCode: opts.defaultCountryCode,
      phoneNumber: national,
      ownCode: false,
    },
  };
}
