import { validateImportRow } from './import-rows.model';
import { ImportRowDraft } from './import-rows.types';
import { goodRow } from './import-test.harness';

/**
 * QA view of two phone-cell rules: a phone stored as a number (Excel), and the
 * leading trunk zero for a phone with no dial code (09876543210).
 */
const DIAL = ['+91', '+1', '+1242', '+44', '+971'];
const withDefault = { dialCodes: DIAL, defaultCountryCode: '+91' };
const noDefault = { dialCodes: DIAL, defaultCountryCode: null };
const check = (phone: unknown, opts = withDefault): ImportRowDraft =>
  validateImportRow(goodRow({ phone }), 0, opts);
const codes = (d: ImportRowDraft) => d.reasons.map((r) => r.code);

describe('import phone cell as a number, and trunk zero (QA)', () => {
  describe('numeric phone cell (Excel stores it as a number)', () => {
    it('accepts 9876543210 and reads it as its digits', () => {
      const d = check(9876543210);
      expect(d.reasons).toEqual([]);
      expect(d.values.phoneNumber).toBe('9876543210');
      expect(d.values.countryCode).toBe('+91');
    });

    it('accepts the lowest 6-digit number (boundary)', () => {
      expect(check(123456).values.phoneNumber).toBe('123456');
    });

    it('refuses a 5-digit number (one under the limit)', () => {
      expect(codes(check(12345))).toEqual(['PHONE_INVALID']);
    });

    it('accepts a 15-digit number (upper boundary)', () => {
      expect(check(123456789012345).values.phoneNumber).toBe('123456789012345');
    });

    it('refuses a 16-digit number with PHONE_INVALID', () => {
      expect(codes(check(1234567890123456))).toEqual(['PHONE_INVALID']);
    });

    it('refuses a fraction (9.5) with PHONE_INVALID', () => {
      expect(codes(check(9.5))).toEqual(['PHONE_INVALID']);
    });

    it('refuses a negative number (-1) with PHONE_INVALID', () => {
      expect(codes(check(-1))).toEqual(['PHONE_INVALID']);
    });

    it('refuses zero with PHONE_INVALID', () => {
      expect(codes(check(0))).toEqual(['PHONE_INVALID']);
    });

    it('refuses a number too large to be exact (1e21 prints as 1e+21)', () => {
      expect(codes(check(1e21))).toEqual(['PHONE_INVALID']);
    });

    it.each([
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
    ])('refuses %s with PHONE_INVALID', (_label, phone) => {
      expect(codes(check(phone))).toEqual(['PHONE_INVALID']);
    });

    it('refuses a bare numeric phone when no country was picked (PHONE_NO_DIAL_CODE)', () => {
      expect(codes(check(9876543210, noDefault))).toEqual([
        'PHONE_NO_DIAL_CODE',
      ]);
    });
  });

  describe('leading trunk zero, only when there is no dial code', () => {
    it('drops one leading 0: 09876543210 becomes 9876543210', () => {
      const d = check('09876543210');
      expect(d.reasons).toEqual([]);
      expect(d.values.phoneNumber).toBe('9876543210');
      expect(d.values.countryCode).toBe('+91');
    });

    it('accepts typing noise around a trunk zero (09876 543210)', () => {
      expect(check('09876 543210').values.phoneNumber).toBe('9876543210');
    });

    it('accepts 0 plus 6 digits (lower boundary after the strip)', () => {
      expect(check('0123456').values.phoneNumber).toBe('123456');
    });

    it('accepts 0 plus 15 digits (upper boundary after the strip)', () => {
      expect(check('0' + '1'.repeat(15)).values.phoneNumber).toBe(
        '1'.repeat(15),
      );
    });

    it('refuses 0 plus 16 digits: the strip leaves 16, over the limit', () => {
      expect(codes(check('0' + '1'.repeat(16)))).toEqual(['PHONE_INVALID']);
    });

    it('refuses "0" alone with PHONE_INVALID', () => {
      expect(codes(check('0'))).toEqual(['PHONE_INVALID']);
    });

    it('refuses "0" plus 5 digits with PHONE_INVALID (strip leaves 5)', () => {
      expect(codes(check('012345'))).toEqual(['PHONE_INVALID']);
    });

    it('refuses "00" plus digits: it is an international prefix, never a trunk zero', () => {
      // "0098765432" reads as +98 (not in the list here), so it is refused.
      expect(codes(check('0098765432'))).toEqual([
        'PHONE_UNKNOWN_COUNTRY_CODE',
      ]);
    });

    it('does not strip a 0 from "00" even when the rest would be valid for the default country', () => {
      // "00" + "919876543210" is +91 9876543210, read as an international prefix.
      const d = check('00919876543210');
      expect(d.values.countryCode).toBe('+91');
      expect(d.values.phoneNumber).toBe('9876543210');
    });

    it('does not strip a trunk zero when there is no country (PHONE_NO_DIAL_CODE)', () => {
      expect(codes(check('09876543210', noDefault))).toEqual([
        'PHONE_NO_DIAL_CODE',
      ]);
    });

    it('drops the trunk 0 after a dial code: +91 09876543210 is stored as +91 9876543210', () => {
      // A trunk 0 after a dial code is never part of the international number.
      // Decided 2026-11-08: strip it, so the stored number is valid.
      const d = check('+91 09876543210');
      expect(d.reasons).toEqual([]);
      expect(d.values.countryCode).toBe('+91');
      expect(d.values.phoneNumber).toBe('9876543210');
    });
  });
});
