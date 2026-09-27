import 'reflect-metadata';
import { BadRequestException, HttpException } from '@nestjs/common';
import { HolidaysController } from './holidays.controller';
import { HolidaysService } from './holidays.service';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { ErrorCode } from '../common/enums/error-code.enum';

// Nest route metadata keys (mirror of @nestjs/common/constants values).
const PATH_METADATA = 'path';
const METHOD_METADATA = 'method';
const HTTP_CODE_METADATA = '__httpCode__';

const HOLIDAY_ID = '00000000-0000-4000-8000-0000000000e6';

const holiday = { id: HOLIDAY_ID, date: '2026-10-02', name: 'Gandhi Jayanti' };

describe('HolidaysController (story 15-5)', () => {
  const user: RequestUser = {
    userId: 'owner-uuid',
    tenantId: 'tenant-uuid',
    role: Role.OWNER,
    rawJwt: 'mock-jwt',
  };

  function controllerWith(service: Partial<HolidaysService>) {
    return new HolidaysController(service as unknown as HolidaysService);
  }

  describe('delegation', () => {
    it('listHolidays passes the user', async () => {
      const listHolidays = jest.fn().mockResolvedValue([holiday]);
      const controller = controllerWith({ listHolidays });

      await expect(controller.listHolidays(user)).resolves.toEqual([holiday]);
      expect(listHolidays).toHaveBeenCalledWith(user);
    });

    it('getImpact passes the user and the parsed query', async () => {
      const getImpact = jest.fn().mockResolvedValue({ date: '2026-10-02', affectedEmployees: [] });
      const controller = controllerWith({ getImpact });
      const query = { date: '2026-10-02' };

      await expect(controller.getImpact(user, query)).resolves.toEqual({
        date: '2026-10-02',
        affectedEmployees: [],
      });
      expect(getImpact).toHaveBeenCalledWith(user, query);
    });

    it('createHoliday passes the user and the parsed dto', async () => {
      const createHoliday = jest.fn().mockResolvedValue(holiday);
      const controller = controllerWith({ createHoliday });
      const dto = { date: '2026-10-02', name: 'Gandhi Jayanti' };

      await expect(controller.createHoliday(user, dto)).resolves.toEqual(holiday);
      expect(createHoliday).toHaveBeenCalledWith(user, dto);
    });

    it('updateHoliday passes the user, the param and the parsed dto', async () => {
      const updateHoliday = jest.fn().mockResolvedValue({ ...holiday, name: 'Diwali' });
      const controller = controllerWith({ updateHoliday });
      const dto = { name: 'Diwali' };

      await expect(
        controller.updateHoliday(user, HOLIDAY_ID, { body: {} }, dto),
      ).resolves.toEqual({ ...holiday, name: 'Diwali' });
      expect(updateHoliday).toHaveBeenCalledWith(user, HOLIDAY_ID, dto);
    });

    it('removeHoliday passes the user and the param, resolving to nothing (204 body)', async () => {
      const removeHoliday = jest.fn().mockResolvedValue(null);
      const controller = controllerWith({ removeHoliday });

      await expect(controller.removeHoliday(user, HOLIDAY_ID)).resolves.toBeUndefined();
      expect(removeHoliday).toHaveBeenCalledWith(user, HOLIDAY_ID);
    });
  });

  describe('date-immutability guard (raw-body check)', () => {
    it('a `date` key in the patch body is 422 VALIDATION_ERROR before the service runs', () => {
      const updateHoliday = jest.fn();
      const controller = controllerWith({ updateHoliday });
      const req = { body: { date: '2030-01-01', name: 'Diwali' } };

      // The raw-body guard throws synchronously (before any promise exists).
      let err: unknown;
      try {
        controller.updateHoliday(user, HOLIDAY_ID, req, { name: 'Diwali' } as never);
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(422);
      expect((err as HttpException).getResponse()).toMatchObject({
        error_code: ErrorCode.VALIDATION_ERROR,
      });
      // The guard short-circuits — the update RPC never fires.
      expect(updateHoliday).not.toHaveBeenCalled();
    });

    it('a `date` key wins over a malformed id (checked first)', () => {
      const updateHoliday = jest.fn();
      const controller = controllerWith({ updateHoliday });

      expect(() =>
        controller.updateHoliday(user, 'not-a-uuid', { body: { date: '2030-01-01' } }, { name: 'X' } as never),
      ).toThrow(HttpException);
      expect(updateHoliday).not.toHaveBeenCalled();
    });

    it('a body without a date key delegates normally', async () => {
      const updateHoliday = jest.fn().mockResolvedValue(holiday);
      const controller = controllerWith({ updateHoliday });

      await controller.updateHoliday(user, HOLIDAY_ID, { body: { name: 'Diwali' } }, { name: 'Diwali' } as never);
      expect(updateHoliday).toHaveBeenCalledTimes(1);
    });
  });

  describe('malformed holiday id guard', () => {
    it('updateHoliday rejects a non-uuid :id with 400 before the service', () => {
      const updateHoliday = jest.fn();
      const controller = controllerWith({ updateHoliday });

      // The id guard throws synchronously (before any promise exists).
      expect(() =>
        controller.updateHoliday(user, 'not-a-uuid', { body: {} }, { name: 'X' } as never),
      ).toThrow(BadRequestException);
      expect(updateHoliday).not.toHaveBeenCalled();
    });

    it('removeHoliday rejects a non-uuid :id with 400 before the service', async () => {
      const removeHoliday = jest.fn();
      const controller = controllerWith({ removeHoliday });

      await expect(
        controller.removeHoliday(user, '12345'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(removeHoliday).not.toHaveBeenCalled();
    });
  });

  describe('route metadata', () => {
    it('is mounted at attendance/holidays', () => {
      expect(Reflect.getMetadata(PATH_METADATA, HolidaysController)).toBe(
        'attendance/holidays',
      );
    });

    it.each([
      // 0 = GET, 1 = POST, 3 = DELETE, 4 = PATCH
      ['listHolidays', '/', 0],
      ['getImpact', 'impact', 0],
      ['createHoliday', '/', 1],
      ['updateHoliday', ':id', 4],
      ['removeHoliday', ':id', 3],
    ])(
      '%s is wired as %s',
      (handler: keyof HolidaysController, path: string, method: number) => {
        const proto = HolidaysController.prototype[handler] as object;
        expect(Reflect.getMetadata(PATH_METADATA, proto)).toBe(path);
        expect(Reflect.getMetadata(METHOD_METADATA, proto)).toBe(method);
      },
    );

    it.each([
      'listHolidays',
      'getImpact',
      'createHoliday',
      'updateHoliday',
      'removeHoliday',
    ])(
      '%s is owner-only — holiday management never opens to a technician',
      (handler: keyof HolidaysController) => {
        const roles = Reflect.getMetadata(
          ROLES_KEY,
          HolidaysController.prototype[handler] as object,
        ) as Role[] | undefined;

        expect(roles).toEqual([Role.OWNER]);
      },
    );

    it.each([
      ['listHolidays', 200],
      ['getImpact', 200],
      ['createHoliday', 201],
      ['updateHoliday', 200],
      ['removeHoliday', 204],
    ])('%s carries a fixed @HttpCode(%i)', (handler: keyof HolidaysController, code: number) => {
      expect(
        Reflect.getMetadata(
          HTTP_CODE_METADATA,
          HolidaysController.prototype[handler] as object,
        ),
      ).toBe(code);
    });
  });
});
