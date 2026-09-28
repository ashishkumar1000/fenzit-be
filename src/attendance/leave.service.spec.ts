import type { PoolClient } from 'pg';
import { HttpException } from '@nestjs/common';
import { PgPoolFactory } from '../common/pg/pg-pool.factory';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { ErrorCode } from '../common/enums/error-code.enum';
import { LeaveService } from './leave.service';
import { ApplyLeaveDto, OnBehalfLeaveDto } from './dto/leave.dto';

/**
 * Decision pins for the leave lifecycle writes (spec-17 D2/D6/D7/D8/D9/
 * D10): lock order, replay scoping, the rejection ladder as mapped
 * exceptions, the approve/reject/revoke/cancel state guard (own retry
 * 200 vs conflict 409), the split under the cutoff, and on-behalf's
 * approved-immediately contract. The real SQL, constraints and triggers
 * are proven by the real-DB journey; these pins would survive any
 * refactoring that keeps the decisions.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const EMPLOYEE = '22222222-2222-4222-8222-222222222222';
const OWNER = '33333333-3333-4333-8333-333333333333';
const KEY = '44444444-4444-4444-8444-444444444444';
const REQ_DB_ID = '55555555-5555-4555-8555-555555555555';

const REQUEST_ROW = {
  id: REQ_DB_ID,
  tenant_id: TENANT,
  employee_id: EMPLOYEE,
  request_id: KEY,
  start_date: '2026-10-01',
  end_date: '2026-10-03',
  part: 'full_day',
  reason: 'Family function',
  created_by: EMPLOYEE,
  created_at: new Date('2026-09-28T10:00:00Z'),
};

const DAYS = [
  { leave_date: '2026-10-01', state: 'pending' },
  { leave_date: '2026-10-02', state: 'pending' },
  { leave_date: '2026-10-03', state: 'pending' },
];

type Router = (
  sql: string,
  params?: unknown[],
) => { rows: unknown[] } | undefined;

function user(id: string): RequestUser {
  return {
    userId: id,
    tenantId: TENANT,
    role: 'technician',
  } as unknown as RequestUser;
}

function fakeTx(router: Router) {
  const queries: { sql: string; params?: unknown[] }[] = [];
  const tx = {
    query: jest.fn((sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      return Promise.resolve(router(sql, params) ?? { rows: [] });
    }),
  } as unknown as PoolClient & { query: jest.Mock };
  const pg = {
    withTransaction: (work: (client: unknown) => Promise<unknown>) => work(tx),
  } as unknown as PgPoolFactory;
  return { tx, queries, service: new LeaveService(pg) };
}

/** The shared read answers for an enrolled, tracked, no-conflict employee. */
function baseRouter(
  overrides: {
    replay?: unknown;
    request?: unknown;
    days?: unknown;
    sourceDays?: unknown;
    lastEvent?: { cause: string; actor_id: string | null } | null;
    enrolmentFloor?: { start: string; covers: boolean }[];
    overlapping?: unknown[];
    checkedIn?: unknown[];
    holidays?: unknown[];
    updateCount?: number;
  } = {},
): Router {
  let requestReads = 0;
  return (sql) => {
    if (sql.includes('attendance_lock')) return { rows: [] };
    if (sql.includes('attendance_today'))
      return { rows: [{ today: '2026-09-29' }] };
    if (sql.includes('select now() as now'))
      return { rows: [{ now: new Date('2026-09-29T03:30:00Z') }] };
    if (sql.includes('select owner_id from public.tenants'))
      return { rows: [{ owner_id: OWNER }] };
    if (sql.includes('select timezone from public.tenants'))
      return { rows: [{ timezone: 'Asia/Kolkata' }] };
    // findRequestIdByKey (replay) — caller-scoped.
    if (sql.includes('request_id = $2') && sql.includes('leave_requests'))
      return { rows: overrides.replay ? [overrides.replay] : [] };
    // findRequestWithDays — the request read (and re-reads).
    if (sql.includes('from public.leave_requests') && sql.includes('id = $2')) {
      requestReads += 1;
      return {
        rows:
          overrides.request !== undefined ? [overrides.request] : [REQUEST_ROW],
      };
    }
    // findDaysInStates — the under-lock actionable re-read (checked BEFORE
    // the request-days branch: its SQL also carries leave_request_id).
    if (
      sql.includes('from public.leave_request_days') &&
      sql.includes('state = any($2::text[])')
    )
      return { rows: overrides.sourceDays ?? DAYS };
    if (
      sql.includes('from public.leave_request_days') &&
      sql.includes('where leave_request_id = $1') &&
      sql.includes('order by leave_date')
    )
      return { rows: overrides.days ?? DAYS };
    // findLastEvent.
    if (sql.includes('from public.leave_events'))
      return { rows: overrides.lastEvent ? [overrides.lastEvent] : [] };
    // employeeExistsInTenant (the D10 on-behalf 404 check) — the count
    // shape, kept OFF the `select name from public.users` route below.
    if (sql.includes('from public.users') && sql.includes('count(*)'))
      return { rows: [{ n: '1' }] };
    // readEnrolmentFloor AND buildDayContext both read this table — the
    // row carries both shapes (valid+enabled_at for the context).
    if (sql.includes('from public.attendance_enrolments'))
      return {
        rows: overrides.enrolmentFloor ?? [
          {
            valid: '[2026-01-01,)',
            enabled_at: '2026-01-01T04:00:00Z',
            start: '2026-01-01',
            covers: true,
          },
        ],
      };
    if (sql.includes('attendance_settings'))
      return { rows: [{ setup_completed_at: new Date(), enabled: true }] };
    if (sql.includes('weekly_off_overrides')) return { rows: [] };
    if (sql.includes('weekly_off_defaults')) return { rows: [] };
    if (sql.includes('from public.holidays'))
      return { rows: overrides.holidays ?? [] };
    // findOverlappingDays.
    if (sql.includes('d.state = any($5::text[])'))
      return { rows: overrides.overlapping ?? [] };
    // findCheckedInDates.
    if (sql.includes('from public.attendance_records'))
      return { rows: overrides.checkedIn ?? [] };
    // The span rule read inside buildDayContext (the split's cutoff).
    if (sql.includes('attendance_office_assignments'))
      return {
        rows: [
          {
            office_id: 'office-1',
            office_name: 'HQ',
            office_lat: 12.97,
            office_lng: 77.59,
            radius_m: 100,
          },
        ],
      };
    if (sql.includes('attendance_office_rules'))
      return {
        rows: [
          {
            id: 'rule-1',
            valid: '[2026-01-01,)',
            start_time: '23:59:00',
            end_time: '23:59:00',
            late_cutoff_minutes: 0,
          },
        ],
      };
    if (sql.includes('insert into public.leave_requests'))
      return { rows: [REQUEST_ROW] };
    if (sql.includes('insert into public.leave_request_days'))
      return { rows: [] };
    if (sql.includes('update public.leave_request_days')) {
      const source = (overrides.sourceDays ?? DAYS) as Array<{
        leave_date: string;
      }>;
      return {
        rows:
          overrides.updateCount !== undefined
            ? Array.from({ length: overrides.updateCount }, () => ({
                leave_date: 'x',
              }))
            : source.map((d) => ({ leave_date: d.leave_date })),
      };
    }
    if (sql.includes('insert into public.leave_events')) return { rows: [] };
    if (sql.includes('insert into public.notifications')) return { rows: [] };
    if (sql.includes('select name from public.users'))
      return { rows: [{ name: 'Arya' }] };
    return { rows: [] };
  };
}

