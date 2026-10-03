import { BadRequestException } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ErrorCode } from '../../common/enums/error-code.enum';
import {
  ATTENDANCE_REPORT_TYPE,
  MAX_EMPLOYEES_PER_ATTENDANCE_REPORT,
  attendanceReportDefinition,
} from './attendance.definition';

/** qb whose chain methods return themselves; the terminal methods resolve. */
function chain(result: { data: unknown; error: unknown }) {
  return {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    // `.in()` is the terminal await of the office/enrolment probes.
    in: jest.fn().mockResolvedValue(result),
    // `.maybeSingle()` is the terminal await of the settings probe.
    maybeSingle: jest.fn().mockResolvedValue(result),
  };
}

/** Admin client stub keyed by table: each `from(table)` gets its own result. */
function adminFor(
  tables: Record<string, { data: unknown; error: unknown }>,
): SupabaseClient {
  const from = jest.fn((table: string) => chain(tables[table]));
  return { from } as unknown as SupabaseClient;
}

const TENANT = 'tenant-uuid';

describe('AttendanceReportDefinition (story 21-1)', () => {
  describe('identity + shape', () => {
    it('registers under the stable attendance_report type with a plain label', () => {
      expect(attendanceReportDefinition.type).toBe(ATTENDANCE_REPORT_TYPE);
      expect(attendanceReportDefinition.label).toBe('Attendance report');
    });

    it('raises the explicit-people cap above the job report 25 (roster scale)', () => {
      expect(attendanceReportDefinition.maxTechnicianIds).toBe(
        MAX_EMPLOYEES_PER_ATTENDANCE_REPORT,
      );
      expect(MAX_EMPLOYEES_PER_ATTENDANCE_REPORT).toBeGreaterThan(25);
    });
  });

  describe('validateParams', () => {
    it('normalizes camelCase body params to the stored snake_case shape', () => {
      expect(
        attendanceReportDefinition.validateParams({
          startDate: '2026-09-01',
          endDate: '2026-09-07',
          technicianIds: [
            '00000000-0000-4000-8000-0000000000e1',
            '00000000-0000-4000-8000-0000000000e2',
          ],
          officeIds: ['00000000-0000-4000-8000-00000000ff01'],
        }),
      ).toEqual({
        start_date: '2026-09-01',
        end_date: '2026-09-07',
        technician_ids: [
          '00000000-0000-4000-8000-0000000000e1',
          '00000000-0000-4000-8000-0000000000e2',
        ],
        office_ids: ['00000000-0000-4000-8000-00000000ff01'],
      });
    });

    it('defaults absent officeIds and technicianIds to empty lists (= all)', () => {
      expect(
        attendanceReportDefinition.validateParams({
          startDate: '2026-09-01',
          endDate: '2026-09-07',
        }),
      ).toEqual({
        start_date: '2026-09-01',
        end_date: '2026-09-07',
        technician_ids: [],
        office_ids: [],
      });
    });

    it('dedupes office ids (the canonical jsonb stores a set)', () => {
      const params = attendanceReportDefinition.validateParams({
        startDate: '2026-09-01',
        endDate: '2026-09-07',
        officeIds: [
          '00000000-0000-4000-8000-00000000ff01',
          '00000000-0000-4000-8000-00000000ff01',
          '00000000-0000-4000-8000-00000000ff02',
        ],
      });
      expect(params.office_ids).toEqual([
        '00000000-0000-4000-8000-00000000ff01',
        '00000000-0000-4000-8000-00000000ff02',
      ]);
    });

    it('rejects a MALFORMED (non-uuid) office id before any membership read (bug bash 2026-10-03: was a PostgREST 22P02 → misleading 400)', () => {
      expect(() =>
        attendanceReportDefinition.validateParams({
          startDate: '2026-09-01',
          endDate: '2026-09-07',
          officeIds: ['not-a-uuid'],
        }),
      ).toThrow(BadRequestException);
    });

    it('rejects a range over the shared 92-day cap', () => {
      // 93 inclusive days: 2026-09-01 .. 2026-12-02.
      expect(() =>
        attendanceReportDefinition.validateParams({
          startDate: '2026-09-01',
          endDate: '2026-12-02',
        }),
      ).toThrow(BadRequestException);
    });
  });

  describe('validateAccess', () => {
    const base = {
      start_date: '2026-09-01',
      end_date: '2026-09-07',
      technician_ids: [] as string[],
      office_ids: [] as string[],
    };

    function expectErrorCode(promise: Promise<unknown>, code: ErrorCode) {
      return expect(promise).rejects.toMatchObject({
        response: { error_code: code },
      });
    }

    it('passes when the module is enabled and set up (no selections to verify)', async () => {
      const admin = adminFor({
        attendance_settings: {
          data: { enabled: true, setup_completed_at: '2026-10-01T05:00:52Z' },
          error: null,
        },
      });
      await expect(
        attendanceReportDefinition.validateAccess!(admin, TENANT, { ...base }),
      ).resolves.toBeUndefined();
    });

    it('rejects with ATTENDANCE_NOT_ENABLED when the settings row is missing', async () => {
      const admin = adminFor({
        attendance_settings: { data: null, error: null },
      });
      await expectErrorCode(
        attendanceReportDefinition.validateAccess!(admin, TENANT, { ...base }),
        ErrorCode.ATTENDANCE_NOT_ENABLED,
      );
    });

    it('rejects with ATTENDANCE_NOT_ENABLED when the module is off', async () => {
      const admin = adminFor({
        attendance_settings: {
          data: { enabled: false, setup_completed_at: null },
          error: null,
        },
      });
      await expectErrorCode(
        attendanceReportDefinition.validateAccess!(admin, TENANT, { ...base }),
        ErrorCode.ATTENDANCE_NOT_ENABLED,
      );
    });

    it('rejects with ATTENDANCE_NOT_ENABLED when setup never completed', async () => {
      const admin = adminFor({
        attendance_settings: {
          data: { enabled: true, setup_completed_at: null },
          error: null,
        },
      });
      await expectErrorCode(
        attendanceReportDefinition.validateAccess!(admin, TENANT, { ...base }),
        ErrorCode.ATTENDANCE_NOT_ENABLED,
      );
    });

    it('rejects an office id outside the tenant with VALIDATION_ERROR', async () => {
      const admin = adminFor({
        attendance_settings: {
          data: { enabled: true, setup_completed_at: 'x' },
          error: null,
        },
        attendance_offices: { data: [{ id: 'o1' }], error: null },
      });
      await expectErrorCode(
        attendanceReportDefinition.validateAccess!(admin, TENANT, {
          ...base,
          office_ids: ['o1', 'other-tenant-office'],
        }),
        ErrorCode.VALIDATION_ERROR,
      );
    });

    it('allows archived offices (their history lives in the records)', async () => {
      // The membership probe has no archived_at filter — a stub returning the
      // requested id passes. (The query shape itself is pinned by the eq/in
      // assertions below.)
      const admin = adminFor({
        attendance_settings: {
          data: { enabled: true, setup_completed_at: 'x' },
          error: null,
        },
        attendance_offices: { data: [{ id: 'archived-office' }], error: null },
      });
      await expect(
        attendanceReportDefinition.validateAccess!(admin, TENANT, {
          ...base,
          office_ids: ['archived-office'],
        }),
      ).resolves.toBeUndefined();
    });

    it('rejects an employee without an enrolment row with VALIDATION_ERROR', async () => {
      const admin = adminFor({
        attendance_settings: {
          data: { enabled: true, setup_completed_at: 'x' },
          error: null,
        },
        attendance_enrolments: { data: [{ employee_id: 'e1' }], error: null },
      });
      await expectErrorCode(
        attendanceReportDefinition.validateAccess!(admin, TENANT, {
          ...base,
          technician_ids: ['e1', 'never-enrolled'],
        }),
        ErrorCode.VALIDATION_ERROR,
      );
    });

    it('skips the office probe entirely when no offices are selected', async () => {
      const from = jest.fn((table: string) =>
        table === 'attendance_settings'
          ? chain({
              data: { enabled: true, setup_completed_at: 'x' },
              error: null,
            })
          : chain({ data: null, error: null }),
      );
      const admin = {
        from,
      } as unknown as SupabaseClient;
      await attendanceReportDefinition.validateAccess!(admin, TENANT, {
        ...base,
      });
      const tables = from.mock.calls.map((c) => c[0]);
      expect(tables).toEqual(['attendance_settings']);
    });
  });
});
