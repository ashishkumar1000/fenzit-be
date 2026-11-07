import { validateImportRow, validateImportRows } from './import-rows.model';
import { ImportRowDraft } from './import-rows.types';
import { goodRow } from './import-test.harness';

/** QA view of row-level text rules: boundaries, types, blanks, adversarial text. */
const opts = { dialCodes: ['+91', '+1', '+1242'], defaultCountryCode: '+91' };
const check = (row: unknown): ImportRowDraft => validateImportRow(row, 0, opts);
const codes = (d: ImportRowDraft) => d.reasons.map((r) => r.code);

describe('import row text fields (QA)', () => {
  describe('name (1 to 120 characters, trimmed)', () => {
    it('accepts a one character name (lower boundary)', () => {
      const d = check(goodRow({ name: 'A' }));
      expect(d.reasons).toEqual([]);
      expect(d.values.name).toBe('A');
    });

    it('accepts exactly 120 characters (upper boundary)', () => {
      const name = 'n'.repeat(120);
      expect(check(goodRow({ name })).values.name).toBe(name);
    });

    it('refuses 121 characters with NAME_TOO_LONG', () => {
      expect(codes(check(goodRow({ name: 'n'.repeat(121) })))).toEqual([
        'NAME_TOO_LONG',
      ]);
    });

    it('measures the trimmed length, so padding does not push 120 over the limit', () => {
      const name = 'n'.repeat(120);
      expect(check(goodRow({ name: `   ${name}   ` })).values.name).toBe(name);
    });

    it('accepts 120 Devanagari characters (BMP code units)', () => {
      const name = 'क'.repeat(120);
      expect(check(goodRow({ name })).values.name).toBe(name);
    });

    it('treats 120 emoji as 120 characters, not 240 code units (boundary QA)', () => {
      // A person reads "120 characters" as 120 visible characters. Emoji are
      // outside the BMP, so JavaScript .length counts each as two.
      const name = '😀'.repeat(120);
      expect(codes(check(goodRow({ name })))).toEqual([]);
    });

    it('refuses 121 emoji (one character over the limit, counted as characters)', () => {
      expect(codes(check(goodRow({ name: '😀'.repeat(121) })))).toEqual([
        'NAME_TOO_LONG',
      ]);
    });

    it.each([
      ['an empty string', ''],
      ['spaces only', '     '],
      ['tabs and newlines only', '\t\n \r'],
      ['null', null],
      ['a missing key', undefined],
    ])('refuses %s with NAME_REQUIRED', (_label, value) => {
      expect(codes(check(goodRow({ name: value })))).toContain('NAME_REQUIRED');
    });

    it.each([
      ['a number', 123],
      ['a boolean', true],
      ['an array', ['Asha']],
      ['an object', { first: 'Asha' }],
    ])('refuses %s with NAME_INVALID', (_label, value) => {
      expect(codes(check(goodRow({ name: value })))).toContain('NAME_INVALID');
    });

    it('keeps SQL-looking text verbatim as data', () => {
      const name = "Robert'); DROP TABLE customers;--";
      expect(check(goodRow({ name })).values.name).toBe(name);
    });
  });

  describe('address (1 to 255 characters, required)', () => {
    it('accepts exactly 255 characters', () => {
      const address = 'a'.repeat(255);
      expect(check(goodRow({ address })).values.address).toBe(address);
    });

    it('refuses 256 characters with ADDRESS_TOO_LONG', () => {
      expect(codes(check(goodRow({ address: 'a'.repeat(256) })))).toEqual([
        'ADDRESS_TOO_LONG',
      ]);
    });

    it('refuses a blank address (it is what fetch location works from)', () => {
      expect(codes(check(goodRow({ address: '   ' })))).toEqual([
        'ADDRESS_REQUIRED',
      ]);
    });

    it('refuses a number as the address', () => {
      expect(codes(check(goodRow({ address: 12 })))).toEqual([
        'ADDRESS_INVALID',
      ]);
    });

    it('keeps Devanagari and punctuation addresses intact after trimming', () => {
      const address = '  मुंबई, 4/B "Sea" Road #7 ';
      expect(check(goodRow({ address })).values.address).toBe(
        'मुंबई, 4/B "Sea" Road #7',
      );
    });
  });

  describe('city (up to 100 characters, optional)', () => {
    it('accepts exactly 100 characters', () => {
      const city = 'c'.repeat(100);
      expect(check(goodRow({ city })).values.city).toBe(city);
    });

    it('refuses 101 characters with a CITY_INVALID reason', () => {
      expect(codes(check(goodRow({ city: 'c'.repeat(101) })))).toEqual([
        'CITY_INVALID',
      ]);
    });

    it.each([
      ['an empty cell', ''],
      ['spaces only', '    '],
      ['null', null],
      ['a missing key', undefined],
    ])(
      'treats %s as not given: no reason and stored as null',
      (_label, value) => {
        const d = check(goodRow({ city: value }));
        expect(d.reasons).toEqual([]);
        expect(d.values.city).toBeNull();
      },
    );

    it('refuses a number as the city', () => {
      expect(codes(check(goodRow({ city: 560001 })))).toEqual(['CITY_INVALID']);
    });
  });

  describe('state (up to 100 characters, optional, new column)', () => {
    it('accepts exactly 100 characters and 101 is refused', () => {
      expect(check(goodRow({ state: 's'.repeat(100) })).reasons).toEqual([]);
      expect(codes(check(goodRow({ state: 's'.repeat(101) })))).toEqual([
        'STATE_INVALID',
      ]);
    });

    it('stores a Devanagari state name as typed', () => {
      expect(check(goodRow({ state: '  कर्नाटक ' })).values.state).toBe(
        'कर्नाटक',
      );
    });

    it('treats a blank state as not given (null, never an error)', () => {
      const d = check(goodRow({ state: '  ' }));
      expect(d.reasons).toEqual([]);
      expect(d.values.state).toBeNull();
    });
  });

  describe('pincode (6-digit Indian PIN, cannot start with 0)', () => {
    it.each([
      ['100000', 'the lowest valid PIN'],
      ['999999', 'the highest six-digit PIN'],
      ['560001', 'a typical PIN'],
    ])('accepts %s (%s)', (pin) => {
      expect(check(goodRow({ pincode: pin })).values.pincode).toBe(pin);
    });

    it.each([
      ['06000', 'five digits'],
      ['0600011', 'seven digits'],
      ['060001', 'a leading zero'],
      ['000000', 'all zeros'],
      ['56000a', 'a letter'],
      ['560 001', 'an inner space'],
      ['560-01', 'a hyphen'],
    ])('refuses %s (%s) with PINCODE_INVALID', (pin) => {
      expect(codes(check(goodRow({ pincode: pin })))).toEqual([
        'PINCODE_INVALID',
      ]);
    });

    it('accepts a PIN with padding spaces, trimmed before the check', () => {
      expect(check(goodRow({ pincode: '  560001  ' })).values.pincode).toBe(
        '560001',
      );
    });

    it('accepts a numeric PIN cell (Excel drops the text type) as its digits', () => {
      expect(check(goodRow({ pincode: 560001 })).values.pincode).toBe('560001');
    });

    it('refuses a numeric PIN that lost a leading digit (60001)', () => {
      expect(codes(check(goodRow({ pincode: 60001 })))).toEqual([
        'PINCODE_INVALID',
      ]);
    });

    it('refuses a numeric PIN with a fraction (560001.5)', () => {
      expect(codes(check(goodRow({ pincode: 560001.5 })))).toEqual([
        'PINCODE_INVALID',
      ]);
    });

    it('refuses NaN as a PIN instead of storing it', () => {
      expect(codes(check(goodRow({ pincode: Number.NaN })))).toEqual([
        'PINCODE_INVALID',
      ]);
    });

    it('refuses a seven-digit numeric PIN (1000000)', () => {
      expect(codes(check(goodRow({ pincode: 1000000 })))).toEqual([
        'PINCODE_INVALID',
      ]);
    });

    it.each([
      ['an empty cell', ''],
      ['spaces only', '   '],
      ['null', null],
    ])('treats %s as not given', (_label, value) => {
      const d = check(goodRow({ pincode: value }));
      expect(d.reasons).toEqual([]);
      expect(d.values.pincode).toBeNull();
    });
  });

  describe('address_details (up to 255 characters, optional)', () => {
    it('accepts exactly 255 and refuses 256', () => {
      expect(
        check(goodRow({ address_details: 'f'.repeat(255) })).reasons,
      ).toEqual([]);
      expect(
        codes(check(goodRow({ address_details: 'f'.repeat(256) }))),
      ).toEqual(['ADDRESS_DETAILS_INVALID']);
    });

    it('treats a blank cell as not given', () => {
      const d = check(goodRow({ address_details: '' }));
      expect(d.reasons).toEqual([]);
      expect(d.values.addressDetails).toBeNull();
    });
  });

  describe('rows that are not a set of values', () => {
    it.each([
      ['a string', 'Asha,9876543210'],
      ['a number', 42],
      ['null', null],
      ['undefined', undefined],
      ['a boolean', false],
      ['an array of values', ['Asha', '12 MG Road', '9876543210']],
    ])('refuses %s as ROW_NOT_AN_OBJECT and stores nothing', (_label, raw) => {
      const d = check(raw);
      expect(codes(d)).toEqual(['ROW_NOT_AN_OBJECT']);
      expect(d.phoneKey).toBeNull();
      expect(d.flags).toEqual([]);
      expect(Object.values(d.values).every((v) => v === null)).toBe(true);
    });

    it('does not let one bad row affect its neighbours in the same sheet', () => {
      const drafts = validateImportRows(
        [goodRow(), 'junk', goodRow({ phone: '9123456789' })],
        opts,
      );
      expect(drafts.map((d) => d.reasons.length)).toEqual([0, 1, 0]);
      expect(drafts.map((d) => d.rowIndex)).toEqual([0, 1, 2]);
    });

    it('ignores unknown extra cells and never copies them into the values', () => {
      const d = check(
        goodRow({
          role: 'admin',
          tenant_id: 'other-company',
          created_via: 'x',
        }),
      );
      expect(d.reasons).toEqual([]);
      expect(Object.keys(d.values).sort()).toEqual(
        [
          'addressDetails',
          'address',
          'city',
          'countryCode',
          'latitude',
          'longitude',
          'name',
          'phoneNumber',
          'pincode',
          'state',
        ].sort(),
      );
    });
  });
});
