import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { WeeklyOffsController } from './weekly-offs.controller';
import { WeeklyOffsService } from './weekly-offs.service';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { ErrorCode } from '../common/enums/error-code.enum';

// Nest route metadata keys (mirror of @nestjs/common/constants values).
const PATH_METADATA = 'path';
const METHOD_METADATA = 'method';
const HTTP_CODE_METADATA = '__httpCode__';

const EMPLOYEE_ID = '00000000-0000-4000-8000-0000000000e5';

const overrideResponse = {
  employeeId: EMPLOYEE_ID,
  employeeName: 'Ravi Kumar',
  current: null,
  next: null,
};

describe('WeeklyOffsController (story 15-5)', () => {
  const user: RequestUser = {
    userId: 'owner-uuid',
    tenantId: 'tenant-uuid',
    role: Role.OWNER,
    rawJwt: 'mock-jwt',
  };

  function controllerWith(service: Partial<WeeklyOffsService>) {
    return new WeeklyOffsController(service as unknown as WeeklyOffsService);
  }

  describe('delegation', () => {
    it('getWeeklyOffs passes the user', async () => {
      const getWeeklyOffs = jest.fn().mockResolvedValue({ default: null, next: null, history: [] });
      const controller = controllerWith({ getWeeklyOffs });

      await expect(controller.getWeeklyOffs(user)).resolves.toEqual({
        default: null,
        next: null,
        history: [],
      });
      expect(getWeeklyOffs).toHaveBeenCalledWith(user);
    });

    it('setWeeklyOffDefault passes the user and the parsed dto', async () => {
      const setWeeklyOffDefault = jest.fn().mockResolvedValue({ default: null, next: null, history: [] });
      const controller = controllerWith({ setWeeklyOffDefault });
      const dto = { days: [6, 7] };

      await controller.setWeeklyOffDefault(user, dto);
      expect(setWeeklyOffDefault).toHaveBeenCalledWith(user, dto);
    });

    it('listOverrides passes the user', async () => {
      const listOverrides = jest.fn().mockResolvedValue([overrideResponse]);
      const controller = controllerWith({ listOverrides });

      await expect(controller.listOverrides(user)).resolves.toEqual([overrideResponse]);
      expect(listOverrides).toHaveBeenCalledWith(user);
    });

    it('setOverride passes the user, the param and the parsed dto', async () => {
      const setOverride = jest.fn().mockResolvedValue(overrideResponse);
      const controller = controllerWith({ setOverride });
      const dto = { days: [5] };

      await controller.setOverride(user, EMPLOYEE_ID, dto);
      expect(setOverride).toHaveBeenCalledWith(user, EMPLOYEE_ID, dto);
    });

    it('removeOverride passes the user, the param and the parsed query', async () => {
      const removeOverride = jest.fn().mockResolvedValue(overrideResponse);
      const controller = controllerWith({ removeOverride });
      const query = { effectiveFrom: '2026-10-05' };

      await controller.removeOverride(user, EMPLOYEE_ID, query);
      expect(removeOverride).toHaveBeenCalledWith(user, EMPLOYEE_ID, query);
    });
  });

  describe('malformed employee id guard', () => {
    it('setOverride rejects a non-uuid :employeeId with 400 before the service', () => {
      const setOverride = jest.fn();
      const controller = controllerWith({ setOverride });

      // The id guard throws synchronously (before any promise exists).
      let err: unknown;
      try {
        controller.setOverride(user, 'not-a-uuid', { days: [5] } as never);
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        error_code: ErrorCode.VALIDATION_ERROR,
      });
      expect(setOverride).not.toHaveBeenCalled();
    });

    it('removeOverride rejects a non-uuid :employeeId with 400 before the service', () => {
      const removeOverride = jest.fn();
      const controller = controllerWith({ removeOverride });

      // The id guard throws synchronously (before any promise exists).
      expect(() => controller.removeOverride(user, '../../etc', {})).toThrow(
        BadRequestException,
      );
      expect(removeOverride).not.toHaveBeenCalled();
    });
  });

  describe('route metadata', () => {
    it('is mounted at attendance/weekly-offs', () => {
      expect(Reflect.getMetadata(PATH_METADATA, WeeklyOffsController)).toBe(
        'attendance/weekly-offs',
      );
    });

    it.each([
      // 0 = GET, 2 = PUT, 3 = DELETE
      ['getWeeklyOffs', '/', 0],
      ['setWeeklyOffDefault', '/', 2],
      ['listOverrides', 'overrides', 0],
      ['setOverride', 'overrides/:employeeId', 2],
      ['removeOverride', 'overrides/:employeeId', 3],
    ])(
      '%s is wired as %s',
      (handler: keyof WeeklyOffsController, path: string, method: number) => {
        const proto = WeeklyOffsController.prototype[handler] as object;
        expect(Reflect.getMetadata(PATH_METADATA, proto)).toBe(path);
        expect(Reflect.getMetadata(METHOD_METADATA, proto)).toBe(method);
      },
    );

    it.each([
      'getWeeklyOffs',
      'setWeeklyOffDefault',
      'listOverrides',
      'setOverride',
      'removeOverride',
    ])(
      '%s is owner-only — weekly-off management never opens to a technician',
      (handler: keyof WeeklyOffsController) => {
        const roles = Reflect.getMetadata(
          ROLES_KEY,
          WeeklyOffsController.prototype[handler] as object,
        ) as Role[] | undefined;

        expect(roles).toEqual([Role.OWNER]);
      },
    );

    it.each([
      ['getWeeklyOffs', 200],
      ['setWeeklyOffDefault', 200],
      ['listOverrides', 200],
      ['setOverride', 200],
      ['removeOverride', 200],
    ])('%s carries a fixed @HttpCode(%i)', (handler: keyof WeeklyOffsController, code: number) => {
      expect(
        Reflect.getMetadata(
          HTTP_CODE_METADATA,
          WeeklyOffsController.prototype[handler] as object,
        ),
      ).toBe(code);
    });
  });
});
