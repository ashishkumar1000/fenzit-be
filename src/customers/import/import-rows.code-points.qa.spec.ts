import { validateImportRow } from './import-rows.model';
import { ImportRowDraft } from './import-rows.types';
import { goodRow } from './import-test.harness';

/**
 * QA view of length limits counted in characters (code points), not UTF-16
 * code units. An emoji is one character to a person and to the database, but
 * two units to JavaScript .length.
 */
const opts = { dialCodes: ['+91', '+1', '+1242'], defaultCountryCode: '+91' };
const check = (row: unknown): ImportRowDraft => validateImportRow(row, 0, opts);
const codes = (d: ImportRowDraft) => d.reasons.map((r) => r.code);

describe('import length limits count characters (QA)', () => {
  describe('name (120)', () => {
    it('accepts exactly 120 emoji', () => {
      expect(codes(check(goodRow({ name: '😀'.repeat(120) })))).toEqual([]);
    });

    it('refuses 121 emoji with NAME_TOO_LONG', () => {
      expect(codes(check(goodRow({ name: '😀'.repeat(121) })))).toEqual([
        'NAME_TOO_LONG',
      ]);
    });

    it('refuses 120 emoji plus one letter (121 characters)', () => {
      expect(codes(check(goodRow({ name: '😀'.repeat(120) + 'a' })))).toEqual([
        'NAME_TOO_LONG',
      ]);
    });

    it('accepts 120 emoji padded with spaces, because the trim happens first', () => {
      expect(
        codes(check(goodRow({ name: `  ${'😀'.repeat(120)}  ` }))),
      ).toEqual([]);
    });
  });

  describe('address (255, combining marks)', () => {
    it('accepts 255 code points made of letters and combining marks', () => {
      // 127 pairs of "a" + combining acute is 254 code points, plus "b".
      const address = 'á'.repeat(127) + 'b';
      expect(codes(check(goodRow({ address })))).toEqual([]);
    });

    it('refuses 256 code points made of combining marks with ADDRESS_TOO_LONG', () => {
      // 128 pairs look like 128 letters on screen, but they are 256 code
      // points, and the database counts code points, so the row is refused.
      const address = 'á'.repeat(128);
      expect(codes(check(goodRow({ address })))).toEqual(['ADDRESS_TOO_LONG']);
    });

    it('accepts exactly 255 emoji', () => {
      expect(codes(check(goodRow({ address: '😀'.repeat(255) })))).toEqual([]);
    });
  });

  describe('city (100)', () => {
    it('accepts exactly 100 emoji (200 code units)', () => {
      expect(codes(check(goodRow({ city: '😀'.repeat(100) })))).toEqual([]);
    });

    it('refuses 101 emoji with CITY_INVALID', () => {
      expect(codes(check(goodRow({ city: '😀'.repeat(101) })))).toEqual([
        'CITY_INVALID',
      ]);
    });
  });

  describe('state (100)', () => {
    it('accepts exactly 100 emoji', () => {
      expect(codes(check(goodRow({ state: '😀'.repeat(100) })))).toEqual([]);
    });

    it('refuses 101 emoji with STATE_INVALID', () => {
      expect(codes(check(goodRow({ state: '😀'.repeat(101) })))).toEqual([
        'STATE_INVALID',
      ]);
    });
  });

  describe('address_details (255)', () => {
    it('accepts exactly 255 emoji', () => {
      expect(
        codes(check(goodRow({ address_details: '😀'.repeat(255) }))),
      ).toEqual([]);
    });

    it('refuses 256 emoji with ADDRESS_DETAILS_INVALID', () => {
      expect(
        codes(check(goodRow({ address_details: '😀'.repeat(256) }))),
      ).toEqual(['ADDRESS_DETAILS_INVALID']);
    });
  });
});
