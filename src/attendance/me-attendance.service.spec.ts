import 'reflect-metadata';
import { InternalServerErrorException } from '@nestjs/common';
import { MeAttendanceService } from './me-attendance.service';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import { EMPTY_ME_SUMMARY } from './me-summary.model';

/**
 * MeAttendanceService (15-7): the AD-17 access read and FR-4's
 * once-per-employee onboarding record; 15-10 adds the FR-4 summary
 * (GET /attendance/me/summary). Tester stance: the JWT is the only
 * identity source, a broken view read fails loud, and a replay of the
 * onboarding POST returns the ORIGINAL timestamp. The summary must read
 * the SAME view row me/access reads (anchor included), answer honestly
 * empty for none/history_only with zero extra reads, and fail loud (never
 * fabricate) on any read error.
 */

const tech: RequestUser = {
  userId: 'tech-uuid',
  tenantId: 'tenant-uuid',
  role: Role.TECHNICIAN,
  rawJwt: 'mock-jwt',
};

function serviceWith(admin: Record<string, unknown>) {
  const factory = {
    createAdmin: () => admin,
  } as unknown as SupabaseClientFactory;
  return new MeAttendanceService(factory);
}

function accessQb(result: { data: unknown; error: unknown }) {
  const qb: Record<string, jest.Mock> = {};
  for (const m of ['select', 'eq']) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.maybeSingle = jest.fn().mockResolvedValue(result);
  return qb;
}

/** Terminal `.returns()` list-read qb (rules / weekly-off tables). */
function listQb(result: { data: unknown; error: unknown }) {
  const qb: Record<string, jest.Mock> = {};
  for (const m of ['select', 'eq']) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.returns = jest.fn().mockResolvedValue(result);
  return qb;
}

type ReadResult = { data: unknown; error: unknown };

/**
 * An admin mock shaped for getSummary: one qb per table (the service
 * resolves the rule + override + default reads concurrently via
 * Promise.all) plus the attendance_today RPC. Kept references let the
 * failure-path tests assert WHO was (never) asked.
 */
function summaryAdmin(parts: {
  view: ReadResult;
  rules?: ReadResult;
  overrides?: ReadResult;
  defaults?: ReadResult;
  today?: ReadResult;
}) {
  const viewQb = accessQb(parts.view);
  const rulesQb = listQb(parts.rules ?? { data: [], error: null });
  const overridesQb = listQb(parts.overrides ?? { data: [], error: null });
  const defaultsQb = listQb(parts.defaults ?? { data: [], error: null });
  const from = jest.fn((table: string) => {
    switch (table) {
      case 'attendance_access_state':
        return viewQb;
      case 'attendance_office_rules':
        return rulesQb;
      case 'attendance_weekly_off_overrides':
        return overridesQb;
      case 'attendance_weekly_off_defaults':
        return defaultsQb;
      default:
        throw new Error(`unexpected table read: ${table}`);
    }
  });
  const rpc = jest.fn(() => parts.today ?? { data: null, error: null });
  return {
    admin: { from, rpc },
    viewQb,
    rulesQb,
    overridesQb,
    defaultsQb,
    from,
    rpc,
  };
}

/** Unwraps a rejection so the pinned error-code BODY can be asserted. */
async function rejectionOf(
  run: () => Promise<unknown>,
): Promise<InternalServerErrorException> {
  try {
    await run();
  } catch (err) {
    return err as InternalServerErrorException;
  }
  throw new Error('expected the promise to reject');
}

