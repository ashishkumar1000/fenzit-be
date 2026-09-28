import 'reflect-metadata';
import { HttpException } from '@nestjs/common';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { MeAttendanceController } from './me-attendance.controller';
import { MeAttendanceService } from './me-attendance.service';
import { CheckInOutService } from './check-in-out.service';
import { CheckInOutDto } from './dto/check-in-out.dto';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import { ROLES_KEY } from '../common/decorators/roles.decorator';

// Nest route-params metadata (mirror of @nestjs/common/constants — set by
// the parameter decorators on the CLASS, keyed by method name).
const ROUTE_ARGS_METADATA = '__routeArguments__';

/**
 * Route wiring for the technician-facing attendance reads (15-7 + 15-10)
 * and the 16-1/16-2 check-in/out routes. Mirror of
 * attendance.controller.spec.ts's reflection style: each route's
 * existence, verb, delegation and the TECHNICIAN-only guard are pinned
 * via metadata so a silent refactor cannot drop them.
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

describe('MeAttendanceController — technician reads + check-in/out (15-7/15-10/16-1/16-2)', () => {
  function controllerWith(
    service: Partial<MeAttendanceService>,
    checkInOut: Partial<CheckInOutService> = {},
  ) {
    return new MeAttendanceController(
      service as unknown as MeAttendanceService,
      checkInOut as unknown as CheckInOutService,
    );
  }

  const validKey = '99999999-9999-4999-8999-999999999999';
  const fixDto = Object.assign(new CheckInOutDto(), {
    latitude: 19.076,
    longitude: 72.8777,
    accuracyM: 8,
    fixAgeMs: 500,
  });

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

    it('checkIn delegates user + validated key + body to the service', async () => {
      const checkIn = jest.fn().mockResolvedValue({ workDate: '2026-09-28' });
      const controller = controllerWith({}, { checkIn });

      await expect(
        controller.checkIn(tech, validKey, fixDto),
      ).resolves.toEqual({ workDate: '2026-09-28' });
      expect(checkIn).toHaveBeenCalledWith(tech, fixDto, validKey);
    });

    it('checkOut delegates user + validated key + body to the service', async () => {
      const checkOut = jest.fn().mockResolvedValue({ workedMinutes: 480 });
      const controller = controllerWith({}, { checkOut });

      await expect(
        controller.checkOut(tech, validKey, fixDto),
      ).resolves.toEqual({ workedMinutes: 480 });
      expect(checkOut).toHaveBeenCalledWith(tech, fixDto, validKey);
    });
  });

  describe('AD-6 idempotency-key gate (16-1)', () => {
    it.each([
      ['missing', undefined],
      ['empty', ''],
      ['not a uuid', 'tap-42'],
      ['uuid v1 (wrong version)', 'a9d1f3b2-1c4d-11ef-9cd2-0242ac120002'],
    ])('%s key is a 422 with no service call', (_label, key) => {
      const checkIn = jest.fn();
      const controller = controllerWith({}, { checkIn });

      // The guard throws synchronously, before a promise exists.
      let err: unknown;
      try {
        controller.checkIn(tech, key as string | undefined, fixDto);
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(422);
      expect(
        ((err as HttpException).getResponse() as Record<string, unknown>)[
          'error_code'
        ],
      ).toBe('VALIDATION_ERROR');
      expect(checkIn).not.toHaveBeenCalled();
    });

    it.each([
      ['lower-case v4', 'f47ac10b-58cc-4372-a567-0e02b2c3d479'],
      ['upper-case v4', 'F47AC10B-58CC-4372-A567-0E02B2C3D479'],
    ])('a valid %s passes through', async (_label, key) => {
      const checkOut = jest.fn().mockResolvedValue({});
      const controller = controllerWith({}, { checkOut });

      await controller.checkOut(tech, key, fixDto);
      expect(checkOut).toHaveBeenCalledWith(tech, fixDto, key);
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
      ['checkIn', 'check-in', 1], // POST /attendance/me/check-in — 16-1
      ['checkOut', 'check-out', 1], // POST /attendance/me/check-out — 16-2
    ])(
      '%s is wired as %s',
      (handler: keyof MeAttendanceController, path: string, method: number) => {
        const target = MeAttendanceController.prototype[handler] as object;
        expect(Reflect.getMetadata(PATH_METADATA, target)).toBe(path);
        expect(Reflect.getMetadata(METHOD_METADATA, target)).toBe(method);
      },
    );

    it.each([
      'getAccess',
      'getSummary',
      'markOnboarded',
      'checkIn',
      'checkOut',
    ])(
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

    it.each(['checkIn', 'checkOut'])(
      '%s carries the AD-4 fixed @HttpCode(201)',
      (handler: keyof MeAttendanceController) => {
        expect(
          Reflect.getMetadata(
            HTTP_CODE_METADATA,
            MeAttendanceController.prototype[handler] as object,
          ),
        ).toBe(201);
      },
    );

    it.each(['checkIn', 'checkOut'])(
      '%s binds its body with @Body() — an undecorated parameter arrives undefined over HTTP (review-found: the routes were dead wire-level until this was pinned)',
      (handler: keyof MeAttendanceController) => {
        const args = Reflect.getMetadata(
          ROUTE_ARGS_METADATA,
          MeAttendanceController,
          handler,
        ) as Record<string, { index: number }> | undefined;
        // RouteParamtypes.BODY by runtime value (the enum numbering is an
        // internal — never hardcode the number).
        const bodyKey = `${RouteParamtypes.BODY}:2`;
        expect(args?.[bodyKey]).toBeDefined();
        expect(args?.[bodyKey].index).toBe(2); // (user, idempotencyKey, dto)
      },
    );
  });
});