function dto(overrides: Partial<ApplyLeaveDto> = {}): ApplyLeaveDto {
  return Object.assign(new ApplyLeaveDto(), {
    startDate: '2026-10-01',
    endDate: '2026-10-03',
    part: 'full_day',
    reason: 'Family function',
    ...overrides,
  });
}

async function rejectionOf(
  promise: Promise<unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    await promise;
    throw new Error('expected the promise to reject');
  } catch (err) {
    expect(err).toBeInstanceOf(HttpException);
    const exception = err as HttpException;
    return {
      status: exception.getStatus(),
      body: exception.getResponse() as Record<string, unknown>,
    };
  }
}

describe('LeaveService — apply (17-1)', () => {
  it('locks tenant → employee, inserts the request, all-pending days, event and owner notification', async () => {
    const { tx, queries, service } = fakeTx(baseRouter());
    const view = await service.applyForSelf(user(EMPLOYEE), dto(), KEY);
    expect(queries[0].sql).toContain('attendance_lock_tenant');
    expect(queries[1].sql).toContain('attendance_lock_employee');
    const requestInsert = queries.find((q) =>
      q.sql.includes('insert into public.leave_requests'),
    );
    expect(requestInsert?.params?.[6]).toBe('Family function');
    const daysInsert = queries.find((q) =>
      q.sql.includes('insert into public.leave_request_days'),
    );
    expect(daysInsert?.params?.[3]).toBe('pending');
    const notification = queries.find((q) =>
      q.sql.includes('insert into public.notifications'),
    );
    expect(notification?.params?.[1]).toBe(OWNER); // recipient = the owner
    expect(JSON.parse(notification?.params?.[3] as string)).toMatchObject({
      employeeName: 'Arya',
      workingDays: 3,
    });
    expect(view.status).toBe('pending');
    expect(view.workingDays).toBe(3);
  });

  it('replays the stored request with NO second write (AD-6)', async () => {
    const { queries, service } = fakeTx(baseRouter({ replay: REQUEST_ROW }));
    const view = await service.applyForSelf(user(EMPLOYEE), dto(), KEY);
    expect(view.id).toBe(REQ_DB_ID);
    expect(
      queries.some((q) => q.sql.includes('insert into public.leave_requests')),
    ).toBe(false);
  });

  it('maps a raced duplicate key to 409 DUPLICATE_RESOURCE, not LEAVE_OVERLAP', async () => {
    const failing = baseRouter();
    const { service } = fakeTx((sql, params) => {
      if (sql.includes('insert into public.leave_requests')) {
        throw Object.assign(new Error('uq'), {
          code: '23505',
          constraint: 'leave_requests_tenant_request_uq',
        });
      }
      return failing(sql, params);
    });
    const { status, body } = await rejectionOf(
      service.applyForSelf(user(EMPLOYEE), dto(), KEY),
    );
    expect(status).toBe(409);
    expect(body['error_code']).toBe(ErrorCode.DUPLICATE_RESOURCE);
  });

  it.each([
    [
      'never enrolled',
      baseRouter({ enrolmentFloor: [] }),
      ErrorCode.ATTENDANCE_NOT_TRACKED,
    ],
    [
      'before the floor',
      baseRouter({ enrolmentFloor: [{ start: '2026-10-05', covers: true }] }),
      ErrorCode.LEAVE_BEFORE_START_DATE,
    ],
    [
      'too far back',
      baseRouter({ enrolmentFloor: [{ start: '2026-01-01', covers: true }] }),
      null, // handled by the dedicated case below (date-dependent)
    ],
    [
      'overlapping',
      baseRouter({
        overlapping: [{ leave_date: '2026-10-02', state: 'pending' }],
      }),
      ErrorCode.LEAVE_OVERLAP,
    ],
    [
      'checked in',
      baseRouter({ checkedIn: [{ work_date: '2026-10-01' }] }),
      ErrorCode.LEAVE_CHECKED_IN_CONFLICT,
    ],
    [
      'all off',
      (function allOffRouter(): Router {
        const inner = baseRouter({
          // Every date in the range is a holiday → "These days are already off".
          holidays: [
            { holiday_date: '2026-10-01' },
            { holiday_date: '2026-10-02' },
            { holiday_date: '2026-10-03' },
          ],
        });
        return (sql, params) => {
          if (sql.includes('from public.holidays')) {
            return {
              rows: [
                { holiday_date: '2026-10-01' },
                { holiday_date: '2026-10-02' },
                { holiday_date: '2026-10-03' },
              ],
            };
          }
          return inner(sql, params);
        };
      })(),
      ErrorCode.LEAVE_ALREADY_OFF,
    ],
  ])('maps %s to its catalogue code', async (_label, router, expected) => {
    if (expected === null) return; // 7-day case is date-dependent — skipped here
    const { queries, service } = fakeTx(router);
    const { status, body } = await rejectionOf(
      service.applyForSelf(user(EMPLOYEE), dto(), KEY),
    );
    expect(status).toBeGreaterThanOrEqual(400);
    expect(body['error_code']).toBe(expected);
    // Nothing was written: no request row, no day rows, no notification.
    expect(
      queries.some((q) => q.sql.includes('insert into public.leave_requests')),
    ).toBe(false);
    expect(
      queries.some((q) =>
        q.sql.includes('insert into public.leave_request_days'),
      ),
    ).toBe(false);
    expect(
      queries.some((q) => q.sql.includes('insert into public.notifications')),
    ).toBe(false);
  });

  it('rejects an 8-days-back range with LEAVE_TOO_OLD', async () => {
    const { service } = fakeTx(baseRouter());
    const { body } = await rejectionOf(
      service.applyForSelf(
        user(EMPLOYEE),
        dto({ startDate: '2026-09-20', endDate: '2026-09-20' }),
        KEY,
      ),
    );
    expect(body['error_code']).toBe(ErrorCode.LEAVE_TOO_OLD);
  });

  it('rejects a half-day part on a multi-date range', async () => {
    const { service } = fakeTx(baseRouter());
    const { body } = await rejectionOf(
      service.applyForSelf(user(EMPLOYEE), dto({ part: 'first_half' }), KEY),
    );
    expect(body['error_code']).toBe(ErrorCode.LEAVE_INVALID_RANGE);
  });

  it('on-behalf creates days APPROVED immediately and notifies the EMPLOYEE (FR-16)', async () => {
    const { queries, service } = fakeTx(baseRouter());
    const onBehalf = Object.assign(new OnBehalfLeaveDto(), dto(), {
      employeeId: EMPLOYEE,
    });
    await service.applyOnBehalf(
      { userId: OWNER, tenantId: TENANT } as unknown as RequestUser,
      onBehalf,
      KEY,
    );
    const daysInsert = queries.find((q) =>
      q.sql.includes('insert into public.leave_request_days'),
    );
    expect(daysInsert?.params?.[3]).toBe('approved');
    const notification = queries.find((q) =>
      q.sql.includes('insert into public.notifications'),
    );
    expect(notification?.params?.[1]).toBe(EMPLOYEE); // recipient = the employee
    const requestInsert = queries.find((q) =>
      q.sql.includes('insert into public.leave_requests'),
    );
    expect(requestInsert?.params?.[7]).toBe(OWNER); // created_by = the owner
  });
});

