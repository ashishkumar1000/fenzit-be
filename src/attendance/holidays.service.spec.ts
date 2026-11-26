import { HttpException } from '@nestjs/common';
import { HolidaysService } from './holidays.service';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { StorageService } from '../storage/storage.service';
import { PgPoolFactory } from '../common/pg/pg-pool.factory';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import { ErrorCode } from '../common/enums/error-code.enum';
import { ATTENDANCE_NOTIFICATION_EVENT } from './notification-events';

/**
 * The RPC-era supabase chain builders are gone with the PL/pgSQL they drove
 * (console redesign 2026-11-26): every read/write now runs one parameterised
 * statement through the pg pool inside withTransaction. The stand-in routes
 * by SQL SHAPE — the service's statement set changing fails loudly here
 * (the leave-types/payroll-lock idiom) — and records every statement so
 * fan-out and join-row behaviour are pinned without a real DB.
 */

const TENANT_ID = '00000000-0000-4000-8000-0000000000c6';
const HOLIDAY_ID = '00000000-0000-4000-8000-0000000000e6';
const TODAY = '2026-09-27';

/** Scoped-READ rows arrive snake_case (`toScoped` maps holiday_date). */
const SCOPED_ROW = {
  id: HOLIDAY_ID,
  name: 'Gandhi Jayanti',
  description: null,
  scope: 'all',
  holiday_date: '2026-10-02',
  officeIds: [],
};

/** The by-id re-read returns the ALIASED row (readScopedById does not remap). */
const BY_ID_ROW = {
  id: HOLIDAY_ID,
  name: 'Gandhi Jayanti',
  description: null,
  scope: 'all',
  holidayDate: '2026-10-02',
  officeIds: [],
};

