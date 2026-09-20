import type { SupabaseClient } from '@supabase/supabase-js';
import { ReportRequestStatus } from '../enums/report-status.enum';
import { ReportRequestRow } from '../report-response.model';
import {
  REPORT_FAILED_EVENT,
  REPORT_READY_EVENT,
  insertReportNotification,
} from './report-notifications';

const readyRow: ReportRequestRow = {
  id: '00000000-0000-4000-8000-0000000000c1',
  tenant_id: 'tenant-uuid',
  requested_by: 'owner-uuid',
  report_type: 'technician_job_activity',
  params: { start_date: '2026-09-01', end_date: '2026-09-07', technician_ids: [] },
  status: ReportRequestStatus.READY,
  attempt_count: 1,
  locked_until: null,
  r2_key: 'tenant-uuid/reports/req.pdf',
  file_size_bytes: 2048,
  error_code: null,
  created_at: '2026-09-20T10:00:00.000Z',
  completed_at: '2026-09-20T10:05:00.000Z',
};

const failedRow: ReportRequestRow = {
  ...readyRow,
  status: ReportRequestStatus.FAILED,
  r2_key: null,
  file_size_bytes: null,
  error_code: 'REPORT_GENERATION_FAILED',
};

/**
 * insertReportNotification only needs the `.insert(payload)` chain on the
 * notifications table, awaited directly — so the insert mock resolves the
 * PostgREST result itself.
 */
function adminWithInsert(result: { error: unknown }) {
  const insert = jest.fn().mockResolvedValue(result);
  const admin = {
    from: jest.fn((table: string) => {
      if (table !== 'notifications') {
        throw new Error(`unexpected table ${table}`);
      }
      return { insert };
    }),
  } as unknown as SupabaseClient;
  return { insert, admin };
}

describe('insertReportNotification (story 12-3, FR-8)', () => {
  it('inserts report_ready for a ready row, job_id NULL and no errorCode', async () => {
    const { insert, admin } = adminWithInsert({ error: null });

    await insertReportNotification(admin, readyRow, 'Technician Job Activity');

    expect(admin.from).toHaveBeenCalledWith('notifications');
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith({
      tenant_id: 'tenant-uuid',
      user_id: 'owner-uuid',
      job_id: null,
      event_type: REPORT_READY_EVENT,
      payload: {
        reportId: readyRow.id,
        reportType: 'technician_job_activity',
        reportLabel: 'Technician Job Activity',
        status: ReportRequestStatus.READY,
        errorCode: null,
      },
    });
  });

  it('inserts report_failed for a failed row, carrying the error_code', async () => {
    const { insert, admin } = adminWithInsert({ error: null });

    await insertReportNotification(admin, failedRow, 'Technician Job Activity');

    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: REPORT_FAILED_EVENT,
        user_id: failedRow.requested_by,
        job_id: null,
      }),
    );
    const payload = (insert.mock.calls[0][0] as { payload: Record<string, unknown> })
      .payload;
    expect(payload.status).toBe(ReportRequestStatus.FAILED);
    expect(payload.errorCode).toBe('REPORT_GENERATION_FAILED');
  });

  it('falls back to null errorCode when the row has none', async () => {
    const { insert, admin } = adminWithInsert({ error: null });

    await insertReportNotification(admin, readyRow, 'Any Label');

    const payload = (insert.mock.calls[0][0] as { payload: Record<string, unknown> })
      .payload;
    expect(payload.errorCode).toBeNull();
  });

  it('logs and swallows an insert error — a notification failure never throws', async () => {
    const { insert, admin } = adminWithInsert({
      error: { code: 'XX000', message: 'connection reset' },
    });

    await expect(
      insertReportNotification(admin, readyRow, 'Technician Job Activity'),
    ).resolves.toBeUndefined();

    expect(insert).toHaveBeenCalledTimes(1);
  });
});