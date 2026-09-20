import type { SupabaseClient } from '@supabase/supabase-js';
import { ReportRequestStatus } from '../enums/report-status.enum';
import { ReportRequestRow } from '../report-response.model';
import {
  claimQueuedReport,
  markReportFailed,
  recoverExpiredReport,
  reportR2Key,
  stampReportReady,
} from './report-claims';

/**
 * The guarded-UPDATE chains of report-claims (story 12-3). Every helper
 * starts `.update(payload)` and is awaited directly (the claims add
 * `.select('*')`, the terminal stamps don't) — so the tail must be
 * thenable resolving `result`, matching reports.service.spec.ts's
 * updateChain pattern.
 */
function updateQb(result: { data: unknown; error: unknown }) {
  const qb: Record<string, jest.Mock> & { then: jest.Mock } = {} as never;
  for (const m of ['update', 'eq', 'lt', 'select']) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.then = jest.fn((resolve: (v: unknown) => unknown) => resolve(result));
  return qb;
}

const TENANT_ID = 'tenant-uuid';
const REQUEST_ID = '00000000-0000-4000-8000-0000000000b1';

const claimedRow: ReportRequestRow = {
  id: REQUEST_ID,
  tenant_id: TENANT_ID,
  requested_by: 'owner-uuid',
  report_type: 'technician_job_activity',
  params: { start_date: '2026-09-01', end_date: '2026-09-07', technician_ids: [] },
  status: ReportRequestStatus.GENERATING,
  attempt_count: 1,
  locked_until: '2026-09-20T10:05:00.000Z',
  r2_key: null,
  file_size_bytes: null,
  error_code: null,
  created_at: '2026-09-20T10:00:00.000Z',
  completed_at: null,
};

function adminReturning(qb: ReturnType<typeof updateQb>): SupabaseClient {
  return {
    from: jest.fn((table: string) => {
      if (table !== 'report_requests') {
        throw new Error(`unexpected table ${table}`);
      }
      return qb;
    }),
  } as unknown as SupabaseClient;
}

