import 'reflect-metadata';
import { HttpException, HttpStatus } from '@nestjs/common';
import { EnrolmentsService } from './enrolments.service';
import { PgPoolFactory } from '../common/pg/pg-pool.factory';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import { ErrorCode } from '../common/enums/error-code.enum';

/**
 * EnrolmentsService (15-7). The pg boundary is a fake `tx.query` that
 * dispatches on the SQL's shape (never call order — the requirement does
 * not care whether the office read precedes the enrolment read). Every
 * assertion pins a requirement behaviour: the FR-2/FR-6 rules, tenant
 * scoping, the archived-office and not-enrolled refusals, the clamp, and
 * the disable's clip-without-insert.
 */

const TENANT = 'f2e0a5c7-1b9d-4c8e-a0f3-0000000000e2';
const EMPLOYEE = 'a0000000-0000-4000-8000-0000000000e1';
const OFFICE = 'b0000000-0000-4000-8000-0000000000e2';
const OFFICE_2 = 'b0000000-0000-4000-8000-0000000000e3';

const VIEW_ROW = {
  user_id: EMPLOYEE,
  tenant_id: TENANT,
  attendance_enabled: true,
  access_state: 'active',
  attendance_start_date: '2026-09-28',
  enabled_at: '2026-09-28T04:00:00+00:00',
  onboarded_at: null,
  office_id: OFFICE,
  office_name: 'Andheri West',
};

const owner: RequestUser = {
  userId: 'owner-uuid',
  tenantId: TENANT,
  role: Role.OWNER,
  rawJwt: 'mock-jwt',
};

interface TxOptions {
  today?: string;
  todayError?: { hint?: string };
  employeeFound?: boolean;
  office?: { id: string; name: string; archived_at: string | null };
  enrolments?: Array<{ id: string; valid: string }>;
  assignments?: Array<{ id: string; valid: string }>;
  /** Epic 16 probe answers (defaults: table absent — FR-6 branch unreached). */
  recordsTableExists?: boolean;
  checkedInToday?: boolean;
  /** The coverage trigger rejects the write at COMMIT (review-patch case). */
  gapOnWrite?: boolean;
  /** Epic 17 disable-sweep rows (defaults: none — no leave to cancel). */
  leaveSweep?: unknown[];
}

function makeTx(options: TxOptions = {}) {
  const writes: Array<{ kind: string; sql: string; params?: unknown[] }> = [];
  const dispatch = (sql: string, params?: unknown[]) => {
    const trimmed = sql.trim();
    if (/^begin|^commit|^rollback|^set local/i.test(trimmed)) {
      return { rows: [] };
    }
    // Writes first — a `delete from X where …` would otherwise substring-
    // match the X read branch below.
    if (/^insert|^update|^delete/i.test(trimmed)) {
      if (options.gapOnWrite) {
        throw Object.assign(new Error('gap at commit'), {
          code: '23514',
          hint: 'ATTENDANCE_ASSIGNMENT_GAP',
        });
      }
      const kind = trimmed.startsWith('insert')
        ? 'insert'
        : trimmed.startsWith('update')
          ? 'clip'
          : 'delete';
      writes.push({ kind, sql, params });
      return { rows: [] };
    }
    if (sql.includes('attendance_lock_tenant')) return { rows: [] };
    if (sql.includes('attendance_lock_employee')) return { rows: [] };
    if (sql.includes('attendance_today')) {
      if (options.todayError) {
        throw Object.assign(new Error('tenant missing'), options.todayError);
      }
      return { rows: [{ today: options.today ?? '2026-09-28' }] };
    }
    if (sql.includes('from public.users where')) {
      return {
        rows:
          options.employeeFound === false
            ? []
            : [{ id: EMPLOYEE, name: 'Ravi' }],
      };
    }
    if (sql.includes('attendance_offices')) {
      return {
        rows: [
          options.office ?? {
            id: OFFICE,
            name: 'Andheri West',
            archived_at: null,
          },
        ],
      };
    }
    if (sql.includes('to_regclass')) {
      return {
        rows: [
          {
            reg: options.recordsTableExists
              ? 'public.attendance_records'
              : null,
          },
        ],
      };
    }
    if (sql.includes('attendance_records')) {
      return { rows: options.checkedInToday ? [{ ok: 1 }] : [] };
    }
    if (sql.includes('from public.attendance_enrolments where')) {
      return { rows: options.enrolments ?? [] };
    }
    if (sql.includes('from public.attendance_office_assignments where')) {
      return { rows: options.assignments ?? [] };
    }
    if (sql.includes('attendance_access_state')) {
      return { rows: [VIEW_ROW] };
    }
    // Epic 17 (spec-17 D12): no leave to sweep by default — the dedicated
    // disable-sweep specs inject rows through options.leaveSweep.
    if (sql.includes('from public.leave_requests r')) {
      return { rows: options.leaveSweep ?? [] };
    }
    if (sql.includes('insert into public.leave_request_days'))
      return { rows: [] };
    if (sql.includes('update public.leave_request_days')) return { rows: [] };
    if (sql.includes('insert into public.leave_events')) return { rows: [] };
    if (sql.includes('insert into public.notifications')) return { rows: [] };
    if (sql.includes('select name from public.users'))
      return { rows: [{ name: 'Ravi' }] };
    throw new Error(`unclassified query: ${sql}`);
  };
  const tx = { query: jest.fn(dispatch) };
  return { tx, writes };
}

