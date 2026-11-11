import { Role, MembershipRole } from '../../common/enums/role.enum';
import { transliterateDevanagari } from './devanagari-to-latin';

/**
 * Pure text rules for the invite SMS (spec-invite-sms-download-link CAP-1,
 * CAP-4, CAP-5 and CAP-6). The SMS text is built here, in the backend only.
 */

/** Approved copy as registered with DLT. MSG91 renders the real text from the panel; this is kept for reference and the length check. */
export const INVITE_SMS_APPROVED_COPY =
  'Hi {name}, you are added to {company} as {role}. Get the app at fenzit.com/app/download and log in with this number. - Fenzit Technology';

const FIRST_NAME_MAX = 12;
const COMPANY_NAME_MAX = 20;
const FALLBACK_NAME = 'there';
const COMPANY_FALLBACK = 'your company';

/**
 * First word of the name, in English letters, cut to 12 characters. Empty
 * names, names with non-English letters after conversion, and names with
 * emoji or other symbols all become "there" (CAP-4). This keeps the SMS in
 * plain English characters, so it stays one part.
 */
export function fitFirstName(name: string): string {
  const firstWord = name.trim().split(/\s+/)[0] ?? '';
  if (firstWord === '') return FALLBACK_NAME;

  const latin = transliterateDevanagari(firstWord);
  // Only printable ASCII is allowed. Any other character would switch the SMS to 70-character parts.
  if (/[^\x21-\x7E]/.test(latin)) return FALLBACK_NAME;

  const fitted = latin.slice(0, FIRST_NAME_MAX);
  // A converted name is capitalised (रवि → Ravi). A typed Latin name keeps its own case.
  if (fitted !== firstWord) {
    return fitted.charAt(0).toUpperCase() + fitted.slice(1);
  }
  return fitted;
}

/**
 * Company name for the SMS only (CAP-5, decision 2026-11-11). Devanagari is
 * converted with the same table as person names. Any other non-English
 * character, emoji included, makes the name "your company". Otherwise the
 * name is trimmed and cut to 20 characters. The stored name is never changed.
 */
export function fitCompanyName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') return COMPANY_FALLBACK;

  const latin = transliterateDevanagari(trimmed);
  // Printable ASCII only, space included. Anything else would switch the SMS to 70-character parts.
  if (/[^\x20-\x7E]/.test(latin)) return COMPANY_FALLBACK;

  // The name is ASCII at this point, so slicing by character is exact.
  const fitted = latin.slice(0, COMPANY_NAME_MAX).trimEnd();
  // When any part was converted, every word starts with a capital, as person
  // names do (रवि → Ravi). A name with no converted part is left as typed.
  if (latin !== trimmed) {
    return fitted
      .split(' ')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }
  return fitted;
}

export type RoleWord = 'Employee' | 'Admin' | 'Viewer';

/** The role word the SMS shows. Any other role is a programming error (validation rejects it earlier). */
export function roleWord(role: MembershipRole): RoleWord {
  switch (role) {
    case Role.EMPLOYEE:
      return 'Employee';
    case Role.COMPANY_ADMIN:
      return 'Admin';
    case Role.VIEWER:
      return 'Viewer';
    default:
      throw new Error(`No invite SMS role word for role ${String(role)}`);
  }
}

/**
 * Masked phone for the audit row and logs: country code, a space, stars,
 * then the last 4 digits. Example: +91 ******3210. The full number is never
 * returned.
 */
export function maskPhone(countryCode: string, phoneNumber: string): string {
  const lastFour = phoneNumber.slice(-4);
  const stars = '*'.repeat(Math.max(0, phoneNumber.length - 4));
  return `${countryCode} ${stars}${lastFour}`;
}

/**
 * The one spelling of a subscriber number used for the cap hash, the send and
 * the audit mask. Keeps digits only, drops leading zeros (trunk prefix), and for
 * +91 drops a repeated country code ("919876543210" → "9876543210"). If that
 * would leave fewer than 6 digits, the typed digits are kept, so validation's
 * minimum still holds and the mask never sees a short number.
 */
export function canonicalSubscriberNumber(countryCode: string, phoneNumber: string): string {
  const typed = phoneNumber.replace(/\D/g, '');
  let digits = typed.replace(/^0+/, '');
  if (countryCode === '+91' && digits.length === 12 && digits.startsWith('91')) {
    digits = digits.slice(2);
  }
  return digits.length >= 6 ? digits : typed;
}