describe('MeAttendanceService (story 15-7)', () => {
  describe('GET access', () => {
    it('reads the view by the JWT subject only (no client-supplied ids)', async () => {
      const qb = accessQb({
        data: {
          user_id: 'tech-uuid',
          tenant_id: 'tenant-uuid',
          attendance_enabled: true,
          access_state: 'upcoming',
          attendance_start_date: '2026-11-01',
          enabled_at: null,
          onboarded_at: null,
          office_id: 'office-1',
          office_name: 'Thane',
        },
        error: null,
      });
      const from = jest.fn(() => qb);
      const service = serviceWith({ from });

      const result = await service.getAccess(tech);

      expect(qb.eq).toHaveBeenCalledWith('user_id', 'tech-uuid');
      expect(result).toEqual({
        attendanceEnabled: true,
        attendanceAccess: 'upcoming',
        attendanceStartDate: '2026-11-01',
        enabledAt: null,
        onboardedAt: null,
        officeId: 'office-1',
        officeName: 'Thane',
      });
    });

    it('fails loud (500) when the view read errors — never a fabricated state', async () => {
      const service = serviceWith({
        from: () => accessQb({ data: null, error: { message: 'boom' } }),
      });
      await expect(service.getAccess(tech)).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });

    it('fails loud (500) when the view returns no row for a technician', async () => {
      const service = serviceWith({
        from: () => accessQb({ data: null, error: null }),
      });
      await expect(service.getAccess(tech)).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
  });

  describe('POST onboarding', () => {
    it('upserts once and reads the recorded timestamp back', async () => {
      const upsert = jest.fn().mockReturnValue({
        // ignoreDuplicates chain — no select awaited here.
      });
      const selectQb: Record<string, jest.Mock> = {};
      for (const m of ['select', 'eq']) {
        selectQb[m] = jest.fn().mockReturnValue(selectQb);
      }
      selectQb.single = jest
        .fn()
        .mockResolvedValue({ data: { onboarded_at: '2026-09-28T04:00:00+00:00' }, error: null });
      const from = jest.fn((table: string) =>
        table === 'attendance_onboarding'
          ? {
              upsert,
              select: selectQb.select,
              eq: selectQb.eq,
              single: selectQb.single,
            }
          : {},
      );
      const service = serviceWith({ from });

      const result = await service.markOnboarded(tech);

      expect(upsert).toHaveBeenCalledWith(
        { employee_id: 'tech-uuid', tenant_id: 'tenant-uuid' },
        { onConflict: 'employee_id', ignoreDuplicates: true },
      );
      expect(result).toEqual({ onboardedAt: '2026-09-28T04:00:00+00:00' });
    });
  });

  describe('GET summary (15-10)', () => {
    // A summarisable view row as the admin client returns it (snake_case).
    const summarisableRow = {
      user_id: 'tech-uuid',
      tenant_id: 'tenant-uuid',
      attendance_enabled: true,
      access_state: 'active',
      attendance_start_date: '2026-01-01',
      enabled_at: '2026-01-01T04:00:00+00:00',
      onboarded_at: null,
      office_id: 'office-1',
      office_name: 'Thane',
    };
    const coveringRule = {
      id: 'rule-1',
      valid: '[2026-03-05,)',
      start_time: '09:30:00',
      end_time: '18:00:00',
      late_cutoff_minutes: 15,
    };
    const sundayDefault = { valid: '[2026-01-01,)', days: [7] };

    it.each(['none', 'history_only'])(
      '%s answers the honest EMPTY_ME_SUMMARY with ZERO additional reads',
      async (state) => {
        const parts = summaryAdmin({
          view: { data: { ...summarisableRow, access_state: state }, error: null },
        });
        const service = serviceWith(parts.admin);

        await expect(service.getSummary(tech)).resolves.toEqual(
          EMPTY_ME_SUMMARY,
        );

        // Only the view read happened — no anchor RPC, no rule/weekly-off
        // reads for states the endpoint is not defined for.
        expect(parts.from).toHaveBeenCalledTimes(1);
        expect(parts.from).toHaveBeenCalledWith('attendance_access_state');
        expect(parts.rpc).not.toHaveBeenCalled();
      },
    );

    it('upcoming: the anchor IS attendance_start_date — attendance_today is never resolved', async () => {
      const parts = summaryAdmin({
        view: {
          data: {
            ...summarisableRow,
            access_state: 'upcoming',
            attendance_start_date: '2026-11-01',
          },
          error: null,
        },
        // Covers the start date (1 Nov) but NOT the RPC-less today — if the
        // anchor were anything else, the rule pick would come back empty.
        rules: { data: [{ ...coveringRule, valid: '[2026-11-01,)' }], error: null },
        defaults: { data: [sundayDefault], error: null },
      });
      const service = serviceWith(parts.admin);

      const result = await service.getSummary(tech);

      expect(parts.rpc).not.toHaveBeenCalled();
      expect(parts.from).toHaveBeenCalledWith('attendance_office_rules');
      expect(parts.from).toHaveBeenCalledWith('attendance_weekly_off_overrides');
      expect(parts.from).toHaveBeenCalledWith('attendance_weekly_off_defaults');
      // Rules are office-scoped and employee overrides are employee-scoped.
      expect(parts.rulesQb.eq).toHaveBeenCalledWith('office_id', 'office-1');
      expect(parts.overridesQb.eq).toHaveBeenCalledWith(
        'employee_id',
        'tech-uuid',
      );
      expect(parts.defaultsQb.eq).not.toHaveBeenCalledWith(
        'employee_id',
        expect.anything(),
      );
      expect(result).toEqual({
        officeId: 'office-1',
        officeName: 'Thane',
        startTime: '09:30',
        endTime: '18:00',
        lateCutOffMinutes: 15,
        weeklyOffDays: [7],
      });
    });

    it('active: the anchor is the tenant date from attendance_today, not attendance_start_date', async () => {
      const parts = summaryAdmin({
        view: { data: summarisableRow, error: null }, // start date 2026-01-01
        // Covers 2026-03-10 (the resolved today) but NOT 2026-01-01 — the
        // response proves which date anchored the pick.
        rules: { data: [coveringRule], error: null },
        today: { data: '2026-03-10', error: null },
      });
      const service = serviceWith(parts.admin);

      const result = await service.getSummary(tech);

      expect(parts.rpc).toHaveBeenCalledWith('attendance_today', {
        p_tenant_id: 'tenant-uuid',
      });
      expect(result).toEqual({
        officeId: 'office-1',
        officeName: 'Thane',
        startTime: '09:30',
        endTime: '18:00',
        lateCutOffMinutes: 15,
        weeklyOffDays: [],
      });
    });

    it('office_id null on a summarisable row skips the rule read but still computes weekly offs', async () => {
      const parts = summaryAdmin({
        view: {
          data: { ...summarisableRow, office_id: null, office_name: null },
          error: null,
        },
        rules: { data: [coveringRule], error: null },
        defaults: { data: [sundayDefault], error: null },
        today: { data: '2026-03-10', error: null },
      });
      const service = serviceWith(parts.admin);

      const result = await service.getSummary(tech);

      expect(parts.from).not.toHaveBeenCalledWith('attendance_office_rules');
      expect(result).toEqual({
        officeId: null,
        officeName: null,
        startTime: null,
        endTime: null,
        lateCutOffMinutes: null,
        weeklyOffDays: [7],
      });
    });

    it('weekly-off precedence through the service: covering override replaces the default (sorted), else default, else []', async () => {
      const summaryWith = async (
        overrides: ReadResult,
        defaults: ReadResult,
      ) => {
        const parts = summaryAdmin({
          view: { data: summarisableRow, error: null },
          overrides,
          defaults,
          today: { data: '2026-03-10', error: null },
        });
        const service = serviceWith(parts.admin);
        return (await service.getSummary(tech)).weeklyOffDays;
      };

      expect(
        await summaryWith(
          { data: [{ valid: '[2026-01-01,)', days: [3, 1] }], error: null },
          { data: [sundayDefault], error: null },
        ),
      ).toEqual([1, 3]);
      expect(
        await summaryWith(
          { data: [{ valid: '[2027-01-01,)', days: [2] }], error: null },
          { data: [sundayDefault], error: null },
        ),
      ).toEqual([7]);
      expect(
        await summaryWith(
          { data: [], error: null },
          { data: [], error: null },
        ),
      ).toEqual([]);
    });

    it('fails loud (500, pinned body) when the view read errors', async () => {
      const service = serviceWith(
        summaryAdmin({ view: { data: null, error: { message: 'boom' } } })
          .admin,
      );
      const err = await rejectionOf(() => service.getSummary(tech));
      expect(err).toBeInstanceOf(InternalServerErrorException);
      expect(err.getResponse()).toMatchObject({
        message: 'Failed to read access state',
      });
    });

    it('fails loud (500) when the view returns no row — never fabricate a summary', async () => {
      const service = serviceWith(
        summaryAdmin({ view: { data: null, error: null } }).admin,
      );
      const err = await rejectionOf(() => service.getSummary(tech));
      expect(err).toBeInstanceOf(InternalServerErrorException);
      expect(err.getResponse()).toMatchObject({
        message: 'Failed to read access state',
      });
    });

    it.each([
      ['rules', (parts: ReturnType<typeof summaryAdmin>) => parts.rulesQb],
      [
        'weekly-off overrides',
        (parts: ReturnType<typeof summaryAdmin>) => parts.overridesQb,
      ],
      [
        'weekly-off defaults',
        (parts: ReturnType<typeof summaryAdmin>) => parts.defaultsQb,
      ],
    ])(
      'fails loud (500, "Failed to read attendance summary") when the %s read errors',
      async (_label, failing) => {
        const parts = summaryAdmin({
          view: { data: summarisableRow, error: null },
          rules: { data: [coveringRule], error: { message: 'boom' } },
          overrides: { data: [], error: { message: 'boom' } },
          defaults: { data: [sundayDefault], error: { message: 'boom' } },
          today: { data: '2026-03-10', error: null },
        });
        // Only ONE table errors per run — the others must not mask it.
        for (const qb of [parts.rulesQb, parts.overridesQb, parts.defaultsQb]) {
          qb.returns.mockReset();
          qb.returns.mockResolvedValue({ data: [], error: null });
        }
        failing(parts).returns.mockResolvedValue({
          data: null,
          error: { message: 'boom' },
        });
        const service = serviceWith(parts.admin);

        const err = await rejectionOf(() => service.getSummary(tech));
        expect(err).toBeInstanceOf(InternalServerErrorException);
        expect(err.getResponse()).toMatchObject({
          message: 'Failed to read attendance summary',
        });
      },
    );

    it('a failing attendance_today (active anchor) propagates as 500 — never a wrong-date rule pick', async () => {
      const parts = summaryAdmin({
        view: { data: summarisableRow, error: null },
        today: { data: null, error: { message: 'boom' } },
      });
      const service = serviceWith(parts.admin);

      const err = await rejectionOf(() => service.getSummary(tech));
      expect(err).toBeInstanceOf(InternalServerErrorException);
      expect(err.getResponse()).toMatchObject({
        message: 'Failed to resolve tenant date',
      });
      expect(parts.from).not.toHaveBeenCalledWith('attendance_office_rules');
    });
  });
});
