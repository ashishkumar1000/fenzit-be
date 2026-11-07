import { Logger } from '@nestjs/common';
import {
  createHarness,
  goodRow,
  COMPANY_A,
  COMPANY_B,
  staffUser,
  Harness,
} from './import-test.harness';

/** QA: POST /customers/import/validate at the service level, on the fake DB. */
describe('ImportValidateService (QA)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });

  const validate = (
    rows: unknown[],
    defaultCountryCode?: string,
    tenant = COMPANY_A,
  ) => h.validate.validate(staffUser(tenant), { rows, defaultCountryCode });

  const lookups = () =>
    h.db.calls.filter((c) => c.op === 'select' && c.table === 'customers');

  describe('company scope and setup', () => {
    it('refuses a request with no company (no X-Company-Id) with 400 and touches nothing', async () => {
      await expect(
        validate([goodRow()], '+91', null as unknown as string),
      ).rejects.toMatchObject({
        status: 400,
        response: { error_code: 'VALIDATION_ERROR' },
      });
      expect(h.countryCodesList).not.toHaveBeenCalled();
      expect(h.db.calls).toEqual([]);
    });

    it('refuses an unsupported defaultCountryCode with 422 and no DB reads', async () => {
      await expect(validate([goodRow()], '+999')).rejects.toMatchObject({
        status: 422,
      });
      expect(h.db.calls).toEqual([]);
    });

    it('accepts a supported defaultCountryCode', async () => {
      await expect(validate([goodRow()], '+91')).resolves.toMatchObject({
        summary: { total: 1, valid: 1 },
      });
    });

    it('treats an absent defaultCountryCode as no country: a bare phone is PHONE_NO_DIAL_CODE', async () => {
      const out = await validate([goodRow()]);
      expect(out.rows[0].reasons.map((r) => r.code)).toEqual([
        'PHONE_NO_DIAL_CODE',
      ]);
    });
  });

  describe('read only: validate never writes', () => {
    it('makes no insert, update, delete or rpc call for a sheet with valid and invalid rows', async () => {
      await validate(
        [goodRow(), goodRow({ phone: '' }), goodRow({ name: '' })],
        '+91',
      );
      expect(h.db.writes()).toEqual([]);
      expect(h.db.rows.customers).toEqual([]);
      expect(h.db.auditRows).toEqual([]);
    });
  });

  describe('existing customers in this company (update match)', () => {
    it('flags a row whose phone matches a customer in this company, with that customer id', async () => {
      h.db.seed('customers', {
        id: 'cust-a1',
        tenant_id: COMPANY_A,
        country_code: '+91',
        phone_number: '9876543210',
      });
      const out = await validate([goodRow()], '+91');
      expect(out.rows[0].existingCustomerId).toBe('cust-a1');
      expect(out.rows[0].flags).toContain('updates_existing');
      expect(out.rows[0].status).toBe('valid');
      expect(out.summary.willUpdateExisting).toBe(1);
    });

    it('does not match a customer in another company with the same phone (tenant isolation)', async () => {
      h.db.seed('customers', {
        id: 'cust-b1',
        tenant_id: COMPANY_B,
        country_code: '+91',
        phone_number: '9876543210',
      });
      const out = await validate([goodRow()], '+91', COMPANY_A);
      expect(out.rows[0].existingCustomerId).toBeNull();
      expect(out.rows[0].flags).not.toContain('updates_existing');
      expect(out.summary.willUpdateExisting).toBe(0);
    });

    it('does not match a customer with the same digits under a different dial code', async () => {
      h.db.seed('customers', {
        id: 'cust-us',
        tenant_id: COMPANY_A,
        country_code: '+1',
        phone_number: '9876543210',
      });
      const out = await validate([goodRow()], '+91');
      expect(out.rows[0].existingCustomerId).toBeNull();
    });

    it('scopes the existing-customer lookup by tenant_id in the query itself', async () => {
      await validate([goodRow()], '+91', COMPANY_A);
      const lookup = lookups()[0];
      expect(lookup.filters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'eq',
            column: 'tenant_id',
            value: COMPANY_A,
          }),
        ]),
      );
    });

    it('never looks up the phone of a row that failed its own checks', async () => {
      await validate(
        [goodRow({ phone: '12' }), goodRow({ phone: '9123456789' })],
        '+91',
      );
      const looked = lookups().flatMap((c) =>
        c.filters
          .filter((f) => f.column === 'phone_number')
          .flatMap((f) => f.value as string[]),
      );
      expect(looked).toEqual(['9123456789']);
    });
  });

  describe('lookup chunking (100 phones per query)', () => {
    const phones = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        goodRow({ phone: `9${String(100000000 + i)}` }),
      );

    it('uses one query for exactly 100 distinct phones', async () => {
      await validate(phones(100), '+91');
      expect(lookups()).toHaveLength(1);
    });

    it('uses two queries for 101 distinct phones (100 then 1)', async () => {
      await validate(phones(101), '+91');
      const sizes = lookups().map(
        (c) =>
          (c.filters.find((f) => f.kind === 'in')?.value as string[]).length,
      );
      expect(sizes).toEqual([100, 1]);
    });

    it('finds an existing customer whose phone sits in the third chunk (index 250 of 251)', async () => {
      const rows = phones(251);
      const target = rows[250].phone as string;
      h.db.seed('customers', {
        id: 'late-match',
        tenant_id: COMPANY_A,
        country_code: '+91',
        phone_number: target,
      });
      const out = await validate(rows, '+91');
      expect(lookups()).toHaveLength(3);
      expect(out.rows[250].existingCustomerId).toBe('late-match');
      expect(out.summary.willUpdateExisting).toBe(1);
    });

    it('queries each distinct phone once even when it repeats in the sheet', async () => {
      const out = await validate(
        [
          goodRow(),
          goodRow({ name: 'Other' }),
          goodRow({ phone: '9123456789' }),
        ],
        '+91',
      );
      const looked = lookups().flatMap(
        (c) => c.filters.find((f) => f.kind === 'in')?.value as string[],
      );
      expect(looked.sort()).toEqual(['9123456789', '9876543210']);
      expect(out.rows.map((r) => r.status)).toEqual([
        'invalid',
        'invalid',
        'valid',
      ]);
    });
  });

  describe('lookup failure', () => {
    it('returns 500 with the stated message when the lookup fails', async () => {
      h.db.failNext(
        { table: 'customers', op: 'select' },
        { error: { code: '57014', message: 'timeout' } },
      );
      await expect(validate([goodRow()], '+91')).rejects.toMatchObject({
        status: 500,
        response: {
          error_code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to check existing customers',
        },
      });
    });

    it('returns 500 when the lookup rejects like a network fault', async () => {
      h.db.failNext(
        { table: 'customers', op: 'select' },
        { throws: 'socket hang up' },
      );
      await expect(validate([goodRow()], '+91')).rejects.toMatchObject({
        status: 500,
      });
    });

    it('logs the error code only, never the phone number or address', async () => {
      const logged: string[] = [];
      const spy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation((...args: unknown[]) => {
          logged.push(JSON.stringify(args));
        });
      h.db.failNext(
        { table: 'customers', op: 'select' },
        { error: { code: '57014', message: '9876543210 12 MG Road' } },
      );
      await expect(validate([goodRow()], '+91')).rejects.toBeDefined();
      spy.mockRestore();
      expect(logged.length).toBeGreaterThan(0);
      expect(logged.join(' ')).toContain('57014');
      expect(logged.join(' ')).not.toContain('9876543210');
      expect(logged.join(' ')).not.toContain('12 MG Road');
    });
  });

  describe('per-row output', () => {
    it('returns rows in input order with 0-based row indexes', async () => {
      const out = await validate(
        [goodRow({ name: 'A' }), 'junk', goodRow({ name: 'C' })],
        '+91',
      );
      expect(out.rows.map((r) => r.rowIndex)).toEqual([0, 1, 2]);
      expect(out.rows[2].normalised.name).toBe('C');
    });

    it('keeps the summary counts consistent: total = valid + invalid', async () => {
      const out = await validate(
        [
          goodRow(),
          goodRow({ phone: '' }),
          goodRow({ phone: '9123456789', latitude: '', longitude: '' }),
          42,
        ],
        '+91',
      );
      expect(out.summary).toEqual({
        total: 4,
        valid: 2,
        invalid: 2,
        willUpdateExisting: 0,
        noMapPin: 1,
      });
      expect(out.summary.valid + out.summary.invalid).toBe(out.summary.total);
    });

    it('counts a row with no map pin in noMapPin even though it is valid', async () => {
      const out = await validate(
        [goodRow({ latitude: undefined, longitude: undefined })],
        '+91',
      );
      expect(out.summary.noMapPin).toBe(1);
      expect(out.rows[0].status).toBe('valid');
    });
  });
});