describe('report-claims (story 12-3)', () => {
  describe('reportR2Key', () => {
    it('builds the deterministic tenant/report artifact key', () => {
      expect(reportR2Key(TENANT_ID, REQUEST_ID)).toBe(
        `${TENANT_ID}/reports/${REQUEST_ID}.pdf`,
      );
    });
  });

  describe('claimQueuedReport', () => {
    it('stamps the lease and bumps attempt_count in the guarded UPDATE payload', async () => {
      const qb = updateQb({ data: [claimedRow], error: null });
      const admin = adminReturning(qb);

      const row = await claimQueuedReport(
        admin,
        REQUEST_ID,
        '2026-09-20T10:05:00.000Z',
        0,
      );

      expect(row).toEqual(claimedRow);
      expect(qb.update).toHaveBeenCalledWith({
        status: ReportRequestStatus.GENERATING,
        locked_until: '2026-09-20T10:05:00.000Z',
        attempt_count: 1,
      });
    });

    it('guards on id + status=queued and selects the claimed row back', async () => {
      const qb = updateQb({ data: [claimedRow], error: null });

      await claimQueuedReport(adminReturning(qb), REQUEST_ID, 'lease', 2);

      expect(qb.update).toHaveBeenCalledWith(
        expect.objectContaining({ attempt_count: 3 }),
      );
      expect(qb.eq).toHaveBeenCalledWith('id', REQUEST_ID);
      expect(qb.eq).toHaveBeenCalledWith('status', ReportRequestStatus.QUEUED);
      expect(qb.select).toHaveBeenCalledWith('*');
    });

    it('returns null when the guard loses the race (empty update result)', async () => {
      const qb = updateQb({ data: [], error: null });

      const row = await claimQueuedReport(
        adminReturning(qb),
        REQUEST_ID,
        'lease',
        1,
      );

      expect(row).toBeNull();
    });

    it('propagates the query error', async () => {
      const qb = updateQb({
        data: null,
        error: { code: 'XX000', message: 'connection reset' },
      });

      await expect(
        claimQueuedReport(adminReturning(qb), REQUEST_ID, 'lease', 1),
      ).rejects.toEqual({ code: 'XX000', message: 'connection reset' });
    });
  });

  describe('recoverExpiredReport', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-09-20T10:00:00.000Z'));
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('re-claims a stranded row with the expired-lease predicate', async () => {
      const qb = updateQb({ data: [claimedRow], error: null });

      const row = await recoverExpiredReport(
        adminReturning(qb),
        REQUEST_ID,
        '2026-09-20T10:05:00.000Z',
        1,
      );

      expect(row).toEqual(claimedRow);
      expect(qb.update).toHaveBeenCalledWith({
        status: ReportRequestStatus.GENERATING,
        locked_until: '2026-09-20T10:05:00.000Z',
        attempt_count: 2,
      });
      expect(qb.eq).toHaveBeenCalledWith('id', REQUEST_ID);
      expect(qb.eq).toHaveBeenCalledWith(
        'status',
        ReportRequestStatus.GENERATING,
      );
      expect(qb.lt).toHaveBeenCalledWith(
        'locked_until',
        '2026-09-20T10:00:00.000Z',
      );
      expect(qb.select).toHaveBeenCalledWith('*');
    });

    it('returns null when the lease is still held (guard matches zero rows)', async () => {
      const qb = updateQb({ data: [], error: null });

      const row = await recoverExpiredReport(
        adminReturning(qb),
        REQUEST_ID,
        'lease',
        1,
      );

      expect(row).toBeNull();
    });

    it('propagates the query error', async () => {
      const qb = updateQb({ data: null, error: { message: 'boom' } });

      await expect(
        recoverExpiredReport(adminReturning(qb), REQUEST_ID, 'lease', 1),
      ).rejects.toEqual({ message: 'boom' });
    });
  });

  describe('markReportFailed', () => {
    it('stamps failed with the error code and completed_at, guarded on generating', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-09-20T10:06:00.000Z'));
      const qb = updateQb({ data: null, error: null });

      await markReportFailed(adminReturning(qb), REQUEST_ID, 'REPORT_GENERATION_FAILED');

      expect(qb.update).toHaveBeenCalledWith({
        status: ReportRequestStatus.FAILED,
        error_code: 'REPORT_GENERATION_FAILED',
        completed_at: '2026-09-20T10:06:00.000Z',
      });
      expect(qb.eq).toHaveBeenCalledWith('id', REQUEST_ID);
      expect(qb.eq).toHaveBeenCalledWith(
        'status',
        ReportRequestStatus.GENERATING,
      );
      // Terminal stamps are fire-and-forget — no select-back.
      expect(qb.select).not.toHaveBeenCalled();
      jest.useRealTimers();
    });

    it('propagates the query error so the caller can log it', async () => {
      const qb = updateQb({ data: null, error: { message: 'stamp failed' } });

      await expect(
        markReportFailed(adminReturning(qb), REQUEST_ID, 'REPORT_GENERATION_FAILED'),
      ).rejects.toEqual({ message: 'stamp failed' });
    });
  });

  describe('stampReportReady', () => {
    it('lands r2_key, file_size_bytes and completed_at together with status=ready', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-09-20T10:06:00.000Z'));
      const qb = updateQb({ data: null, error: null });

      await stampReportReady(
        adminReturning(qb),
        REQUEST_ID,
        `${TENANT_ID}/reports/${REQUEST_ID}.pdf`,
        2048,
      );

      expect(qb.update).toHaveBeenCalledWith({
        status: ReportRequestStatus.READY,
        r2_key: `${TENANT_ID}/reports/${REQUEST_ID}.pdf`,
        file_size_bytes: 2048,
        completed_at: '2026-09-20T10:06:00.000Z',
      });
      expect(qb.eq).toHaveBeenCalledWith('id', REQUEST_ID);
      expect(qb.eq).toHaveBeenCalledWith(
        'status',
        ReportRequestStatus.GENERATING,
      );
      expect(qb.select).not.toHaveBeenCalled();
      jest.useRealTimers();
    });

    it('propagates the query error', async () => {
      const qb = updateQb({ data: null, error: { message: 'stamp failed' } });

      await expect(
        stampReportReady(adminReturning(qb), REQUEST_ID, 'key', 1),
      ).rejects.toEqual({ message: 'stamp failed' });
    });
  });
});