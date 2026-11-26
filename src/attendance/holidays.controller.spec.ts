import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { HolidaysController } from './holidays.controller';
import { HolidaysService } from './holidays.service';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import { CAN_KEY } from '../common/decorators/can.decorator';
import { Permission } from '../common/permissions/permissions';

// Nest route metadata keys (mirror of @nestjs/common/constants values).
const PATH_METADATA = 'path';
const METHOD_METADATA = 'method';
const HTTP_CODE_METADATA = '__httpCode__';

const HOLIDAY_ID = '00000000-0000-4000-8000-0000000000e6';

const holiday = { id: HOLIDAY_ID, date: '2026-10-02', name: 'Gandhi Jayanti' };

describe('HolidaysController (story 15-5; console redesign 2026-11-26)', () => {
  const user: RequestUser = {
    userId: 'owner-uuid',
    tenantId: 'tenant-uuid',
    role: Role.COMPANY_ADMIN,
    platformAdmin: false,
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

    it('getOverview passes the user and the parsed year query', async () => {
      const getOverview = jest
        .fn()
        .mockResolvedValue({ year: '2026', holidays: [], offices: [] });
      const controller = controllerWith({ getOverview });
      const query = { year: '2026' };

      await expect(controller.getOverview(user, query)).resolves.toEqual({
        year: '2026',
        holidays: [],
        offices: [],
      });
      expect(getOverview).toHaveBeenCalledWith(user, query);
    });

    it('getImpact passes the user and the parsed query', async () => {
      const getImpact = jest
        .fn()
        .mockResolvedValue({ date: '2026-10-02', affectedEmployees: [] });
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

      await expect(controller.createHoliday(user, dto)).resolves.toEqual(
        holiday,
      );
      expect(createHoliday).toHaveBeenCalledWith(user, dto);
    });

    it('updateHoliday passes the user, the param and the parsed dto — the date key flows through (editable since 2026-11-26)', async () => {
      const updateHoliday = jest
        .fn()
        .mockResolvedValue({ ...holiday, date: '2030-01-01' });
      const controller = controllerWith({ updateHoliday });
      const dto = { name: 'Diwali', date: '2030-01-01' };

      await expect(
        controller.updateHoliday(user, HOLIDAY_ID, dto),
      ).resolves.toEqual({ ...holiday, date: '2030-01-01' });
      expect(updateHoliday).toHaveBeenCalledWith(user, HOLIDAY_ID, dto);
    });

    it('removeHoliday passes the user and the param, resolving to nothing (204 body)', async () => {
      const removeHoliday = jest.fn().mockResolvedValue(null);
      const controller = controllerWith({ removeHoliday });

      await expect(
        controller.removeHoliday(user, HOLIDAY_ID),
      ).resolves.toBeUndefined();
      expect(removeHoliday).toHaveBeenCalledWith(user, HOLIDAY_ID);
    });
  });

  describe('malformed holiday id guard', () => {
    it('updateHoliday rejects a non-uuid :id with 400 before the service', () => {
      const updateHoliday = jest.fn();
      const controller = controllerWith({ updateHoliday });

      // The id guard throws synchronously (before any promise exists).
      expect(() =>
        controller.updateHoliday(user, 'not-a-uuid', { name: 'X' }),
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
      ['getOverview', 'overview', 0],
      ['getImpact', 'impact', 0],
      ['createHoliday', '/', 1],
      ['updateHoliday', ':id', 4],
      ['removeHoliday', ':id', 3],
      ['downloadBulkTemplate', 'bulk-template', 0],
      ['bulkCreateHolidays', 'bulk', 1],
    ])(
      '%s is wired as %s',
      (handler: keyof HolidaysController, path: string, method: number) => {
        const proto = HolidaysController.prototype[handler] as object;
        expect(Reflect.getMetadata(PATH_METADATA, proto)).toBe(path);
        expect(Reflect.getMetadata(METHOD_METADATA, proto)).toBe(method);
      },
    );

    it.each([
      ['listHolidays', 'attendance.read'],
      ['getOverview', 'attendance.read'],
      ['getImpact', 'attendance.read'],
      ['createHoliday', 'attendance.manage'],
      ['updateHoliday', 'attendance.manage'],
      ['removeHoliday', 'attendance.manage'],
      ['downloadBulkTemplate', 'attendance.manage'],
      ['bulkCreateHolidays', 'attendance.manage'],
    ])(
      '%s needs an admin-side permission — holiday management never opens to an employee',
      (handler: keyof HolidaysController, permission: Permission) => {
        const needed = Reflect.getMetadata(
          CAN_KEY,
          HolidaysController.prototype[handler],
        ) as Permission[] | undefined;

        expect(needed).toEqual([permission]);
      },
    );

    it.each([
      ['listHolidays', 200],
      ['getOverview', 200],
      ['getImpact', 200],
      ['createHoliday', 201],
      ['updateHoliday', 200],
      ['removeHoliday', 204],
      ['downloadBulkTemplate', 200],
      ['bulkCreateHolidays', 200],
    ])(
      '%s carries a fixed @HttpCode(%i)',
      (handler: keyof HolidaysController, code: number) => {
        expect(
          Reflect.getMetadata(
            HTTP_CODE_METADATA,
            HolidaysController.prototype[handler] as object,
          ),
        ).toBe(code);
      },
    );
  });
});