function build(
  opts: {
    /** Rows for the by-id re-read (update/remove paths). */
    holidayById?: Array<Record<string, unknown>>;
    /** Rows for the date-scoped single read (impact). */
    holidayOn?: Array<Record<string, unknown>>;
    /** Rows for list/between reads (list, overview). */
    holidayRows?: Array<Record<string, unknown>>;
    officeCounts?: Array<Record<string, unknown>>;
    /** Per-holiday date-anchored headcounts (overview rows). */
    headcounts?: Array<{ holiday_id: string; employees_off: number }>;
    /** Rows for the weekly-off defaults window read (overview). */
    weeklyOffDefaults?: Array<{ valid: string; days: number[] }>;
    unassigned?: number;
    tracked?: number;
    approvedLeave?: Array<Record<string, unknown>>;
    /** Injected SQLSTATE for insert/update failures. */
    writeError?: { code: string };
    /** The notification gate's verdict (default: enabled). */
    notificationsAllowed?: boolean;
    members?: Array<Record<string, unknown>>;
  } = {},
) {
  const txStatements: Array<{ sql: string; params?: unknown[] }> = [];
  const notificationRows: unknown[][] = [];
  const holidayOfficeRows: string[][] = [];

  const tx = {
    query: jest.fn((sql: string, params?: unknown[]) => {
      txStatements.push({ sql, params });
      if (sql.includes('insert into public.holidays')) {
        if (opts.writeError) {
          return Promise.reject(
            Object.assign(new Error('write failed'), {
              code: opts.writeError.code,
            }),
          );
        }
        // RETURNING echoes the just-inserted row ($1 tenant, $2 date,
        // $3 name, $4 description, $5 scope).
        return Promise.resolve({
          rows: [
            {
              id: HOLIDAY_ID,
              name: params?.[2],
              description: params?.[3],
              scope: params?.[4],
              holidayDate: params?.[1],
            },
          ],
        });
      }
      if (sql.includes('update public.holidays')) {
        if (opts.writeError) {
          return Promise.reject(
            Object.assign(new Error('write failed'), {
              code: opts.writeError.code,
            }),
          );
        }
        // UPDATE ... RETURNING ($1 id, $2 tenant, $3 name, $4 description,
        // $5 scope, $6 date).
        return Promise.resolve({
          rows: [
            {
              id: HOLIDAY_ID,
              name: params?.[2],
              description: params?.[3],
              scope: params?.[4],
              holidayDate: params?.[5],
            },
          ],
        });
      }
      if (sql.includes('insert into public.holiday_offices')) {
        holidayOfficeRows.push((params?.[2] as string[]) ?? []);
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('delete from public.holiday_offices')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (sql.includes('delete from public.holidays')) {
        return Promise.resolve({
          rows: [],
          rowCount: (opts.holidayById ?? []).length > 0 ? 1 : 0,
        });
      }
      if (sql.includes('from public.attendance_settings')) {
        return Promise.resolve({
          rows: [{ allowed: opts.notificationsAllowed ?? true }],
        });
      }
      if (sql.includes('insert into public.notifications')) {
        notificationRows.push(params ?? []);
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (sql.includes('where h.id = $1::uuid and h.tenant_id = $2::uuid')) {
        return Promise.resolve({ rows: opts.holidayById ?? [] });
      }
      if (sql.includes('and h.holiday_date = $2::date limit 1')) {
        return Promise.resolve({ rows: opts.holidayOn ?? [] });
      }
      if (sql.includes('as employees_off')) {
        return Promise.resolve({ rows: opts.headcounts ?? [] });
      }
      if (sql.includes('and h.holiday_date between $2::date and $3::date')) {
        return Promise.resolve({ rows: opts.holidayRows ?? [] });
      }
      if (
        sql.includes('from public.holidays h') &&
        sql.includes('order by h.holiday_date asc')
      ) {
        return Promise.resolve({ rows: opts.holidayRows ?? [] });
      }
      if (sql.includes('from public.leave_request_days d')) {
        return Promise.resolve({ rows: opts.approvedLeave ?? [] });
      }
      if (sql.includes('as tracked')) {
        return Promise.resolve({ rows: [{ tracked: opts.tracked ?? 0 }] });
      }
      if (sql.includes('as unassigned')) {
        return Promise.resolve({
          rows: [{ unassigned: opts.unassigned ?? 0 }],
        });
      }
      if (sql.includes('staff_count')) {
        return Promise.resolve({ rows: opts.officeCounts ?? [] });
      }
      if (sql.includes('from public.attendance_weekly_off_defaults')) {
        return Promise.resolve({ rows: opts.weeklyOffDefaults ?? [] });
      }
      return Promise.reject(new Error(`unexpected SQL in the tx: ${sql}`));
    }),
  };

  const pg = {
    withTransaction: jest.fn((work: (c: unknown) => Promise<unknown>) =>
      work(tx),
    ),
  } as unknown as jest.Mocked<PgPoolFactory>;

  // resolveTenantToday's rpc (the same supabase helper as before the
  // rewrite) — the 404 path stays the PT404 contract.
  const rpc = jest.fn(() =>
    Promise.resolve({ data: TODAY, error: null }),
  );
  const admin = {
    from: jest.fn(() => {
      throw new Error('unexpected supabase from() outside avatar reads');
    }),
    rpc,
  };
  // avatarUrlsByUserId reads memberships + users — only the impact path
  // with leave rows reaches it.
  const from = jest.fn((table: string) => {
    if (table !== 'memberships') {
      throw new Error(`unexpected table ${table}`);
    }
    const b: Record<string, unknown> = {};
    for (const name of ['select', 'eq', 'order', 'in', 'neq']) {
      b[name] = jest.fn(() => b);
    }
    b['then'] = (resolve: (v: unknown) => void) =>
      resolve({ data: opts.members ?? [], error: null });
    return b;
  });
  (admin as { from: unknown }).from = from;

  const supabaseClientFactory = {
    createAdmin: jest.fn(() => admin),
  } as unknown as jest.Mocked<SupabaseClientFactory>;

  const storageService = {
    presignReadUrl: jest.fn((key: string) =>
      Promise.resolve(`https://signed.example/${key}`),
    ),
  };

  const service = new HolidaysService(
    supabaseClientFactory,
    storageService as unknown as StorageService,
    pg,
  );

  return { service, tx, txStatements, notificationRows, holidayOfficeRows, rpc };
}

async function expectErrorCode(
  promise: Promise<unknown>,
  status: number,
  errorCode: ErrorCode,
  extra: Record<string, unknown> = {},
) {
  await expect(promise).rejects.toBeInstanceOf(HttpException);
  await promise.catch((e: HttpException) => {
    expect(e.getStatus()).toBe(status);
    expect(e.getResponse()).toMatchObject({
      error_code: errorCode,
      ...extra,
    });
  });
}

const ownerUser: RequestUser = {
  userId: 'owner-uuid',
  tenantId: TENANT_ID,
  role: Role.COMPANY_ADMIN,
  platformAdmin: false,
  rawJwt: 'mock-jwt',
};
const noTenantUser: RequestUser = { ...ownerUser, tenantId: null };

describe('HolidaysService (pg rewrite, console redesign 2026-11-26)', () => {
  describe('listHolidays', () => {
    it('maps scoped rows to the camelCase response (scope + offices + copy on board)', async () => {
      const { service } = build({
        holidayRows: [
          SCOPED_ROW,
          {
            ...SCOPED_ROW,
            id: 'h2',
            name: 'Diwali',
            holiday_date: '2026-11-08',
            description: 'Festival of lights',
            scope: 'offices',
            officeIds: ['office-1', 'office-2'],
          },
        ],
      });

      await expect(service.listHolidays(ownerUser)).resolves.toEqual([
        {
          id: HOLIDAY_ID,
          date: '2026-10-02',
          name: 'Gandhi Jayanti',
          description: null,
          scope: 'all',
          officeIds: [],
        },
        {
          id: 'h2',
          date: '2026-11-08',
          name: 'Diwali',
          description: 'Festival of lights',
          scope: 'offices',
          officeIds: ['office-1', 'office-2'],
        },
      ]);
    });

    it('returns [] when the tenant has no holidays — no rows is not a 404', async () => {
      const { service } = build();
      await expect(service.listHolidays(ownerUser)).resolves.toEqual([]);
    });

    it('requires a tenant — 400 VALIDATION_ERROR before anything runs', async () => {
      const { service, rpc } = build();
      await expectErrorCode(
        service.listHolidays(noTenantUser),
        400,
        ErrorCode.VALIDATION_ERROR,
      );
      expect(rpc).not.toHaveBeenCalled();
    });
  });

  describe('getOverview', () => {
    it('serves the year view: holidays + per-holiday date-anchored headcounts + per-office staff + unassigned count + weekly-off defaults', async () => {
      const { service, txStatements } = build({
        holidayRows: [SCOPED_ROW],
        headcounts: [{ holiday_id: HOLIDAY_ID, employees_off: 7 }],
        officeCounts: [
          { office_id: 'office-1', name: 'Bengaluru', staff_count: 7 },
          { office_id: 'office-2', name: 'Pune', staff_count: 0 },
        ],
        unassigned: 2,
        weeklyOffDefaults: [{ valid: '[2026-01-01,)', days: [0, 6] }],
      });

      await expect(
        service.getOverview(ownerUser, { year: '2026' }),
      ).resolves.toEqual({
        year: '2026',
        holidays: [
          {
            id: HOLIDAY_ID,
            date: '2026-10-02',
            name: 'Gandhi Jayanti',
            description: null,
            scope: 'all',
            officeIds: [],
            employeesOff: 7,
          },
        ],
        offices: [
          { officeId: 'office-1', name: 'Bengaluru', staffCount: 7 },
          { officeId: 'office-2', name: 'Pune', staffCount: 0 },
        ],
        unassignedCount: 2,
        weeklyOffDefaults: [{ valid: '[2026-01-01,)', days: [0, 6] }],
      });

      // The headcounts read is windowed to the viewed year — not the
      // tenant's whole calendar history.
      const headcountRead = txStatements.find((s) =>
        s.sql.includes('as employees_off'),
      );
      expect(headcountRead?.params).toEqual([
        TENANT_ID,
        '2026-01-01',
        '2026-12-31',
      ]);
    });

    it('year 0000 is a 400 — the weekly-off window string would explode in Postgres', async () => {
      const { service } = build();
      await expectErrorCode(
        service.getOverview(ownerUser, { year: '0000' }),
        400,
        ErrorCode.VALIDATION_ERROR,
      );
    });

    it('requires a tenant — 400 before anything runs', async () => {
      const { service } = build();
      await expectErrorCode(
        service.getOverview(noTenantUser, { year: '2026' }),
        400,
        ErrorCode.VALIDATION_ERROR,
      );
    });
  });

  describe('createHoliday', () => {
    const dto = { date: '2026-10-02', name: 'Gandhi Jayanti' };

    it('an all-office holiday inserts no join rows and fans the notification out to every assigned office', async () => {
      const { service, txStatements, notificationRows } = build();

      await expect(
        service.createHoliday(ownerUser, dto),
      ).resolves.toEqual({
        id: HOLIDAY_ID,
        date: '2026-10-02',
        name: 'Gandhi Jayanti',
        description: null,
        scope: 'all',
        officeIds: [],
      });
      expect(
        txStatements.some((s) => s.sql.includes('insert into public.holidays')),
      ).toBe(true);
      expect(
        txStatements.some((s) =>
          s.sql.includes('insert into public.holiday_offices'),
        ),
      ).toBe(false);
      // Future date + gate on → the outbox insert ran.
      expect(notificationRows).toHaveLength(1);
    });

    it('an offices-scoped holiday lands the join rows and answers with its officeIds', async () => {
      const { service, holidayOfficeRows } = build();
      const officeDto = {
        ...dto,
        scope: 'offices',
        officeIds: ['office-1', 'office-2'],
      };

      await expect(service.createHoliday(ownerUser, officeDto)).resolves.toEqual(
        {
          id: HOLIDAY_ID,
          date: '2026-10-02',
          name: 'Gandhi Jayanti',
          description: null,
          scope: 'offices',
          officeIds: ['office-1', 'office-2'],
        },
      );
      expect(holidayOfficeRows).toEqual([['office-1', 'office-2']]);
    });

    it('a past date stays silent — the fan-out never runs', async () => {
      const { service, notificationRows } = build();
      await service.createHoliday(ownerUser, { ...dto, date: '2025-01-01' });
      expect(notificationRows).toHaveLength(0);
    });

    it('a taken date maps 23505 to 409 ATTENDANCE_HOLIDAY_TAKEN', async () => {
      const { service } = build({ writeError: { code: '23505' } });
      await expectErrorCode(
        service.createHoliday(ownerUser, dto),
        409,
        ErrorCode.ATTENDANCE_HOLIDAY_TAKEN,
      );
    });

    it('an unknown office maps 23503 to 400 VALIDATION_ERROR', async () => {
      const { service } = build({ writeError: { code: '23503' } });
      await expectErrorCode(
        service.createHoliday(ownerUser, dto),
        400,
        ErrorCode.VALIDATION_ERROR,
      );
    });

    it('any other write failure maps to 500', async () => {
      const { service } = build({ writeError: { code: 'XX000' } });
      await expectErrorCode(
        service.createHoliday(ownerUser, dto),
        500,
        ErrorCode.INTERNAL_SERVER_ERROR,
      );
    });

    it('requires a tenant — 400 before anything runs', async () => {
      const { service } = build();
      await expectErrorCode(
        service.createHoliday(noTenantUser, dto),
        400,
        ErrorCode.VALIDATION_ERROR,
      );
    });
  });

  describe('updateHoliday', () => {
    const existing = {
      ...BY_ID_ROW,
      holidayDate: '2026-10-05',
      scope: 'offices',
      officeIds: ['office-1'],
    };

    it('a name-only edit rewrites nothing else and stays silent (no fan-out)', async () => {
      const { service, txStatements, notificationRows, holidayOfficeRows } =
        build({ holidayById: [existing] });

      await expect(
        service.updateHoliday(ownerUser, HOLIDAY_ID, { name: 'Diwali' }),
      ).resolves.toEqual({
        id: HOLIDAY_ID,
        date: '2026-10-05',
        name: 'Diwali',
        description: null,
        scope: 'offices',
        officeIds: ['office-1'],
      });
      // No scope/officeIds keys → no applicability rewrite.
      expect(
        txStatements.some((s) =>
          s.sql.includes('delete from public.holiday_offices'),
        ),
      ).toBe(false);
      expect(holidayOfficeRows).toHaveLength(0);
      expect(notificationRows).toHaveLength(0);
    });

    it('a date change on a future holiday fires removed for the old date then added for the new', async () => {
      const { service, notificationRows, txStatements } = build({
        holidayById: [existing],
      });

      await service.updateHoliday(ownerUser, HOLIDAY_ID, {
        date: '2026-10-20',
      });

      expect(notificationRows).toHaveLength(2);
      // The dedupe key carries the holiday DATE — a moved holiday re-notifies
      // instead of being swallowed by the unmoved-date key.
      const insert = txStatements.find((s) =>
        s.sql.includes('insert into public.notifications'),
      );
      expect(insert?.sql).toContain("|| ':' || $4::text");
    });

    it('a scope-only change on an unmoved future holiday fires holiday_added alone', async () => {
      const { service, notificationRows } = build({ holidayById: [existing] });

      await service.updateHoliday(ownerUser, HOLIDAY_ID, {
        scope: 'all',
      });

      expect(notificationRows).toHaveLength(1);
      const [params] = notificationRows;
      expect(params?.[1]).toBe(ATTENDANCE_NOTIFICATION_EVENT.HOLIDAY_ADDED);
      expect(params?.[3]).toBe('2026-10-05');
      // Fail-closed param: scope 'all' — never the fail-open fallback that
      // notified every office when the office list came in empty.
      expect(params?.[6]).toBe(true);
    });

    it('officeIds with scope all is a 400, not a silent discard', async () => {
      const { service } = build({ holidayById: [BY_ID_ROW] });
      await expectErrorCode(
        service.updateHoliday(ownerUser, HOLIDAY_ID, {
          scope: 'all',
          officeIds: ['office-1'],
        }),
        400,
        ErrorCode.VALIDATION_ERROR,
      );
    });

    it('scope offices with a resolved-empty office list is a 400', async () => {
      const { service } = build({ holidayById: [BY_ID_ROW] });
      await expectErrorCode(
        service.updateHoliday(ownerUser, HOLIDAY_ID, { scope: 'offices' }),
        400,
        ErrorCode.VALIDATION_ERROR,
      );
    });

    it('a scope flip rewrites the applicability join rows', async () => {
      const { service, holidayOfficeRows, txStatements } = build({
        holidayById: [existing],
      });

      await service.updateHoliday(ownerUser, HOLIDAY_ID, {
        scope: 'all',
      });

      expect(
        txStatements.some((s) =>
          s.sql.includes('delete from public.holiday_offices'),
        ),
      ).toBe(true);
      // 'all' lands zero join rows — no insert statement at all.
      expect(holidayOfficeRows).toEqual([]);
    });

    it('a vanished row (re-read empty) maps to 404 ATTENDANCE_HOLIDAY_NOT_FOUND', async () => {
      const { service } = build({ holidayById: [] });
      await expectErrorCode(
        service.updateHoliday(ownerUser, HOLIDAY_ID, { name: 'Diwali' }),
        404,
        ErrorCode.ATTENDANCE_HOLIDAY_NOT_FOUND,
      );
    });

    it('an edit onto a taken date maps 23505 to 409', async () => {
      const { service } = build({
        holidayById: [existing],
        writeError: { code: '23505' },
      });
      await expectErrorCode(
        service.updateHoliday(ownerUser, HOLIDAY_ID, { date: '2026-11-01' }),
        409,
        ErrorCode.ATTENDANCE_HOLIDAY_TAKEN,
      );
    });

    it('requires a tenant — 400 before anything runs', async () => {
      const { service } = build();
      await expectErrorCode(
        service.updateHoliday(noTenantUser, HOLIDAY_ID, { name: 'X' }),
        400,
        ErrorCode.VALIDATION_ERROR,
      );
    });
  });

  describe('removeHoliday', () => {
    it('deletes and fans the removal out for a future holiday', async () => {
      const { service, notificationRows } = build({
        holidayById: [BY_ID_ROW],
      });

      await expect(
        service.removeHoliday(ownerUser, HOLIDAY_ID),
      ).resolves.toBeNull();
      expect(notificationRows).toHaveLength(1);
    });

    it('maps a vanished row (rowCount 0) to 404 ATTENDANCE_HOLIDAY_NOT_FOUND', async () => {
      const { service } = build({ holidayById: [] });
      await expectErrorCode(
        service.removeHoliday(ownerUser, HOLIDAY_ID),
        404,
        ErrorCode.ATTENDANCE_HOLIDAY_NOT_FOUND,
      );
    });

    it('requires a tenant — 400 before anything runs', async () => {
      const { service } = build();
      await expectErrorCode(
        service.removeHoliday(noTenantUser, HOLIDAY_ID),
        400,
        ErrorCode.VALIDATION_ERROR,
      );
    });
  });

  describe('getImpact', () => {
    it('serves the console panel: the holiday, per-office closed flags and the shipped affectedEmployees', async () => {
      const { service } = build({
        holidayOn: [SCOPED_ROW],
        approvedLeave: [
          { employee_id: 'emp-1', employee_name: 'Ravi Kumar' },
        ],
        tracked: 9,
        unassigned: 1,
        officeCounts: [
          { office_id: 'office-1', name: 'Bengaluru', staff_count: 7 },
          { office_id: 'office-2', name: 'Pune', staff_count: 3 },
        ],
        members: [
          {
            user_id: 'emp-1',
            role: 'employee',
            status: 'active',
            employee_code: 'E-1',
            created_at: '2026-09-01T00:00:00Z',
            users: {
              name: 'Ravi Kumar',
              country_code: '+91',
              phone_number: '9000000001',
              disabled: false,
              avatar_key: 'avatars/emp-1/p.jpg',
            },
          },
        ],
      });

      await expect(service.getImpact(ownerUser, { date: '2026-10-02' })).resolves.toEqual(
        {
          date: '2026-10-02',
          affectedEmployees: [
            {
              employeeId: 'emp-1',
              employeeName: 'Ravi Kumar',
              avatarUrl: 'https://signed.example/avatars/emp-1/p.jpg',
            },
          ],
          holiday: {
            id: HOLIDAY_ID,
            date: '2026-10-02',
            name: 'Gandhi Jayanti',
            description: null,
            scope: 'all',
            officeIds: [],
          },
          approvedLeaveCount: 1,
          trackedCount: 9,
          perOffice: [
            // scope 'all' closes every office.
            { officeId: 'office-1', name: 'Bengaluru', staffCount: 7, closed: true },
            { officeId: 'office-2', name: 'Pune', staffCount: 3, closed: true },
          ],
          unassignedCount: 1,
        },
      );
    });

    it('a plain date answers holiday null with no office closed — 200, never a 404', async () => {
      const { service } = build({
        holidayOn: [],
        officeCounts: [
          { office_id: 'office-1', name: 'Bengaluru', staff_count: 7 },
        ],
      });

      await expect(
        service.getImpact(ownerUser, { date: '2030-01-01' }),
      ).resolves.toEqual({
        date: '2030-01-01',
        affectedEmployees: [],
        holiday: null,
        approvedLeaveCount: 0,
        trackedCount: 0,
        perOffice: [
          { officeId: 'office-1', name: 'Bengaluru', staffCount: 7, closed: false },
        ],
        unassignedCount: 0,
      });
    });

    it('requires a tenant — 400 before anything runs', async () => {
      const { service } = build();
      await expectErrorCode(
        service.getImpact(noTenantUser, { date: '2026-10-02' }),
        400,
        ErrorCode.VALIDATION_ERROR,
      );
    });

    it('an unknown tenant maps the PT404 hint to 404 ATTENDANCE_TENANT_NOT_FOUND — the dropped RPC contract lives on', async () => {
      const { service, rpc } = build();
      rpc.mockResolvedValueOnce({
        data: null,
        error: { code: 'PT404', hint: 'ATTENDANCE_TENANT_NOT_FOUND' },
      } as unknown as { data: string; error: null });
      await expectErrorCode(
        service.getImpact(ownerUser, { date: '2026-10-02' }),
        404,
        ErrorCode.ATTENDANCE_TENANT_NOT_FOUND,
      );
    });
  });

  it('is injectable with the supabase factory, storage and the pg pool', () => {
    const { service } = build();
    expect(service).toBeDefined();
  });
});
