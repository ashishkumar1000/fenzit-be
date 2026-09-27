import 'reflect-metadata';
import { InternalServerErrorException } from '@nestjs/common';
import { MeAttendanceService } from './me-attendance.service';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';

/**
 * MeAttendanceService (15-7): the AD-17 access read and FR-4's
 * once-per-employee onboarding record. Tester stance: the JWT is the only
 * identity source, a broken view read fails loud, and a replay of the
 * onboarding POST returns the ORIGINAL timestamp.
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
});
