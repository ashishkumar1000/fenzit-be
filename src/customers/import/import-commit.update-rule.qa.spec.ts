import {
  createHarness,
  goodRow,
  staffUser,
  COMPANY_A,
  COMPANY_B,
  Harness,
} from './import-test.harness';

/** QA: the update rule. A phone match changes only what the sheet fills in. */
const STORED = {
  id: 'cust-1',
  tenant_id: COMPANY_A,
  name: 'Old Name',
  country_code: '+91',
  phone_number: '9876543210',
  address: '1 Old St',
  city: 'Pune',
  state: 'Maharashtra',
  pincode: '411001',
  latitude: 18.5,
  longitude: 73.8,
  address_details: 'Flat 1',
  created_via: 'manual',
};
const ALLOWED_UPDATE_COLUMNS = [
  'name',
  'address',
  'city',
  'state',
  'pincode',
  'address_details',
  'latitude',
  'longitude',
];

describe('ImportCommitService update rule (QA)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
    h.db.seed('customers', { ...STORED });
  });

  const commit = (
    rows: unknown[],
    key = `key-${Math.random()}`,
    tenant = COMPANY_A,
  ) =>
    h.commit.commit(
      staffUser(tenant),
      { rows, defaultCountryCode: '+91' },
      key,
    );

  const stored = (id = 'cust-1') =>
    h.db.rows.customers.find((c) => c.id === id) as Record<string, unknown>;

  describe('blank cells never clear a stored value', () => {
    it('keeps city, state, pincode, coordinates and details when the sheet leaves them blank', async () => {
      const out = await commit([
        goodRow({
          name: 'New Name',
          address: '2 New St',
          city: '',
          state: '   ',
          pincode: null,
          latitude: '',
          longitude: '',
          address_details: '',
        }),
      ]);
      expect(out.rows[0].status).toBe('updated');
      expect(stored()).toMatchObject({
        name: 'New Name',
        address: '2 New St',
        city: 'Pune',
        state: 'Maharashtra',
        pincode: '411001',
        latitude: 18.5,
        longitude: 73.8,
        address_details: 'Flat 1',
      });
    });

    it('keeps a stored name when the sheet name is blank, and the row fails rather than clearing it', async () => {
      const out = await commit([goodRow({ name: '   ', address: '2 New St' })]);
      expect(out.rows[0]).toMatchObject({ status: 'failed' });
      expect(out.rows[0].reasons.map((r) => r.code)).toEqual(['NAME_REQUIRED']);
      expect(stored().name).toBe('Old Name');
      expect(stored().address).toBe('1 Old St');
    });
  });

  describe('the sheet overwrites what it fills in', () => {
    it('writes city, state, pincode, details and the pair when all are filled', async () => {
      const out = await commit([
        goodRow({
          name: 'New Name',
          address: '2 New St',
          city: 'Mumbai',
          state: 'Maharashtra ',
          pincode: '400001',
          address_details: 'Flat 9',
          latitude: 19.07,
          longitude: 72.87,
        }),
      ]);
      expect(out.rows[0].status).toBe('updated');
      expect(stored()).toMatchObject({
        city: 'Mumbai',
        state: 'Maharashtra',
        pincode: '400001',
        address_details: 'Flat 9',
        latitude: 19.07,
        longitude: 72.87,
      });
    });

    it('writes a new state value when the sheet fills it, and keeps the old one when it does not', async () => {
      await commit([goodRow({ state: 'Karnataka' })]);
      expect(stored().state).toBe('Karnataka');
      await commit([goodRow({ state: '' })], 'k2');
      expect(stored().state).toBe('Karnataka');
    });

    it('treats 0 and 0 as a real pair and writes it (it is not blank)', async () => {
      await commit([goodRow({ latitude: 0, longitude: 0 })]);
      expect(stored()).toMatchObject({ latitude: 0, longitude: 0 });
    });
  });

  describe('coordinates are written only as a pair', () => {
    it('refuses a sheet with latitude only, so the stored pair is neither half-changed nor cleared', async () => {
      const out = await commit([goodRow({ latitude: 20.1, longitude: '' })]);
      expect(out.rows[0].reasons.map((r) => r.code)).toEqual([
        'COORDINATES_INCOMPLETE',
      ]);
      expect(out.rows[0].status).toBe('failed');
      expect(stored()).toMatchObject({ latitude: 18.5, longitude: 73.8 });
    });

    it('refuses a sheet with an out-of-range longitude and changes neither coordinate', async () => {
      const out = await commit([goodRow({ latitude: 20.1, longitude: 200 })]);
      expect(out.rows[0].status).toBe('failed');
      expect(stored()).toMatchObject({ latitude: 18.5, longitude: 73.8 });
    });
  });

  describe('the phone never changes', () => {
    it('keeps the stored phone and country when the sheet writes the same number differently', async () => {
      const out = await commit([
        goodRow({ phone: '+91 98765-43210', name: 'New Name' }),
      ]);
      expect(out.rows[0]).toMatchObject({
        status: 'updated',
        customerId: 'cust-1',
      });
      expect(stored()).toMatchObject({
        country_code: '+91',
        phone_number: '9876543210',
      });
    });

    it('never puts a phone or country column in the update statement', async () => {
      await commit([goodRow({ name: 'New Name' })]);
      const update = h.db.calls.find(
        (c) => c.table === 'customers' && c.op === 'update',
      );
      expect(
        Object.keys(update?.payload as object).every((k) =>
          ALLOWED_UPDATE_COLUMNS.includes(k),
        ),
      ).toBe(true);
      expect(Object.keys(update?.payload as object)).not.toEqual(
        expect.arrayContaining([
          'phone_number',
          'country_code',
          'tenant_id',
          'id',
          'created_via',
        ]),
      );
    });

    it('keeps created_via as it was: a manual customer stays manual after an import update', async () => {
      await commit([goodRow({ name: 'New Name' })]);
      expect(stored().created_via).toBe('manual');
    });
  });

  describe('the update is scoped to the customer and the company', () => {
    it('filters the update by customer id and tenant_id', async () => {
      await commit([goodRow({ name: 'New Name' })]);
      const update = h.db.calls.find(
        (c) => c.table === 'customers' && c.op === 'update',
      );
      expect(update?.filters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'eq',
            column: 'id',
            value: 'cust-1',
          }),
          expect.objectContaining({
            kind: 'eq',
            column: 'tenant_id',
            value: COMPANY_A,
          }),
        ]),
      );
    });

    it('a same-phone customer in another company is never changed, and the row is created for this company', async () => {
      h.db.seed('customers', {
        id: 'cust-b',
        tenant_id: COMPANY_B,
        name: 'Company B Name',
        country_code: '+91',
        phone_number: '9123456789',
        address: 'B street',
        created_via: 'manual',
      });
      const before = JSON.stringify(
        h.db.rows.customers.filter((c) => c.tenant_id === COMPANY_B),
      );
      const out = await commit([
        goodRow({ phone: '9123456789', name: 'From A' }),
      ]);
      expect(out.rows[0].status).toBe('created');
      expect(
        JSON.stringify(
          h.db.rows.customers.filter((c) => c.tenant_id === COMPANY_B),
        ),
      ).toBe(before);
      expect(
        h.db.rows.customers.filter(
          (c) => c.tenant_id === COMPANY_A && c.name === 'From A',
        ),
      ).toHaveLength(1);
    });

    it('a row that updates a customer in company A leaves every other company A customer alone', async () => {
      h.db.seed('customers', {
        ...STORED,
        id: 'cust-2',
        phone_number: '9000000002',
        name: 'Other A',
        tenant_id: COMPANY_A,
      });
      await commit([goodRow({ name: 'New Name' })]);
      expect(stored('cust-2').name).toBe('Other A');
    });
  });

  describe('an update that fails leaves the stored customer exactly as it was', () => {
    it('a DB error on the update changes nothing about the stored row', async () => {
      const before = { ...stored() };
      h.db.failNext(
        { table: 'customers', op: 'update' },
        { error: { code: '23514' } },
      );
      const out = await commit([goodRow({ name: 'New Name', city: 'Mumbai' })]);
      expect(out.rows[0].status).toBe('failed');
      expect(stored()).toEqual(before);
    });
  });
});
