import {
  createHarness,
  goodRow,
  staffUser,
  COMPANY_A,
  IDEMPOTENCY_KEY,
  Harness,
} from './import-test.harness';
import { hashImportRequest } from './import-commit.replay';

/** QA: the claim lifecycle on X-Idempotency-Key (claim before writes, release, takeover). */
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const SCOPE = 'POST:/customers/import/commit';

describe('ImportCommitService claim lifecycle (QA)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });

  const sheet = () => [goodRow({ phone: '9876543210' })];
  const dto = (rows = sheet()) => ({ rows, defaultCountryCode: '+91' });
  const commit = (rows = sheet()) =>
    h.commit.commit(staffUser(COMPANY_A), dto(rows), IDEMPOTENCY_KEY);
  const seedClaim = (ageMs: number, body: Record<string, unknown>) =>
    h.db.seed('idempotency_log', {
      key: IDEMPOTENCY_KEY,
      tenant_id: COMPANY_A,
      scope: SCOPE,
      response_body: body,
      created_at: new Date(Date.now() - ageMs).toISOString(),
    });
  const pending = (requestHash = hashImportRequest(dto())) => ({ requestHash });

  describe('a run is still going', () => {
    it('a same-sheet request within 10 minutes is refused as in progress, and writes nothing', async () => {
      seedClaim(2 * MIN, pending());
      await expect(commit()).rejects.toMatchObject({
        status: 409,
        response: { error_code: 'IMPORT_IN_PROGRESS' },
      });
      expect(h.db.rows.customers).toEqual([]);
      expect(h.db.rows.import_batches).toEqual([]);
    });

    it('a different sheet during a run is refused as key reused (422), not as in progress', async () => {
      seedClaim(2 * MIN, pending());
      await expect(
        commit([goodRow({ phone: '9123456789' })]),
      ).rejects.toMatchObject({
        status: 422,
        response: { error_code: 'IDEMPOTENCY_KEY_REUSED' },
      });
    });
  });

  describe('an abandoned run (over 10 minutes old, never finished)', () => {
    it('is taken over and the import runs again', async () => {
      seedClaim(11 * MIN, pending());
      const out = await commit();
      expect(out.summary).toEqual({
        total: 1,
        created: 1,
        updated: 0,
        failed: 0,
      });
      expect(h.db.rows.customers).toHaveLength(1);
    });

    it('is not taken over at exactly 9 minutes', async () => {
      seedClaim(9 * MIN, pending());
      await expect(commit()).rejects.toMatchObject({ status: 409 });
    });
  });

  describe('a finished answer older than 24 hours', () => {
    it('is expired, so the same key runs the import again', async () => {
      seedClaim(25 * HOUR, {
        requestHash: hashImportRequest(dto()),
        response: {
          batchId: 'old',
          rows: [],
          summary: { total: 0, created: 0, updated: 0, failed: 0 },
        },
      });
      const out = await commit();
      expect(out.batchId).not.toBe('old');
      expect(h.db.rows.customers).toHaveLength(1);
    });
  });

  describe('a failure before any row is written', () => {
    it('releases the claim, so a retry with the same key can run', async () => {
      const spy = jest
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      h.db.failNext(
        { table: 'customers', op: 'select' },
        { error: { code: 'XX000', message: 'boom' } },
      );
      await expect(commit()).rejects.toMatchObject({ status: 500 });
      spy.mockRestore();
      expect(h.db.rows.customers).toEqual([]);

      const retry = await commit();
      expect(retry.summary.created).toBe(1);
      expect(h.db.rows.customers).toHaveLength(1);
    });
  });

  describe('the claim itself cannot be written', () => {
    it('returns the stated 500 and writes no customer, batch or audit row', async () => {
      const spy = jest
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      h.db.failNext(
        { table: 'idempotency_log', op: 'insert' },
        { error: { code: 'XX000', message: 'disk' } },
      );
      await expect(commit()).rejects.toMatchObject({ status: 500 });
      spy.mockRestore();
      expect(h.db.rows.customers).toEqual([]);
      expect(h.db.rows.import_batches).toEqual([]);
      expect(h.db.auditRows).toEqual([]);
    });
  });
});