function serviceWith(txOptions: TxOptions, viewRows: unknown[] = [VIEW_ROW]) {
  const { tx, writes } = makeTx(txOptions);
  const admin = {
    from: jest.fn(() => {
      const qb: Record<string, jest.Mock> = {};
      for (const m of ['select', 'eq', 'in']) {
        qb[m] = jest.fn().mockReturnValue(qb);
      }
      qb.then = jest.fn((resolve: (v: unknown) => unknown) =>
        Promise.resolve(resolve({ data: viewRows, error: null })),
      );
      return qb;
    }),
  };
  const service = new EnrolmentsService(
    { createAdmin: () => admin } as unknown as SupabaseClientFactory,
    {
      withTransaction: (work: (client: unknown) => Promise<unknown>) =>
        work(tx),
    } as unknown as PgPoolFactory,
  );
  return { service, writes, tx };
}

describe('EnrolmentsService (story 15-7)', () => {
  describe('PUT /enrolments/:employeeId — FR-2 enable', () => {
    it('co-writes the enrolment and the assignment and answers from the view', async () => {
      const { service, writes } = serviceWith({});

      const result = await service.setEnrolment(owner, EMPLOYEE, {
        officeId: OFFICE,
        startDate: '2026-09-28',
      });

      expect(result.attendanceAccess).toBe('active');
      expect(result.officeId).toBe(OFFICE);
      const inserts = writes.filter((w) => w.kind === 'insert');
      expect(inserts).toHaveLength(2); // assignment + enrolment
    });

    it('clamps a past start date to today (AD-8 greatest — never a 422)', async () => {
      const { service, writes } = serviceWith({ today: '2026-09-28' });

      await service.setEnrolment(owner, EMPLOYEE, {
        officeId: OFFICE,
        startDate: '2026-09-01',
      });

      const enrolmentInsert = writes.find(
        (w) => w.kind === 'insert' && w.sql.includes('attendance_enrolments'),
      );
      expect(enrolmentInsert?.params?.[2]).toBe('2026-09-28');
    });

    it('maps a COMMIT-time coverage-trigger rejection to 422 ATTENDANCE_ASSIGNMENT_GAP (never a raw 500)', async () => {
      const { service } = serviceWith({ gapOnWrite: true });

      const error = await service
        .setEnrolment(owner, EMPLOYEE, { officeId: OFFICE })
        .catch((e: HttpException) => e);

      expect(error).toBeInstanceOf(HttpException);
      expect(error.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
      expect((error.getResponse() as { error_code: string }).error_code).toBe(
        ErrorCode.ATTENDANCE_ASSIGNMENT_GAP,
      );
    });

    it('refuses an archived office with 409 ATTENDANCE_OFFICE_ARCHIVED', async () => {
      const { service } = serviceWith({
        office: {
          id: OFFICE,
          name: 'Andheri West',
          archived_at: '2026-09-20T00:00:00+00:00',
        },
      });

      const error = await service
        .setEnrolment(owner, EMPLOYEE, { officeId: OFFICE })
        .catch((e: HttpException) => e);

      expect(error).toBeInstanceOf(HttpException);
      expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
      expect((error.getResponse() as { error_code: string }).error_code).toBe(
        ErrorCode.ATTENDANCE_OFFICE_ARCHIVED,
      );
    });

    it('404s an employee outside the caller tenant (NFR-1)', async () => {
      const { service } = serviceWith({ employeeFound: false });

      await expect(
        service.setEnrolment(owner, EMPLOYEE, { officeId: OFFICE }),
      ).rejects.toMatchObject({
        response: { error_code: ErrorCode.ATTENDANCE_EMPLOYEE_NOT_FOUND },
      });
    });

    it('maps an unknown tenant (attendance_today HINT) to 404 ATTENDANCE_TENANT_NOT_FOUND', async () => {
      const { service } = serviceWith({
        todayError: { hint: 'ATTENDANCE_TENANT_NOT_FOUND' },
      });

      await expect(
        service.setEnrolment(owner, EMPLOYEE, { officeId: OFFICE }),
      ).rejects.toMatchObject({
        response: { error_code: ErrorCode.ATTENDANCE_TENANT_NOT_FOUND },
      });
    });
  });

  describe('PUT /enrolments/:employeeId/office — FR-6 reassignment', () => {
    it('reassigns inside the current period and answers from the view', async () => {
      const { service, writes } = serviceWith({
        enrolments: [{ id: 'enr', valid: '[2026-09-15,)' }],
        assignments: [{ id: 'asg', valid: '[2026-09-15,)' }],
      });

      const result = await service.reassignOffice(owner, EMPLOYEE, {
        officeId: OFFICE_2,
      });

      expect(result.attendanceAccess).toBe('active');
      const insert = writes.find((w) => w.kind === 'insert');
      expect(insert?.params?.[3]).toBe('2026-09-28'); // today
      expect(insert?.params?.[2]).toBe(OFFICE_2);
    });

    it('422s when no enrolment covers the effective date (cannot assign outside tracking)', async () => {
      const { service } = serviceWith({
        enrolments: [{ id: 'enr', valid: '[2026-11-01,)' }],
      });

      const error = await service
        .reassignOffice(owner, EMPLOYEE, { officeId: OFFICE_2 })
        .catch((e: HttpException) => e);

      expect(error).toBeInstanceOf(HttpException);
      expect(error.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
      expect((error.getResponse() as { error_code: string }).error_code).toBe(
        ErrorCode.ATTENDANCE_ASSIGNMENT_NOT_ENROLLED,
      );
    });

    it('applies from tomorrow once Epic 16 exists and the employee checked in today (FR-6)', async () => {
      const { service, writes } = serviceWith({
        enrolments: [{ id: 'enr', valid: '[2026-09-15,)' }],
        assignments: [{ id: 'asg', valid: '[2026-09-15,)' }],
        recordsTableExists: true,
        checkedInToday: true,
      });

      await service.reassignOffice(owner, EMPLOYEE, { officeId: OFFICE_2 });

      const clip = writes.find((w) => w.kind === 'clip');
      expect(clip?.params?.[1]).toBe('2026-09-29'); // tomorrow, not today
      const insert = writes.find((w) => w.kind === 'insert');
      expect(insert?.params?.[3]).toBe('2026-09-29');
    });

    it('applies from the chosen date when Epic 16 has not shipped (probe finds no table)', async () => {
      const { service, writes } = serviceWith({
        enrolments: [{ id: 'enr', valid: '[2026-09-15,)' }],
        assignments: [{ id: 'asg', valid: '[2026-09-15,)' }],
        recordsTableExists: false,
        checkedInToday: false,
      });

      await service.reassignOffice(owner, EMPLOYEE, { officeId: OFFICE_2 });

      const clip = writes.find((w) => w.kind === 'clip');
      expect(clip?.params?.[1]).toBe('2026-09-28'); // today
    });
  });

  describe('DELETE /enrolments/:employeeId — FR-2 disable', () => {
    it('clips both tables and inserts nothing (history stays read-only)', async () => {
      const { service, writes } = serviceWith({
        enrolments: [{ id: 'enr', valid: '[2026-09-15,)' }],
        assignments: [{ id: 'asg', valid: '[2026-09-15,)' }],
      });

      const result = await service.disableEnrolment(owner, EMPLOYEE, {});

      expect(result.attendanceAccess).toBe('active'); // view stub
      expect(writes.filter((w) => w.kind === 'insert')).toHaveLength(0);
      const clips = writes.filter((w) => w.kind === 'clip');
      expect(clips).toHaveLength(2);
      for (const clip of clips) {
        expect(clip.params?.[1]).toBe('2026-09-28');
      }
    });

    it('cancelling a future start deletes the rows outright (nothing covers today)', async () => {
      const { service, writes } = serviceWith({
        enrolments: [{ id: 'enr', valid: '[2026-11-01,)' }],
        assignments: [{ id: 'asg', valid: '[2026-11-01,)' }],
      });

      await service.disableEnrolment(owner, EMPLOYEE, {});

      expect(writes.filter((w) => w.kind === 'delete')).toHaveLength(2);
      expect(writes.filter((w) => w.kind === 'clip')).toHaveLength(0);
      expect(writes.filter((w) => w.kind === 'insert')).toHaveLength(0);
    });
  });

  describe('GET /enrolments — owner roster', () => {
    it('joins the view states with technician display names', async () => {
      const admin = {
        from: jest.fn((table: string) => {
          const qb: Record<string, jest.Mock> = {};
          for (const m of ['select', 'eq', 'in']) {
            qb[m] = jest.fn().mockReturnValue(qb);
          }
          const result =
            table === 'users'
              ? {
                  data: [
                    {
                      id: EMPLOYEE,
                      name: 'Ravi',
                      country_code: '+91',
                      phone_number: '9876543210',
                    },
                  ],
                  error: null,
                }
              : { data: [VIEW_ROW], error: null };
          qb.then = jest.fn((resolve: (v: unknown) => unknown) =>
            Promise.resolve(resolve(result)),
          );
          return qb;
        }),
      };
      const service = new EnrolmentsService(
        { createAdmin: () => admin } as unknown as SupabaseClientFactory,
        {} as unknown as PgPoolFactory,
      );

      const roster = await service.listEnrolments(owner);

      expect(roster).toHaveLength(1);
      expect(roster[0]).toMatchObject({
        employeeId: EMPLOYEE,
        employeeName: 'Ravi',
        phone: '+919876543210',
        attendanceAccess: 'active',
      });
    });
  });
});
