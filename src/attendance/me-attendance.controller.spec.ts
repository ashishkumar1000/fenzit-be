import 'reflect-metadata';
import { MeAttendanceController } from './me-attendance.controller';
import { MeAttendanceService } from './me-attendance.service';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import { ROLES_KEY } from '../common/decorators/roles.decorator';

/**
 * Route wiring for the technician-facing attendance reads (15-7 + 15-10).
 * Mirror of attendance.controller.spec.ts's reflection style: the summary
 * route's existence, verb, delegation and the TECHNICIAN-only guard are
 * pinned via metadata so a silent refactor cannot drop them.
 */

// Nest route metadata keys (mirror of @nestjs/common/constants — imported
// values, not literals, per the attendance.controller.spec.ts style).
const PATH_METADATA = 'path';
const METHOD_METADATA = 'method';
const HTTP_CODE_METADATA = '__httpCode__';

const tech: RequestUser = {
  userId: 'tech-uuid',
  tenantId: 'tenant-uuid',
  role: Role.TECHNICIAN,
  rawJwt: 'mock-jwt',
};

const summary = {
  officeId: 'office-1',
  officeName: 'Thane',
  startTime: '09:30',
  endTime: '18:00',
  lateCutOffMinutes: 15,
  weeklyOffDays: [7],
};

describe('MeAttendanceController — technician reads (stories 15-7 / 15-10)', () => {
  function controllerWith(service: Partial<MeAttendanceService>) {
    return new MeAttendanceController(
      service as unknown as MeAttendanceService,
    );
  }

  describe('delegation', () => {
    it('getSummary passes the current user straight through (the JWT is the only identity source)', async () => {
      const getSummary = jest.fn().mockResolvedValue(summary);
      const controller = controllerWith({ getSummary });

      await expect(controller.getSummary(tech)).resolves.toBe(summary);
      expect(getSummary).toHaveBeenCalledWith(tech);
    });

    it('getAccess passes the current user straight through', async () => {
      const access = { attendanceAccess: 'active' };
      const getAccess = jest.fn().mockResolvedValue(access);
      const controller = controllerWith({ getAccess });

      await expect(controller.getAccess(tech)).resolves.toBe(access);
      expect(getAccess).toHaveBeenCalledWith(tech);
    });

    it('markOnboarded passes the current user straight through', async () => {
      const markOnboarded = jest
        .fn()
        .mockResolvedValue({ onboardedAt: '2026-09-28T04:00:00+00:00' });
      const controller = controllerWith({ markOnboarded });

      await expect(controller.markOnboarded(tech)).resolves.toEqual({
        onboardedAt: '2026-09-28T04:00:00+00:00',
      });
      expect(markOnboarded).toHaveBeenCalledWith(tech);
    });
  });

  describe('route metadata', () => {
    it('is mounted at attendance/me', () => {
      expect(
        Reflect.getMetadata(PATH_METADATA, MeAttendanceController),
      ).toBe('attendance/me');
    });

    it.each([
      ['getAccess', 'access', 0], // 0 = RequestMethod.GET
      ['getSummary', 'summary', 0], // GET /attendance/me/summary — the 15-10 route
      ['markOnboarded', 'onboarding', 1], // 1 = RequestMethod.POST
    ])(
      '%s is wired as %s',
      (handler: keyof MeAttendanceController, path: string, method: number) => {
        const target = MeAttendanceController.prototype[handler] as object;
        expect(Reflect.getMetadata(PATH_METADATA, target)).toBe(path);
        expect(Reflect.getMetadata(METHOD_METADATA, target)).toBe(method);
      },
    );

    it.each(['getAccess', 'getSummary', 'markOnboarded'])(
      '%s is technician-only — any other role must never reach the technician reads',
      (handler: keyof MeAttendanceController) => {
        const roles = Reflect.getMetadata(
          ROLES_KEY,
          MeAttendanceController.prototype[handler] as object,
        ) as Role[] | undefined;

        expect(roles).toEqual([Role.TECHNICIAN]);
      },
    );

    it.each(['getAccess', 'getSummary', 'markOnboarded'])(
      '%s carries a fixed @HttpCode(200)',
      (handler: keyof MeAttendanceController) => {
        expect(
          Reflect.getMetadata(
            HTTP_CODE_METADATA,
            MeAttendanceController.prototype[handler] as object,
          ),
        ).toBe(200);
      },
    );
  });
});
