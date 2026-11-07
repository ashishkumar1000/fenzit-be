import { validateImportRow, validateImportRows } from './import-rows.model';
import { finaliseImportRows } from './import-rows.finalise';
import { ImportRowDraft } from './import-rows.types';
import { goodRow } from './import-test.harness';

/** QA view of phone and coordinate rules, plus in-sheet duplicate phones. */
const DIAL = ['+91', '+1', '+1242', '+44', '+971'];
const withDefault = { dialCodes: DIAL, defaultCountryCode: '+91' };
const noDefault = { dialCodes: DIAL, defaultCountryCode: null };
const check = (row: unknown, opts = withDefault): ImportRowDraft =>
  validateImportRow(row, 0, opts);
const codes = (d: ImportRowDraft) => d.reasons.map((r) => r.code);

describe('import phone and coordinates (QA)', () => {
  describe('phone length (6 to 15 digits of the national number)', () => {
    it.each([
      ['123456', 6],
      ['123456789012345', 15],
    ])(
      'accepts a %s-digit number under the sheet default (%i digits)',
      (phone) => {
        const d = check(goodRow({ phone }));
        expect(d.reasons).toEqual([]);
        expect(d.values.phoneNumber).toBe(phone);
        expect(d.values.countryCode).toBe('+91');
      },
    );

    it('refuses 16 digits (one over the limit)', () => {
      expect(codes(check(goodRow({ phone: '1234567890123456' })))).toEqual([
        'PHONE_INVALID',
      ]);
    });

    it('refuses 5 digits (one under the limit)', () => {
      expect(codes(check(goodRow({ phone: '12345' })))).toEqual([
        'PHONE_INVALID',
      ]);
    });

    it('counts only the national number after a typed dial code (+91 plus 6 digits is valid)', () => {
      const d = check(goodRow({ phone: '+91123456' }));
      expect(d.reasons).toEqual([]);
      expect(d.values.phoneNumber).toBe('123456');
    });

    it('refuses +91 plus 5 digits', () => {
      expect(codes(check(goodRow({ phone: '+9112345' })))).toEqual([
        'PHONE_INVALID',
      ]);
    });

    it('refuses +91 plus 16 digits', () => {
      expect(codes(check(goodRow({ phone: '+91' + '1'.repeat(16) })))).toEqual([
        'PHONE_INVALID',
      ]);
    });

    it('accepts typing noise: spaces, dashes, brackets and dots', () => {
      for (const phone of [
        '+91 98765 43210',
        '(98765) 43210',
        '98765-43210',
        '98765.43210',
      ]) {
        const d = check(goodRow({ phone }));
        expect(d.reasons).toEqual([]);
        expect(d.values.phoneNumber).toBe('9876543210');
      }
    });

    it.each([
      ['an empty cell', ''],
      ['spaces only', '   '],
      ['null', null],
      ['a missing key', undefined],
    ])('refuses %s with PHONE_REQUIRED', (_label, phone) => {
      expect(codes(check(goodRow({ phone })))).toEqual(['PHONE_REQUIRED']);
    });

    it.each([
      ['letters', '98765abcde'],
      ['Devanagari digits', '९८७६५४३२१०'],
      ['an emoji', '9876543210😀'],
      ['an SQL-looking string', "'; DROP TABLE customers;--"],
      ['an extension', '9876543210 ext 5'],
      ['a double plus', '++919876543210'],
    ])('refuses %s with PHONE_INVALID', (_label, phone) => {
      expect(codes(check(goodRow({ phone })))).toEqual(['PHONE_INVALID']);
    });

    it('refuses a 10,000-digit string quickly and without a crash', () => {
      const started = Date.now();
      const d = check(goodRow({ phone: '9'.repeat(10000) }));
      expect(codes(d)).toEqual(['PHONE_INVALID']);
      expect(Date.now() - started).toBeLessThan(500);
    });
  });

  describe('phone without a dial code', () => {
    it('refuses a bare number when no country was picked for the sheet', () => {
      expect(codes(check(goodRow({ phone: '9876543210' }), noDefault))).toEqual(
        ['PHONE_NO_DIAL_CODE'],
      );
    });

    it('accepts a number that carries its own dial code when no country was picked', () => {
      const d = check(goodRow({ phone: '+919876543210' }), noDefault);
      expect(d.reasons).toEqual([]);
      expect(d.values.countryCode).toBe('+91');
    });

    it('applies the picked country when the row has no dial code', () => {
      const d = check(goodRow({ phone: '2025550123' }), {
        dialCodes: DIAL,
        defaultCountryCode: '+1',
      });
      expect(d.values.countryCode).toBe('+1');
      expect(d.flags).not.toContain('country_code_differs');
    });

    it('flags a row whose own dial code differs from the picked country but keeps it valid', () => {
      const d = check(goodRow({ phone: '+12025550123' }));
      expect(d.reasons).toEqual([]);
      expect(d.values.countryCode).toBe('+1');
      expect(d.flags).toContain('country_code_differs');
    });

    it('does not flag a row whose own dial code matches the picked country', () => {
      expect(check(goodRow({ phone: '+919876543210' })).flags).not.toContain(
        'country_code_differs',
      );
    });

    it('reads 00 as an international prefix', () => {
      const d = check(goodRow({ phone: '00919876543210' }));
      expect(d.values.countryCode).toBe('+91');
      expect(d.values.phoneNumber).toBe('9876543210');
    });

    it('refuses a dial code that is not in the supported list', () => {
      expect(codes(check(goodRow({ phone: '+999123456' })))).toEqual([
        'PHONE_UNKNOWN_COUNTRY_CODE',
      ]);
    });

    it('refuses a plus sign with no digits', () => {
      expect(codes(check(goodRow({ phone: '+' })))).toEqual(['PHONE_INVALID']);
    });

    it('splits on the longest dial code that leaves a valid number (+1242 beats +1)', () => {
      const d = check(goodRow({ phone: '+1242 555 1234' }));
      expect(d.values.countryCode).toBe('+1242');
      expect(d.values.phoneNumber).toBe('5551234');
    });
  });

  describe('phone duplicates inside one sheet (both occurrences invalid)', () => {
    const sheet = (...phones: unknown[]) =>
      finaliseImportRows(
        validateImportRows(
          phones.map((phone) => goodRow({ phone })),
          withDefault,
        ),
        new Map(),
      );

    it('marks both occurrences invalid with PHONE_DUPLICATE_IN_SHEET', () => {
      const out = sheet('9876543210', '9123456789', '9876543210');
      expect(out.rows[0].status).toBe('invalid');
      expect(out.rows[2].status).toBe('invalid');
      expect(out.rows[0].reasons.map((r) => r.code)).toEqual([
        'PHONE_DUPLICATE_IN_SHEET',
      ]);
      expect(out.rows[1].status).toBe('valid');
    });

    it('treats the same number written with and without the dial code as a duplicate', () => {
      const out = sheet('9876543210', '+91 98765 43210');
      expect(out.rows.map((r) => r.status)).toEqual(['invalid', 'invalid']);
    });

    it('does not treat the same digits under a different country code as a duplicate', () => {
      const out = sheet('+12025550123', '+919876543210', '+12025550123');
      expect(out.rows[1].status).toBe('valid');
      expect(out.rows[0].status).toBe('invalid');
      expect(out.rows[2].status).toBe('invalid');
    });

    it('flags all three occurrences of a phone that appears three times', () => {
      const out = sheet('9876543210', '9876543210', '9876543210');
      expect(out.rows.every((r) => r.status === 'invalid')).toBe(true);
      expect(out.summary.invalid).toBe(3);
    });

    it('still invalidates a row that is also invalid for another reason, and never hides the duplicate', () => {
      const bad = goodRow({ phone: '9876543210', name: '' });
      const good = goodRow({ phone: '9876543210' });
      const out = finaliseImportRows(
        validateImportRows([bad, good], withDefault),
        new Map(),
      );
      expect(out.rows[0].reasons.map((r) => r.code).sort()).toEqual(
        ['NAME_REQUIRED', 'PHONE_DUPLICATE_IN_SHEET'].sort(),
      );
      expect(out.rows[1].status).toBe('invalid');
    });

    it('does not mark a blank phone as a duplicate of another blank phone', () => {
      const out = sheet('', '');
      expect(out.rows.map((r) => r.reasons.map((x) => x.code))).toEqual([
        ['PHONE_REQUIRED'],
        ['PHONE_REQUIRED'],
      ]);
    });
  });

  describe('coordinates (both or neither, numeric, in range)', () => {
    it('accepts exact boundaries: lat 90 and -90, lng 180 and -180', () => {
      expect(check(goodRow({ latitude: 90, longitude: 180 })).reasons).toEqual(
        [],
      );
      expect(
        check(goodRow({ latitude: -90, longitude: -180 })).reasons,
      ).toEqual([]);
    });

    it('refuses lat 90.000001 and -90.1', () => {
      expect(
        codes(check(goodRow({ latitude: 90.000001, longitude: 0 }))),
      ).toEqual(['COORDINATES_OUT_OF_RANGE']);
      expect(codes(check(goodRow({ latitude: -90.1, longitude: 0 })))).toEqual([
        'COORDINATES_OUT_OF_RANGE',
      ]);
    });

    it('refuses lng 180.1 and -180.5', () => {
      expect(codes(check(goodRow({ latitude: 0, longitude: 180.1 })))).toEqual([
        'COORDINATES_OUT_OF_RANGE',
      ]);
      expect(codes(check(goodRow({ latitude: 0, longitude: -180.5 })))).toEqual(
        ['COORDINATES_OUT_OF_RANGE'],
      );
    });

    it('accepts boundary values written as text cells', () => {
      const d = check(goodRow({ latitude: '90', longitude: '-180' }));
      expect(d.reasons).toEqual([]);
      expect(d.values.latitude).toBe(90);
      expect(d.values.longitude).toBe(-180);
    });

    it('treats 0 and 0.0 as real coordinates, not as blank: a pin is written', () => {
      const d = check(goodRow({ latitude: 0, longitude: '0.0' }));
      expect(d.reasons).toEqual([]);
      expect(d.values.latitude).toBe(0);
      expect(d.values.longitude).toBe(0);
      expect(d.flags).not.toContain('no_map_pin');
    });

    it.each([
      ['both blank', '', ''],
      ['both spaces', '   ', '  '],
      ['both null', null, null],
      ['both missing', undefined, undefined],
    ])(
      'saves the row with no map pin when the pair is %s',
      (_label, latitude, longitude) => {
        const d = check(goodRow({ latitude, longitude }));
        expect(d.reasons).toEqual([]);
        expect(d.values.latitude).toBeNull();
        expect(d.values.longitude).toBeNull();
        expect(d.flags).toContain('no_map_pin');
      },
    );

    it.each([
      ['latitude only', 12.9, undefined],
      ['longitude only', undefined, 77.6],
      ['latitude with a blank longitude cell', 12.9, ''],
      ['a blank latitude cell with longitude', '', 77.6],
    ])(
      'refuses %s with COORDINATES_INCOMPLETE and stores neither',
      (_label, latitude, longitude) => {
        const d = check(goodRow({ latitude, longitude }));
        expect(codes(d)).toEqual(['COORDINATES_INCOMPLETE']);
        expect(d.values.latitude).toBeNull();
        expect(d.values.longitude).toBeNull();
      },
    );

    it.each([
      ['a word', 'abc', '77.6'],
      ['scientific notation', '1e1', '77.6'],
      ['Infinity as text', 'Infinity', '77.6'],
      ['NaN as a number', Number.NaN, 77.6],
      ['Infinity as a number', Number.POSITIVE_INFINITY, 77.6],
      ['a boolean', true, 77.6],
      ['a trailing dot', '12.', '77.6'],
    ])(
      'refuses %s with COORDINATES_NOT_A_NUMBER',
      (_label, latitude, longitude) => {
        expect(codes(check(goodRow({ latitude, longitude })))).toEqual([
          'COORDINATES_NOT_A_NUMBER',
        ]);
      },
    );

    it('never stores a half pair, even when only the longitude is bad', () => {
      const d = check(goodRow({ latitude: 12.9, longitude: 200 }));
      expect(codes(d)).toEqual(['COORDINATES_OUT_OF_RANGE']);
      expect(d.values.latitude).toBeNull();
      expect(d.values.longitude).toBeNull();
    });
  });
});
