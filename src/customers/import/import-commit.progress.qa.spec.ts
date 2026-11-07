import { Logger } from '@nestjs/common';
import * as writes from './import-commit.writes';
import {
  createHarness,
  goodRow,
  staffUser,
  COMPANY_A,
  IDEMPOTENCY_KEY,
  Harness,
} from './import-test.harness';

/**
 * QA: the batch row exists before the first customer write and is refreshed
 * while rows are written, so a run that dies mid-way is visible. A crash is
 * injected by spying on writeImportRow (the real one never throws).
 */

const RECORD_FAILED =
  'The import ran, but its record could not be saved. Check the customer list before you try again.';
const MIN = 60 * 1000;
const realWriteImportRow = writes.writeImportRow;

/** Valid 10-digit mobile numbers, unique per index. */
const rowsOf = (n: number): Record<string, unknown>[] =>
  Array.from({ length: n }, (_, i) =>
    goodRow({ phone: `9${String(100000000 + i)}` }),
  );

interface Counts {
  row_total: number;
  created_count: number;
  updated_count: number;
  failed_count: number;
}

describe('ImportCommitService batch progress (QA)', () => {
  let h: Harness;
  /** The batch row as it stood just before each row write (null = no row yet). */
  let atWrite: (Counts | null)[];

  beforeEach(async () => {
    h = await createHarness();
    atWrite = [];
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const commit = (rows: unknown[], key = IDEMPOTENCY_KEY) =>
    h.commit.commit(
      staffUser(COMPANY_A),
      { rows, defaultCountryCode: '+91' },
      key,
    );
  const batch = (i = 0) =>
    h.db.rows.import_batches[i] as Counts & { id: string };
  const batchUpdates = () =>
    h.db
      .writes()
      .filter((c) => c.table === 'import_batches' && c.op === 'update');
  const seedExisting = (phone: string) =>
    h.db.seed('customers', {
      id: `e-${phone}`,
      tenant_id: COMPANY_A,
      country_code: '+91',
      phone_number: phone,
    });

  /** Wraps the real row writer and records the batch row before each call. */
  const recordBatchBeforeEachRow = () =>
    jest
      .spyOn(writes, 'writeImportRow')
      .mockImplementation(async (admin, tenantId, row) => {
        const b = h.db.rows.import_batches[0] as Counts | undefined;
        atWrite.push(
          b && {
            row_total: b.row_total,
            created_count: b.created_count,
            updated_count: b.updated_count,
            failed_count: b.failed_count,
          },
        );
        return realWriteImportRow(admin, tenantId, row);
      });

  /** The third valid row's write throws, as a process dying would. */
  const dieOnThirdRow = () => {
    let calls = 0;
    jest.spyOn(writes, 'writeImportRow').mockImplementation(async (...args) => {
      calls += 1;
      if (calls === 3) throw new Error('process died');
      return realWriteImportRow(...args);
    });
  };

  describe('order and starting state', () => {
    it('the batch row is inserted before the first customer write, with every row counted as failed', async () => {
      await commit(rowsOf(4));
      const batchInsert = h.db.calls.findIndex(
        (c) => c.table === 'import_batches' && c.op === 'insert',
      );
      const firstCustomerWrite = h.db.calls.findIndex(
        (c) => c.table === 'customers' && c.op !== 'select',
      );
      expect(batchInsert).toBeGreaterThanOrEqual(0);
      expect(firstCustomerWrite).toBeGreaterThan(batchInsert);
      expect(h.db.calls[batchInsert].payload).toMatchObject({
        row_total: 4,
        created_count: 0,
        updated_count: 0,
        failed_count: 4,
      });
    });
  });

  describe('counts while the run is going', () => {
    it('the counts sum to the row total at every point the batch row can be seen', async () => {
      seedExisting('9000000001');
      recordBatchBeforeEachRow();
      const sheet = [
        ...rowsOf(30),
        goodRow({ phone: '9000000001' }), // updates an existing customer
        goodRow({ phone: '9111111111', name: '' }), // invalid: failed, no write
        'junk', // invalid: failed, no write
      ];
      const out = await commit(sheet);

      // Only the 31 valid rows reach the writer.
      expect(atWrite).toHaveLength(31);
      expect(atWrite.every((s) => s !== null)).toBe(true);
      for (const s of atWrite as Counts[]) {
        expect(s.created_count + s.updated_count + s.failed_count).toBe(
          s.row_total,
        );
        expect(s.row_total).toBe(sheet.length);
      }
      for (const c of batchUpdates()) {
        const p = c.payload as Counts;
        expect(p.created_count + p.updated_count + p.failed_count).toBe(
          sheet.length,
        );
      }
      expect(out.summary.total).toBe(sheet.length);
    });

    it('refreshes the batch counts at rows 25 and 50 of a 60-row run, and at the end', async () => {
      recordBatchBeforeEachRow();
      await commit(rowsOf(60));

      expect(atWrite[25]).toEqual({
        row_total: 60,
        created_count: 25,
        updated_count: 0,
        failed_count: 35,
      });
      expect(atWrite[50]).toEqual({
        row_total: 60,
        created_count: 50,
        updated_count: 0,
        failed_count: 10,
      });
      expect(batchUpdates()).toHaveLength(3);
      expect(batch()).toMatchObject({
        row_total: 60,
        created_count: 60,
        updated_count: 0,
        failed_count: 0,
      });
    });

    it.each([
      [24, 1],
      [25, 1], // no mid-run refresh at the last row
      [50, 2], // row-25 refresh + final, none at row 50
    ])('%i rows: %i refresh write(s)', async (n, refreshes) => {
      await commit(rowsOf(n));
      expect(batchUpdates()).toHaveLength(refreshes);
      expect(batch()).toMatchObject({ created_count: n, failed_count: 0 });
    });

    it('the final batch counts equal the returned summary and point at the returned batch id', async () => {
      seedExisting('9000000001');
      const out = await commit([
        goodRow({ phone: '9876543210' }),
        goodRow({ phone: '9000000001' }),
        goodRow({ phone: '9111111111', name: '' }),
      ]);
      expect(out.summary).toEqual({
        total: 3,
        created: 1,
        updated: 1,
        failed: 1,
      });
      expect(batch()).toMatchObject({
        id: out.batchId,
        row_total: 3,
        created_count: 1,
        updated_count: 1,
        failed_count: 1,
      });
    });
  });

  describe('a run that dies mid-loop', () => {
    it('leaves a batch row with its counts, no audit entry, and no completed answer on the claim', async () => {
      dieOnThirdRow();
      await expect(commit(rowsOf(5))).rejects.toThrow('process died');

      expect(h.db.rows.customers).toHaveLength(2);
      expect(h.db.rows.import_batches).toHaveLength(1);
      const b = batch();
      expect(b.row_total).toBe(5);
      expect(b.created_count + b.updated_count + b.failed_count).toBe(5);
      expect(h.db.auditRows).toEqual([]);
      const claim = h.db.rows.idempotency_log[0].response_body as {
        response?: unknown;
      };
      expect(claim.response).toBeUndefined();
    });

    it('a retry within 10 minutes is refused as in progress and writes nothing new', async () => {
      dieOnThirdRow();
      await expect(commit(rowsOf(5))).rejects.toThrow('process died');
      jest.restoreAllMocks();

      await expect(commit(rowsOf(5))).rejects.toMatchObject({
        status: 409,
        response: { error_code: 'IMPORT_IN_PROGRESS' },
      });
      expect(h.db.rows.import_batches).toHaveLength(1);
      expect(h.db.rows.customers).toHaveLength(2);
    });

    it('after the claim goes stale, a new run gets its own batch row and reports the saved rows as updated', async () => {
      dieOnThirdRow();
      await expect(commit(rowsOf(3))).rejects.toThrow('process died');
      const crashedBatchId = batch().id;
      jest.restoreAllMocks();
      h.db.rows.idempotency_log[0].created_at = new Date(
        Date.now() - 11 * MIN,
      ).toISOString();

      const out = await commit(rowsOf(3));

      expect(out.summary).toEqual({
        total: 3,
        created: 1,
        updated: 2,
        failed: 0,
      });
      expect(h.db.rows.import_batches).toHaveLength(2);
      // The crashed run's row is kept as it was left: partial, not rewritten.
      expect(batch(0)).toMatchObject({
        id: crashedBatchId,
        created_count: 0,
        updated_count: 0,
        failed_count: 3,
      });
      expect(batch(1).id).not.toBe(crashedBatchId);
      expect(out.batchId).toBe(batch(1).id);
      expect(h.db.auditRows).toHaveLength(1);
    });
  });

  describe('failures of the batch row', () => {
    it.each([
      ['an error result', { error: { code: 'XX000', message: 'boom' } }],
      ['a network fault', { throws: 'fetch failed' }],
    ])(
      'a batch insert failure (%s) returns the stated 500 and writes no customer or audit row',
      async (_label, outcome) => {
        h.db.failNext({ table: 'import_batches', op: 'insert' }, outcome);
        await expect(commit(rowsOf(3))).rejects.toMatchObject({
          status: 500,
          response: { message: RECORD_FAILED },
        });
        expect(h.db.writes().filter((c) => c.table === 'customers')).toEqual(
          [],
        );
        expect(h.db.rows.customers).toEqual([]);
        expect(h.db.auditRows).toEqual([]);
      },
    );

    it('a batch insert failure releases the claim, so the same key can run again', async () => {
      h.db.failNext(
        { table: 'import_batches', op: 'insert' },
        { error: { code: 'XX000' } },
      );
      await expect(commit(rowsOf(2))).rejects.toMatchObject({ status: 500 });
      const retry = await commit(rowsOf(2));
      expect(retry.summary).toEqual({
        total: 2,
        created: 2,
        updated: 0,
        failed: 0,
      });
      // The failed insert left no row, so the retry's is the only one.
      expect(h.db.rows.import_batches).toHaveLength(1);
    });

    it('a failed mid-run refresh is logged, and the final refresh still makes the batch row exact', async () => {
      h.db.failNext(
        { table: 'import_batches', op: 'update' },
        { error: { code: 'XX000', message: 'blip' } },
      );
      const out = await commit(rowsOf(30));
      expect(out.summary).toEqual({
        total: 30,
        created: 30,
        updated: 0,
        failed: 0,
      });
      expect(batch()).toMatchObject({ created_count: 30, failed_count: 0 });
      expect(h.db.auditRows).toHaveLength(1);
    });

    it('a failed final refresh does not fail the run: the rows are saved, the audit entry is written, and the answer is stored for replay', async () => {
      h.db.failNext(
        { table: 'import_batches', op: 'update' },
        { error: { code: 'XX000' } },
      );
      const first = await commit(rowsOf(3));
      expect(first.rows.map((r) => r.status)).toEqual([
        'created',
        'created',
        'created',
      ]);
      expect(h.db.rows.customers).toHaveLength(3);
      expect(h.db.auditRows).toHaveLength(1);
      // The run completed, so the same key replays its answer and writes nothing.
      const writesBefore = h.db.writes().length;
      await expect(commit(rowsOf(3))).resolves.toMatchObject({
        batchId: first.batchId,
      });
      expect(h.db.writes()).toHaveLength(writesBefore);
    });
  });
});
