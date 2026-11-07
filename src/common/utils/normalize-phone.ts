/**
 * Turns a typed phone number into E.164 (a plus sign, country code, number).
 * Spaces, hyphens, brackets and dots are removed first. A blank value becomes
 * undefined, so an empty phone field counts as "no phone".
 *
 * Two conveniences, and no others: "00" as an international prefix becomes "+",
 * and a bare 10-digit number starting 6-9 is read as an Indian mobile (+91).
 * Everything else must already carry its country code and is rejected by the
 * caller's Matches rule if it is not valid E.164.
 */
export function normalizePhone(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const cleaned = value.replace(/[\s\-().]/g, '');
  if (cleaned === '') return undefined;
  if (/^00[1-9]\d{6,14}$/.test(cleaned)) return `+${cleaned.slice(2)}`;
  if (/^[6-9]\d{9}$/.test(cleaned)) return `+91${cleaned}`;
  return cleaned;
}