describe('LeaveService — approve / reject (17-2)', () => {
  it('approves every pending day under the lock and notifies the employee', async () => {
    const { queries, service } = fakeTx(baseRouter());
    const view = await service.approve(
      { userId: OWNER, tenantId: TENANT } as unknown as RequestUser,
      REQ_DB_ID,
    );
    const update = queries.find((q) =>
      q.sql.includes('update public.leave_request_days'),
    );
    expect(update?.params?.[0]).toBe('approved');
    expect(update?.params?.[3]).toEqual(['pending']);
    const notification = queries.find((q) =>
      q.sql.includes('insert into public.notifications'),
    );
    expect(notification?.params?.[1]).toBe(EMPLOYEE);
    expect(view.status).toBe('pending'); // fixture days stay pending — the journey proves the real update
  });

  it('answers an own retry with 200 and NO second transition/event (AD-6)', async () => {
    const { queries, service } = fakeTx(
      baseRouter({
        sourceDays: [],
        lastEvent: { cause: 'approve', actor_id: OWNER },
      }),
    );
    await service.approve(
      { userId: OWNER, tenantId: TENANT } as unknown as RequestUser,
      REQ_DB_ID,
    );
    expect(
      queries.some((q) => q.sql.includes('update public.leave_request_days')),
    ).toBe(false);
    expect(
      queries.some((q) => q.sql.includes('insert into public.leave_events')),
    ).toBe(false);
  });

  it('409s when the request is no longer pending and the last event was NOT this action', async () => {
    const { service } = fakeTx(
      baseRouter({
        sourceDays: [],
        lastEvent: { cause: 'approve', actor_id: OWNER },
      }),
    );
    const { body } = await rejectionOf(
      service.reject(
        { userId: OWNER, tenantId: TENANT } as unknown as RequestUser,
        REQ_DB_ID,
        'No budget',
      ),
    );
    expect(body['error_code']).toBe(ErrorCode.LEAVE_NOT_PENDING);
  });

  it('404s another tenant’s request id (no existence leak)', async () => {
    const { service } = fakeTx(baseRouter({ request: null }));
    const { status } = await rejectionOf(
      service.approve(
        { userId: OWNER, tenantId: TENANT } as unknown as RequestUser,
        REQ_DB_ID,
      ),
    );
    expect(status).toBe(404);
  });
});

