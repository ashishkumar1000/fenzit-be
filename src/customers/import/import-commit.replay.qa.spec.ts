import { Logger } from '@nestjs/common';
import {
  createHarness,
  goodRow,
  staffUser,
  COMPANY_A,
  COMPANY_B,
  IDEMPOTENCY_KEY,
  Harness,
} from './import-test.harness';
import { hashImportRequest } from './import-commit.replay';

/** QA: the X-Idempotency-Key replay rule on commit (same key never inserts twice). */
const HOUR = 60 * 60 * 1000;
const SCOPE = 'POST:/customers/import/commit';

describe('ImportCommitService replay and idempotency (QA)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });

  const commit = (rows: unknown[], key = IDEMPOTENCY_KEY, tenant = COMPANY_A) =>
    h.commit.commit(
      staffUser(tenant),
      { rows, defaultCountryCode: '+91' },
      key,
    );

  const sheet = () => [
    goodRow({ phone: '9876543210' }),
    goodRow({ phone: '9123456789', name: 'Ravi' }),
  ];

  describe('same key twice', () => {
    it('returns the first answer unchanged and writes nothing the second time', async () => {
      const first = await commit(sheet());
      const writesAfterFirst = h.db.writes().length;
      const second = await commit(sheet());
      expect(second).toEqual(first);
      expect(h.db.writes()).toHaveLength(writesAfterFirst);
      expect(h.db.rows.customers).toHaveLength(2);
      expect(h.db.rows.import_batches).toHaveLength(1);
      expect(h.db.auditRows).toHaveLength(1);
    });

    it('does not even read the sheet against the database on a replay', async () => {
      await commit(sheet());
      const before = h.db.calls.length;
      await commit(sheet());
      const later = h.db.calls.slice(before);
      expect(later.map((c) => c.table)).toEqual(['idempotency_log']);
    });

    it('replays a first answer that contained failed rows exactly, with the same reasons', async () => {
      const bad = [goodRow({ phone: '12' })];
      const first = await commit(bad);
      const second = await commit(bad);
      expect(second).toEqual(first);
      expect(h.db.rows.customers).toEqual([]);
    });

    it('refuses the same key with a different sheet (422) and writes nothing', async () => {
      await commit([goodRow({ phone: '12' })]);
      await expect(
        commit([goodRow({ phone: '9876543210' })]),
      ).rejects.toMatchObject({
        status: 422,
        response: { error_code: 'IDEMPOTENCY_KEY_REUSED' },
      });
      expect(h.db.rows.customers).toEqual([]);
      expect(h.db.rows.import_batches).toHaveLength(1);
    });
  });

  describe('replay window (24 hours)', () => {
    const seedReplay = (ageMs: number, tenant = COMPANY_A) =>
      h.db.seed('idempotency_log', {
        key: IDEMPOTENCY_KEY,
        tenant_id: tenant,
        scope: SCOPE,
        response_body: {
          requestHash: hashImportRequest({
            rows: sheet(),
            defaultCountryCode: '+91',
          }),
          response: {
            batchId: 'old-batch',
            rows: [],
            summary: { total: 0, created: 0, updated: 0, failed: 0 },
          },
        },
        created_at: new Date(Date.now() - ageMs).toISOString(),
      });

    it('replays a stored answer that is 23 hours old', async () => {
      seedReplay(23 * HOUR);
      await expect(commit(sheet())).resolves.toMatchObject({
        batchId: 'old-batch',
      });
      expect(h.db.rows.customers).toEqual([]);
    });

    it('runs the import again once the stored answer is more than 24 hours old', async () => {
      seedReplay(24 * HOUR + 1000);
      const out = await commit(sheet());
      expect(out.batchId).not.toBe('old-batch');
      expect(h.db.rows.customers).toHaveLength(2);
    });
  });

  describe('tenant isolation of the key', () => {
    it('a stored answer for company A is never replayed to company B', async () => {
      await commit(sheet(), IDEMPOTENCY_KEY, COMPANY_A);
      const b = await commit(sheet(), IDEMPOTENCY_KEY, COMPANY_B);
      expect(b.rows.map((r) => r.status)).toEqual(['created', 'created']);
      expect(
        h.db.rows.customers.filter((c) => c.tenant_id === COMPANY_B),
      ).toHaveLength(2);
      expect(
        h.db.rows.customers.filter((c) => c.tenant_id === COMPANY_A),
      ).toHaveLength(2);
    });

    it('the replay read is filtered by the caller company and the commit scope', async () => {
      await commit(sheet());
      const read = h.db.calls.find(
        (c) => c.table === 'idempotency_log' && c.op === 'select',
      );
      expect(read?.filters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ column: 'tenant_id', value: COMPANY_A }),
          expect.objectContaining({ column: 'scope', value: SCOPE }),
          expect.objectContaining({ column: 'key', value: IDEMPOTENCY_KEY }),
        ]),
      );
    });

    it('a key stored under a different scope does not replay this commit', async () => {
      h.db.seed('idempotency_log', {
        key: IDEMPOTENCY_KEY,
        tenant_id: COMPANY_A,
        scope: 'POST:/customers',
        response_body: { batchId: 'other-route' },
        created_at: new Date().toISOString(),
      });
      await expect(commit(sheet())).resolves.not.toMatchObject({
        batchId: 'other-route',
      });
    });
  });

  describe('a different key for the same sheet (retry after a lost response)', () => {
    it('updates the rows already saved instead of inserting them again', async () => {
      await commit(sheet(), 'first-try');
      const second = await commit(sheet(), 'second-try');
      expect(second.summary).toEqual({
        total: 2,
        created: 0,
        updated: 2,
        failed: 0,
      });
      expect(h.db.rows.customers).toHaveLength(2);
    });

    it('records a second batch and a second audit entry for the retry (the run is recorded)', async () => {
      await commit(sheet(), 'first-try');
      await commit(sheet(), 'second-try');
      expect(h.db.rows.import_batches).toHaveLength(2);
      expect(h.db.auditRows.map((a) => a.p_action)).toEqual([
        'Fenzit staff imported 2 customers',
        'Fenzit staff imported 2 customers',
      ]);
    });
  });

  describe('replay read failure', () => {
    it('returns 500 with the stated message and writes nothing when the read fails', async () => {
      h.db.failNext(
        { table: 'idempotency_log', op: 'select' },
        { error: { code: '57014', message: 'timeout' } },
      );
      await expect(commit(sheet())).rejects.toMatchObject({
        status: 500,
        response: {
          error_code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to check for an earlier import with this request ID',
        },
      });
      expect(h.db.writes()).toEqual([]);
    });

    it('returns the same stated 500 when the replay read rejects (network), never runs the import', async () => {
      h.db.failNext(
        { table: 'idempotency_log', op: 'select' },
        { throws: 'fetch failed' },
      );
      await expect(commit(sheet())).rejects.toMatchObject({
        status: 500,
        response: {
          message: 'Failed to check for an earlier import with this request ID',
        },
      });
      expect(h.db.writes()).toEqual([]);
    });
  });

  describe('replay store failure (the run already happened)', () => {
    it('still returns the answer to the caller when storing the replay record fails with an error result', async () => {
      const spy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      h.db.failNext(
        { table: 'idempotency_log', op: 'update' },
        { error: { code: 'XX000', message: 'disk' } },
      );
      const out = await commit(sheet());
      spy.mockRestore();
      expect(out.summary).toEqual({
        total: 2,
        created: 2,
        updated: 0,
        failed: 0,
      });
      expect(h.db.rows.customers).toHaveLength(2);
    });

    it('still returns the answer when storing the replay record rejects (network); the run is not hidden', async () => {
      const spy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      h.db.failNext(
        { table: 'idempotency_log', op: 'update' },
        { throws: 'socket hang up' },
      );
      const out = await commit(sheet());
      spy.mockRestore();
      expect(out.summary).toEqual({
        total: 2,
        created: 2,
        updated: 0,
        failed: 0,
      });
    });
  });

  describe('what is stored for replay', () => {
    it('stores the answer under the key, the company and the scope', async () => {
      const out = await commit(sheet());
      expect(h.db.rows.idempotency_log).toEqual([
        expect.objectContaining({
          key: IDEMPOTENCY_KEY,
          tenant_id: COMPANY_A,
          scope: SCOPE,
        }),
      ]);
      expect(h.db.rows.idempotency_log[0].response_body).toEqual({
        requestHash: expect.any(String),
        claimToken: expect.any(String),
        response: out,
      });
    });

    it('stores no phone number or address in the replay record', async () => {
      await commit([
        goodRow({ phone: '9876543210', address: '77 Secret Lane' }),
      ]);
      const stored = JSON.stringify(h.db.rows.idempotency_log);
      expect(stored).not.toContain('9876543210');
      expect(stored).not.toContain('77 Secret Lane');
    });
  });

  describe('two requests at the same time with the same key', () => {
    it('runs the import once: one request answers, the other is refused as in progress (409)', async () => {
      const results = await Promise.allSettled([
        commit(sheet()),
        commit(sheet()),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const refused = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({
        status: 409,
        response: { error_code: 'IMPORT_IN_PROGRESS' },
      });
      expect(h.db.rows.customers).toHaveLength(2);
      expect(h.db.rows.import_batches).toHaveLength(1);
      expect(h.db.auditRows).toHaveLength(1);
    });
  });
});
