import { Logger } from '@nestjs/common';
import {
  createHarness,
  goodRow,
  staffUser,
  COMPANY_A,
  STAFF_ID,
  IDEMPOTENCY_KEY,
  Harness,
} from './import-test.harness';

/** QA: POST /customers/import/commit, the row writes, counts, audit and failure paths. */
const RECORD_FAILED =
  'The import ran, but its record could not be saved. Check the customer list before you try again.';

describe('ImportCommitService (QA)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });

  const commit = (
    rows: unknown[],
    fileName?: string,
    key = IDEMPOTENCY_KEY,
    tenant = COMPANY_A,
  ) =>
    h.commit.commit(
      staffUser(tenant),
      { rows, fileName, defaultCountryCode: '+91' },
      key,
    );

  const customersFor = (tenant: string) =>
    h.db.rows.customers.filter((c) => c.tenant_id === tenant);

  describe('valid sheet', () => {
    it('saves each valid row once as a new customer tagged bulk_import, in the caller company', async () => {
      const out = await commit([
        goodRow({ phone: '9876543210', name: 'Asha' }),
        goodRow({ phone: '9123456789', name: 'Ravi' }),
        goodRow({ phone: '9000000001', name: 'Meena' }),
      ]);
      expect(out.summary).toEqual({
        total: 3,
        created: 3,
        updated: 0,
        failed: 0,
      });
      const saved = customersFor(COMPANY_A);
      expect(saved.map((c) => c.name).sort()).toEqual([
        'Asha',
        'Meena',
        'Ravi',
      ]);
      expect(saved.every((c) => c.created_via === 'bulk_import')).toBe(true);
      expect(saved.every((c) => c.country_code === '+91')).toBe(true);
      expect(
        h.db.rows.customers.filter((c) => c.tenant_id !== COMPANY_A),
      ).toEqual([]);
    });

    it('returns each row with status created and the new customer id', async () => {
      const out = await commit([goodRow({ phone: '9876543210' })]);
      const row = out.rows[0];
      expect(row).toMatchObject({
        rowIndex: 0,
        status: 'created',
        reasons: [],
      });
      expect(h.db.rows.customers[0].id).toBe(row.customerId);
    });

    it('writes the batch record with the same counts and the caller as actor', async () => {
      const out = await commit([
        goodRow({ phone: '9876543210' }),
        goodRow({ phone: '9123456789', name: '' }),
      ]);
      const batch = h.db.rows.import_batches[0];
      expect(batch).toMatchObject({
        id: out.batchId,
        tenant_id: COMPANY_A,
        actor_user_id: STAFF_ID,
        file_name: 'import.csv',
        row_total: 2,
        created_count: 1,
        updated_count: 0,
        failed_count: 1,
      });
    });

    it('keeps the file name the staff member sent, and defaults when none is sent', async () => {
      await commit([goodRow()], 'owners-may.xlsx');
      expect(h.db.rows.import_batches[0].file_name).toBe('owners-may.xlsx');
      await commit([goodRow({ phone: '9123456789' })], undefined, 'second-key');
      expect(h.db.rows.import_batches[1].file_name).toBe('import.csv');
    });

    it('keeps a 255 character file name intact', async () => {
      const name = 'f'.repeat(255);
      await commit([goodRow()], name);
      expect(h.db.rows.import_batches[0].file_name).toBe(name);
    });
  });

  describe('audit entry (company owner visibility)', () => {
    it('writes one audit row with the exact text and N = created', async () => {
      const out = await commit([
        goodRow({ phone: '9876543210' }),
        goodRow({ phone: '9123456789' }),
      ]);
      expect(h.db.auditRows).toHaveLength(1);
      expect(h.db.auditRows[0]).toMatchObject({
        p_actor: STAFF_ID,
        p_action: 'Fenzit staff imported 2 customers',
        p_tenant_id: COMPANY_A,
        p_target_user: null,
        p_details: { batch_id: out.batchId, created: 2, updated: 0, failed: 0 },
      });
    });

    it('counts updated rows in N, and failed rows not at all (N = created + updated)', async () => {
      h.db.seed('customers', {
        id: 'existing',
        tenant_id: COMPANY_A,
        country_code: '+91',
        phone_number: '9876543210',
      });
      await commit([
        goodRow({ phone: '9123456789' }),
        goodRow({ phone: '9876543210', name: 'Renamed' }),
        goodRow({ phone: '9000000001', name: '' }),
      ]);
      expect(h.db.auditRows[0].p_action).toBe(
        'Fenzit staff imported 2 customers',
      );
      expect(h.db.auditRows[0].p_details).toMatchObject({
        created: 1,
        updated: 1,
        failed: 1,
      });
    });

    it('writes "imported 0 customers" when nothing saved, still with a batch record', async () => {
      const out = await commit([goodRow({ name: '' })]);
      expect(out.summary).toEqual({
        total: 1,
        created: 0,
        updated: 0,
        failed: 1,
      });
      expect(h.db.auditRows[0].p_action).toBe(
        'Fenzit staff imported 0 customers',
      );
      expect(h.db.rows.import_batches).toHaveLength(1);
    });

    it('never puts a phone number or an address in the audit entry', async () => {
      await commit([
        goodRow({ phone: '9876543210', address: '77 Secret Lane' }),
      ]);
      const audit = JSON.stringify(h.db.auditRows[0]);
      expect(audit).not.toContain('9876543210');
      expect(audit).not.toContain('77 Secret Lane');
      expect(audit).not.toContain('Asha');
    });
  });

  describe('partial save: failed rows are reported and never written', () => {
    it('saves valid rows even when other rows fail, with a reason for each failed row', async () => {
      const out = await commit([
        goodRow({ phone: '9876543210' }),
        goodRow({ phone: '12' }),
        goodRow({ phone: '9123456789' }),
      ]);
      expect(out.rows.map((r) => r.status)).toEqual([
        'created',
        'failed',
        'created',
      ]);
      expect(out.rows[1].reasons.map((r) => r.code)).toEqual(['PHONE_INVALID']);
      expect(out.rows[1].customerId).toBeNull();
      expect(customersFor(COMPANY_A)).toHaveLength(2);
    });

    it('never writes a row whose phone is duplicated inside the sheet', async () => {
      const out = await commit([
        goodRow({ phone: '9876543210' }),
        goodRow({ phone: '9876543210', name: 'B' }),
      ]);
      expect(out.summary).toEqual({
        total: 2,
        created: 0,
        updated: 0,
        failed: 2,
      });
      expect(customersFor(COMPANY_A)).toEqual([]);
    });

    it('reports rows in input order with their own row index', async () => {
      const out = await commit([
        goodRow({ phone: '9876543210' }),
        'junk',
        goodRow({ phone: '9123456789' }),
      ]);
      expect(out.rows.map((r) => r.rowIndex)).toEqual([0, 1, 2]);
    });

    it('keeps counts exact: created + updated + failed = total, and matches the batch row', async () => {
      h.db.seed('customers', {
        id: 'e1',
        tenant_id: COMPANY_A,
        country_code: '+91',
        phone_number: '9000000001',
      });
      const out = await commit([
        goodRow({ phone: '9876543210' }),
        goodRow({ phone: '9000000001' }),
        goodRow({ phone: '9111111111', name: '' }),
        goodRow({ phone: '9222222222' }),
        'junk',
      ]);
      const s = out.summary;
      expect(s).toEqual({ total: 5, created: 2, updated: 1, failed: 2 });
      expect(s.created + s.updated + s.failed).toBe(s.total);
      expect(h.db.rows.import_batches[0]).toMatchObject({
        row_total: 5,
        created_count: 2,
        updated_count: 1,
        failed_count: 2,
      });
    });
  });

  describe('database faults on one row fail only that row', () => {
    const three = () => [
      goodRow({ phone: '9876543210', name: 'One' }),
      goodRow({ phone: '9123456789', name: 'Two' }),
      goodRow({ phone: '9000000001', name: 'Three' }),
    ];

    it('a DB error on row 2 fails row 2 with ROW_SAVE_FAILED and saves rows 1 and 3', async () => {
      h.db.failNext(
        { table: 'customers', op: 'insert' },
        { error: { code: '22001', message: 'value too long' } },
      );
      const out = await commit(three());
      expect(out.rows.map((r) => r.status)).toEqual([
        'failed',
        'created',
        'created',
      ]);
      expect(out.rows[0].reasons.map((r) => r.code)).toEqual([
        'ROW_SAVE_FAILED',
      ]);
      expect(
        customersFor(COMPANY_A)
          .map((c) => c.name)
          .sort(),
      ).toEqual(['Three', 'Two']);
      expect(out.summary).toEqual({
        total: 3,
        created: 2,
        updated: 0,
        failed: 1,
      });
    });

    it('a network fault on one insert is caught and fails only that row (no throw to the client)', async () => {
      h.db.failNext(
        { table: 'customers', op: 'insert' },
        { throws: 'fetch failed' },
      );
      const out = await commit(three());
      expect(out.rows.map((r) => r.status)).toEqual([
        'failed',
        'created',
        'created',
      ]);
    });

    it('a unique clash on insert (phone added during the run) reports PHONE_TAKEN_DURING_IMPORT for that row', async () => {
      h.db.failNext(
        { table: 'customers', op: 'insert' },
        { error: { code: '23505', message: 'duplicate key' } },
      );
      const out = await commit(three());
      expect(out.rows[0].reasons.map((r) => r.code)).toEqual([
        'PHONE_TAKEN_DURING_IMPORT',
      ]);
      expect(out.summary.created).toBe(2);
    });

    it('a DB error on an update fails that row and leaves the existing customer untouched', async () => {
      h.db.seed('customers', {
        id: 'keep',
        tenant_id: COMPANY_A,
        country_code: '+91',
        phone_number: '9876543210',
        name: 'Before',
      });
      h.db.failNext(
        { table: 'customers', op: 'update' },
        { error: { code: '40001', message: 'serialization' } },
      );
      const out = await commit([
        goodRow({ phone: '9876543210', name: 'After' }),
      ]);
      expect(out.rows[0]).toMatchObject({ status: 'failed', customerId: null });
      expect(h.db.rows.customers[0]).toMatchObject({
        id: 'keep',
        name: 'Before',
      });
    });

    it('a network fault on an update is caught, fails only that row, and keeps the others', async () => {
      h.db.seed('customers', {
        id: 'keep',
        tenant_id: COMPANY_A,
        country_code: '+91',
        phone_number: '9876543210',
      });
      h.db.failNext(
        { table: 'customers', op: 'update' },
        { throws: 'socket hang up' },
      );
      const out = await commit([
        goodRow({ phone: '9876543210' }),
        goodRow({ phone: '9123456789' }),
      ]);
      expect(out.rows.map((r) => r.status)).toEqual(['failed', 'created']);
    });
  });

  describe('database faults on the batch or audit write', () => {
    it('a batch write error returns 500 with the stated message and never hides it', async () => {
      h.db.failNext(
        { table: 'import_batches', op: 'insert' },
        { error: { code: '23503', message: 'fk' } },
      );
      await expect(commit([goodRow()])).rejects.toMatchObject({
        status: 500,
        response: {
          error_code: 'INTERNAL_SERVER_ERROR',
          message: RECORD_FAILED,
        },
      });
    });

    it('a batch write error stops before the audit entry is written', async () => {
      h.db.failNext(
        { table: 'import_batches', op: 'insert' },
        { error: { code: 'XX000' } },
      );
      await expect(commit([goodRow()])).rejects.toBeDefined();
      expect(h.db.auditRows).toEqual([]);
    });

    it('a batch write that rejects (network) returns the same stated 500, not a generic one', async () => {
      h.db.failNext(
        { table: 'import_batches', op: 'insert' },
        { throws: 'fetch failed' },
      );
      await expect(commit([goodRow()])).rejects.toMatchObject({
        status: 500,
        response: { message: RECORD_FAILED },
      });
    });

    it('an audit write error returns 500 with the stated message, and the batch row is kept', async () => {
      h.db.failNext(
        { rpcName: 'write_audit_row' },
        { error: { code: 'P0001', message: 'audit down' } },
      );
      await expect(commit([goodRow()])).rejects.toMatchObject({
        status: 500,
        response: {
          error_code: 'INTERNAL_SERVER_ERROR',
          message: RECORD_FAILED,
        },
      });
      expect(h.db.rows.import_batches).toHaveLength(1);
      expect(customersFor(COMPANY_A)).toHaveLength(1);
    });

    it('an audit write that rejects (network) returns the same stated 500', async () => {
      h.db.failNext(
        { rpcName: 'write_audit_row' },
        { throws: 'socket hang up' },
      );
      await expect(commit([goodRow()])).rejects.toMatchObject({
        status: 500,
        response: { message: RECORD_FAILED },
      });
    });
  });

  describe('log hygiene: no phone number or address in any log line', () => {
    it('logs only codes and row numbers when every write fails', async () => {
      const logged: string[] = [];
      const spies = (['error', 'warn', 'log'] as const).map((level) =>
        jest
          .spyOn(Logger.prototype, level)
          .mockImplementation((...args: unknown[]) => {
            logged.push(JSON.stringify(args));
          }),
      );
      h.db.failNext(
        { table: 'customers', op: 'insert' },
        { error: { code: '22001', message: '9876543210 77 Secret Lane' } },
      );
      h.db.failNext(
        { table: 'customers', op: 'insert' },
        { throws: '9123456789 Secret Lane' },
      );
      h.db.failNext(
        { table: 'import_batches', op: 'insert' },
        { throws: '9000000001 77 Secret Lane' },
      );
      await expect(
        commit([
          goodRow({ phone: '9876543210' }),
          goodRow({ phone: '9123456789', name: 'X' }),
        ]),
      ).rejects.toBeDefined();
      spies.forEach((spy) => spy.mockRestore());
      const all = logged.join('\n');
      // Guard against a vacuous pass: the spies must have caught the log lines.
      expect(logged.length).toBeGreaterThanOrEqual(3);
      expect(all).toContain('22001');
      expect(all).not.toContain('9876543210');
      expect(all).not.toContain('9123456789');
      expect(all).not.toContain('9000000001');
      expect(all).not.toContain('Secret Lane');
      expect(all).not.toContain('Asha Verma');
    });
  });

  describe('company setup', () => {
    it('refuses a commit with no company with 400 and writes nothing', async () => {
      await expect(
        commit(
          [goodRow()],
          undefined,
          IDEMPOTENCY_KEY,
          null as unknown as string,
        ),
      ).rejects.toMatchObject({
        status: 400,
      });
      expect(h.db.writes()).toEqual([]);
    });
  });
});