describe('LeaveService — revoke with the split rule (17-3)', () => {
  it('revokes only the actionable dates (rule 23:59 → today IS actionable)', async () => {
    const sourceDays = [
      { leave_date: '2026-09-28', state: 'approved' },
      { leave_date: '2026-09-29', state: 'approved' },
      { leave_date: '2026-09-30', state: 'approved' },
    ];
    const { queries, service } = fakeTx(
      baseRouter({ sourceDays, updateCount: 2 }),
    );
    await service.revoke(
      { userId: OWNER, tenantId: TENANT } as unknown as RequestUser,
      REQ_DB_ID,
      'Needed on site',
    );
    const update = queries.find((q) =>
      q.sql.includes('update public.leave_request_days'),
    );
    // dbNow is 09:00 IST on 2026-09-29; rule start 23:59 → cutoff NOT passed → today actionable.
    expect(update?.params?.[2]).toEqual(['2026-09-29', '2026-09-30']);
    const notification = queries.find((q) =>
      q.sql.includes('insert into public.notifications'),
    );
    expect(JSON.parse(notification?.params?.[3] as string)).toMatchObject({
      revokedDates: ['2026-09-29', '2026-09-30'],
      reason: 'Needed on site',
    });
  });

  it('excludes today once the cutoff has passed and keeps it as cutoff_passed', async () => {
    const { queries, service } = fakeTx((sql, params) => {
      const inner = baseRouter({
        sourceDays: [
          { leave_date: '2026-09-29', state: 'approved' },
          { leave_date: '2026-09-30', state: 'approved' },
        ],
        updateCount: 1,
      })(sql, params);
      if (sql.includes('select now() as now')) {
        return { rows: [{ now: new Date('2026-09-29T06:00:00Z') }] }; // 11:30 IST
      }
      if (sql.includes('attendance_office_rules')) {
        // Office starts 09:00 IST — 11:30 IST is past the cutoff.
        return {
          rows: [
            {
              id: 'rule-1',
              valid: '[2026-01-01,)',
              start_time: '09:00:00',
              end_time: '18:00:00',
              late_cutoff_minutes: 0,
            },
          ],
        };
      }
      return inner;
    });
    await service.revoke(
      { userId: OWNER, tenantId: TENANT } as unknown as RequestUser,
      REQ_DB_ID,
      'Needed on site',
    );
    const update = queries.find((q) =>
      q.sql.includes('update public.leave_request_days'),
    );
    expect(update?.params?.[2]).toEqual(['2026-09-30']);
  });

  it('own retry with nothing actionable → 200; a fresh conflict → 409 NOT_REVOKABLE', async () => {
    const ownRetry = fakeTx(
      baseRouter({
        sourceDays: [],
        lastEvent: { cause: 'owner_revoke', actor_id: OWNER },
      }),
    );
    await ownRetry.service.revoke(
      { userId: OWNER, tenantId: TENANT } as unknown as RequestUser,
      REQ_DB_ID,
      'Needed on site',
    );
    expect(
      ownRetry.queries.some((q) =>
        q.sql.includes('update public.leave_request_days'),
      ),
    ).toBe(false);

    const conflict = fakeTx(
      baseRouter({
        sourceDays: [],
        lastEvent: { cause: 'approve', actor_id: OWNER },
      }),
    );
    const { body } = await rejectionOf(
      conflict.service.revoke(
        { userId: OWNER, tenantId: TENANT } as unknown as RequestUser,
        REQ_DB_ID,
        'Needed on site',
      ),
    );
    expect(body['error_code']).toBe(ErrorCode.LEAVE_NOT_REVOKABLE);
  });
});

describe('LeaveService — cancel (17-3, FR-15)', () => {
  it('cancels the employee’s actionable pending/approved dates and notifies the OWNER', async () => {
    const { queries, service } = fakeTx(
      baseRouter({
        sourceDays: [
          { leave_date: '2026-09-30', state: 'pending' },
          { leave_date: '2026-10-01', state: 'approved' },
        ],
      }),
    );
    await service.cancel(user(EMPLOYEE), REQ_DB_ID);
    const update = queries.find((q) =>
      q.sql.includes('update public.leave_request_days'),
    );
    expect(update?.params?.[0]).toBe('cancelled');
    expect(update?.params?.[3]).toEqual(['pending', 'approved']);
    const notification = queries.find((q) =>
      q.sql.includes('insert into public.notifications'),
    );
    expect(notification?.params?.[1]).toBe(OWNER);
  });

  it('404s when the request belongs to ANOTHER employee (me-route scoping)', async () => {
    const { service } = fakeTx(baseRouter({ request: null }));
    const { status } = await rejectionOf(
      service.cancel(user(EMPLOYEE), REQ_DB_ID),
    );
    expect(status).toBe(404);
  });
});
